import CommonCrypto
import CryptoKit
import Foundation
import Security

/// Phi's optional access password, implemented exactly as the web client does
/// it (`web/auth.js`, `auth.go`): the password never leaves this process, the
/// server only sees PBKDF2-SHA256 verifier proofs and a session cookie.
///
/// A derived verifier is kept in the Keychain so later launches log in from the
/// verifier, the way the browser reuses its saved credential. The raw password
/// is only read when there is no usable verifier (first run, rotation).
public actor AccessAuth {
  public enum Failure: Error, Equatable {
    case badStatus
    case noPassword
    case wrongPassword
    case rateLimited
    case server(String)
  }

  public typealias PasswordProvider = @Sendable () async -> String?

  public struct Status: Decodable, Sendable {
    public let enabled: Bool
    public let version: String?
    public let algorithm: String?
    public let iterations: Int?
    public let salt: String?
    public let challenge: String?
  }

  private struct Saved: Codable {
    var salt: String
    var iterations: Int
    var verifier: String
    var token: String?
  }

  public static let cookieName = "phi_access_session"
  static let iterations = 600_000
  static let saltBytes = 16
  static let verifierBytes = 32

  private let origin: URL
  private let password: PasswordProvider?
  private let useKeychain: Bool
  private let keychainService: String
  private let session: URLSession
  private let account: String
  private var saved: Saved?
  private var loaded = false
  private var passwordDisabled = false

  public init(
    origin: URL, useKeychain: Bool = true, keychainService: String = "phi-access",
    password: PasswordProvider? = nil
  ) {
    self.origin = origin
    self.useKeychain = useKeychain
    self.keychainService = keychainService
    self.password = password
    account = "access-\(origin.absoluteString)"
    let configuration = URLSessionConfiguration.ephemeral
    configuration.timeoutIntervalForRequest = 15
    configuration.httpCookieStorage = nil
    configuration.urlCache = nil
    session = URLSession(configuration: configuration)
  }

  /// Session cookie value, or nil when the server has no access password.
  /// Throws instead of connecting anonymously: an unauthenticated attach would
  /// just surface as an unexplained 401 later.
  public func token(force: Bool = false) async throws -> String? {
    loadSaved()
    if passwordDisabled { return nil }
    if !force, let token = saved?.token, !token.isEmpty { return token }

    let status = try await fetchStatus()
    guard status.enabled else {
      passwordDisabled = true
      clearSaved()
      return nil
    }
    guard status.version == "v1", status.algorithm == "pbkdf2-sha256",
          let iterations = status.iterations, iterations > 0,
          let salt = status.salt, let challenge = status.challenge else {
      throw Failure.badStatus
    }

    var verifier = savedVerifier(matching: salt, iterations: iterations)
    var askedForPassword = false
    if verifier == nil {
      verifier = try await deriveVerifier(salt: salt, iterations: iterations)
      askedForPassword = true
    }
    do {
      return try await login(status: status, challenge: challenge, verifier: verifier!)
    } catch Failure.wrongPassword {
      // A stale verifier (password changed elsewhere) costs one password prompt.
      clearSaved()
      guard !askedForPassword else { throw Failure.wrongPassword }
      let fresh = try await deriveVerifier(salt: salt, iterations: iterations)
      return try await login(status: status, challenge: challenge, verifier: fresh)
    }
  }

  /// A rejected session, so the next attempt logs in again instead of retrying
  /// the same dead token forever.
  public func invalidate() {
    loadSaved()
    guard var current = saved else { return }
    current.token = nil
    saved = current
    persist(current)
  }

  // MARK: - Wire

  private func url(_ path: String) throws -> URL {
    var comps = URLComponents(url: origin, resolvingAgainstBaseURL: false)
    comps?.path = path
    guard let url = comps?.url else { throw Failure.badStatus }
    return url
  }

  private func fetchStatus() async throws -> Status {
    var request = URLRequest(url: try url("/api/auth/status"))
    request.cachePolicy = .reloadIgnoringLocalCacheData
    let (data, response) = try await session.data(for: request)
    guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
      let code = (response as? HTTPURLResponse)?.statusCode ?? 0
      throw Failure.server("auth status failed (\(code))")
    }
    do {
      return try JSONDecoder().decode(Status.self, from: data)
    } catch {
      throw Failure.badStatus
    }
  }

  private func login(status: Status, challenge: String, verifier: [UInt8]) async throws -> String {
    let proof = Self.base64URL(Data(HMAC<SHA256>.authenticationCode(
      for: Data(challenge.utf8), using: SymmetricKey(data: verifier))))
    var request = URLRequest(url: try url("/api/auth/login"))
    request.httpMethod = "POST"
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    request.httpBody = try JSONSerialization.data(
      withJSONObject: ["challenge": challenge, "proof": proof])
    let (_, response) = try await session.data(for: request)
    guard let http = response as? HTTPURLResponse else { throw Failure.badStatus }
    switch http.statusCode {
    case 200:
      guard let token = Self.sessionCookie(from: http) else {
        throw Failure.server("login returned no session cookie")
      }
      persist(Saved(
        salt: status.salt ?? "", iterations: status.iterations ?? 0,
        verifier: Self.base64URL(Data(verifier)), token: token))
      return token
    case 401:
      throw Failure.wrongPassword
    case 429:
      throw Failure.rateLimited
    default:
      throw Failure.server("login failed (\(http.statusCode))")
    }
  }

  private func deriveVerifier(salt: String, iterations: Int) async throws -> [UInt8] {
    guard let password else { throw Failure.noPassword }
    guard let secret = await password(), !secret.isEmpty else { throw Failure.noPassword }
    guard let saltBytes = Self.base64URLDecode(salt),
          let verifier = Self.pbkdf2SHA256(
            password: Array(secret.utf8), salt: Array(saltBytes), iterations: iterations) else {
      throw Failure.badStatus
    }
    return verifier
  }

  static func sessionCookie(from response: HTTPURLResponse) -> String? {
    let fields = response.allHeaderFields
    for (key, value) in fields {
      guard let name = key as? String, name.lowercased() == "set-cookie",
            let text = value as? String else { continue }
      for part in text.split(separator: ",") {
        let pair = part.split(separator: ";", maxSplits: 1)[0]
        let kv = pair.split(separator: "=", maxSplits: 1)
        guard kv.count == 2, kv[0].trimmingCharacters(in: .whitespaces) == cookieName else {
          continue
        }
        return String(kv[1]).trimmingCharacters(in: .whitespaces)
      }
    }
    return nil
  }

  // MARK: - Verifier cache

  private func loadSaved() {
    guard !loaded else { return }
    loaded = true
    guard useKeychain, let data = Keychain.read(service: keychainService, account: account) else { return }
    saved = try? JSONDecoder().decode(Saved.self, from: data)
  }

  private func savedVerifier(matching salt: String, iterations: Int) -> [UInt8]? {
    guard let saved, saved.salt == salt, saved.iterations == iterations,
          let verifier = Self.base64URLDecode(saved.verifier),
          verifier.count == Self.verifierBytes else { return nil }
    return Array(verifier)
  }

  private func persist(_ value: Saved) {
    saved = value
    guard useKeychain, let data = try? JSONEncoder().encode(value) else { return }
    Keychain.write(data, service: keychainService, account: account)
  }

  private func clearSaved() {
    saved = nil
    guard useKeychain else { return }
    Keychain.delete(service: keychainService, account: account)
  }

  // MARK: - Primitives

  /// PBKDF2-HMAC-SHA256 through CommonCrypto: RFC 8018, the same bytes the
  /// browser's WebCrypto path produces.
  static func pbkdf2SHA256(password: [UInt8], salt: [UInt8], iterations: Int) -> [UInt8]? {
    guard !password.isEmpty, iterations > 0, iterations <= Int(UInt32.max) else { return nil }
    var out = [UInt8](repeating: 0, count: verifierBytes)
    let status = password.withUnsafeBufferPointer { pw in
      salt.withUnsafeBufferPointer { s in
        CCKeyDerivationPBKDF(
          CCPBKDFAlgorithm(kCCPBKDF2),
          UnsafeRawPointer(pw.baseAddress!).assumingMemoryBound(to: Int8.self), pw.count,
          s.baseAddress!, s.count,
          CCPseudoRandomAlgorithm(kCCPRFHmacAlgSHA256), UInt32(iterations),
          &out, out.count)
      }
    }
    return status == kCCSuccess ? out : nil
  }

  /// `v1.pbkdf2-sha256.<iterations>.<salt>.<verifier>`: the only format the
  /// server accepts (`parseAccessPasswordHash`).
  static func passwordHash(verifier: [UInt8], salt: [UInt8], iterations: Int) -> String {
    "v1.pbkdf2-sha256.\(iterations).\(base64URL(Data(salt))).\(base64URL(Data(verifier)))"
  }

  static func base64URL(_ data: Data) -> String {
    data.base64EncodedString()
      .replacingOccurrences(of: "+", with: "-")
      .replacingOccurrences(of: "/", with: "_")
      .replacingOccurrences(of: "=", with: "")
  }

  static func base64URLDecode(_ value: String) -> Data? {
    guard value.rangeOfCharacter(from: CharacterSet(charactersIn: "-_0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ")) != nil else { return nil }
    var text = value.replacingOccurrences(of: "-", with: "+")
      .replacingOccurrences(of: "_", with: "/")
    while text.count % 4 != 0 { text += "=" }
    return Data(base64Encoded: text)
  }
}

/// Minimal generic-password Keychain store: one item per server origin.
enum Keychain {
  static let service = "phi-access"

  static func read(service: String = service, account: String) -> Data? {
    let query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecAttrAccount as String: account,
      kSecReturnData as String: true,
      kSecMatchLimit as String: kSecMatchLimitOne,
    ]
    var item: CFTypeRef?
    guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess else { return nil }
    return item as? Data
  }

  static func write(_ data: Data, service: String = service, account: String) {
    let query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecAttrAccount as String: account,
    ]
    let attributes: [String: Any] = [
      kSecValueData as String: data,
      kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlocked,
    ]
    if SecItemUpdate(query as CFDictionary, attributes as CFDictionary) == errSecSuccess { return }
    var insert = query
    insert.merge(attributes) { _, new in new }
    SecItemAdd(insert as CFDictionary, nil)
  }

  static func delete(service: String = service, account: String) {
    let query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecAttrAccount as String: account,
    ]
    SecItemDelete(query as CFDictionary)
  }
}
