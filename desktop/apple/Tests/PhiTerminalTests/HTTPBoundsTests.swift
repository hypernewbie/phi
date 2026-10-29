import Foundation
import XCTest
@testable import PhiTerminal

final class HTTPBoundsTests: XCTestCase {
  func testExactLimitAndEmptyBodiesAreAccepted() async throws {
    for size in [0, 64] {
      let body = Data(repeating: 65, count: size)
      let fixture = FixtureHTTP(body: body)
      defer { fixture.close() }
      let (bytes, _) = try await fixture.session.bytes(from: fixture.origin)
      let received = try await readBoundedHTTPBody(bytes, maxBytes: size)
      XCTAssertEqual(received, body)
    }
  }

  func testOneByteBeyondLimitIsRejected() async throws {
    let fixture = FixtureHTTP(body: Data(repeating: 65, count: 65))
    defer { fixture.close() }
    let (bytes, _) = try await fixture.session.bytes(from: fixture.origin)
    do {
      _ = try await readBoundedHTTPBody(bytes, maxBytes: 64)
      XCTFail("body exceeded the declared limit")
    } catch PaneWireError.protocolViolation {}
  }

  func testAuthRejectsOversizedChunkedBodyBeforeDownloadFinishes() async throws {
    let fixture = FixtureHTTP(body: Data(repeating: 120, count: 32 << 10), chunks: 32)
    defer { fixture.close() }
    let auth = AccessAuth(origin: fixture.origin, session: fixture.session)
    do {
      _ = try await auth.token()
      XCTFail("oversized auth body was accepted")
    } catch PaneWireError.protocolViolation {
      // The byte bound, not JSON decoding, rejects the response.
    } catch {
      XCTFail("wrong oversized-response failure: \(error)")
    }
    let deadline = ContinuousClock.now + .seconds(2)
    while fixture.stops == 0, ContinuousClock.now < deadline {
      try await Task.sleep(for: .milliseconds(10))
    }
    XCTAssertGreaterThan(fixture.stops, 0)
    XCTAssertLessThan(fixture.delivered, fixture.chunks)
  }
}

/// A per-session URLProtocol fixture: no global registration or real requests.
final class FixtureHTTP: @unchecked Sendable {
  static let registry = FixtureRegistry()
  let origin = URL(string: "http://\(UUID().uuidString.lowercased()).invalid")!
  let session: URLSession
  let chunks: Int
  private let body: Data?
  private let lock = NSLock()
  private var passwordEnabled = false
  private var requestCount = 0
  private var chunkCount = 0
  private var stopCount = 0

  init(body: Data? = nil, chunks: Int = 1) {
    self.body = body
    self.chunks = chunks
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [FixtureHTTPProtocol.self]
    configuration.timeoutIntervalForRequest = 3
    session = URLSession(configuration: configuration)
    Self.registry.insert(self)
  }

  var enabled: Bool {
    get { lock.withLock { passwordEnabled } }
    set { lock.withLock { passwordEnabled = newValue } }
  }
  var requests: Int { lock.withLock { requestCount } }
  var delivered: Int { lock.withLock { chunkCount } }
  var stops: Int { lock.withLock { stopCount } }
  func sentChunk() { lock.withLock { chunkCount += 1 } }
  func stopped() { lock.withLock { stopCount += 1 } }

  func responseBody() -> Data {
    lock.withLock {
      requestCount += 1
      if let body { return body }
      let status = passwordEnabled
        ? #"{"enabled":true,"version":"v1","algorithm":"pbkdf2-sha256","iterations":600000,"salt":"AAAAAAAAAAAAAAAAAAAAAA","challenge":"fixture"}"#
        : #"{"enabled":false}"#
      return Data(status.utf8)
    }
  }

  func close() {
    session.invalidateAndCancel()
    Self.registry.remove(origin)
  }
}

final class FixtureRegistry: @unchecked Sendable {
  private let lock = NSLock()
  private var values: [String: FixtureHTTP] = [:]
  func insert(_ fixture: FixtureHTTP) {
    lock.withLock { values[fixture.origin.host!] = fixture }
  }
  func remove(_ origin: URL) { _ = lock.withLock { values.removeValue(forKey: origin.host!) } }
  func fixture(_ url: URL?) -> FixtureHTTP? { lock.withLock { values[url?.host ?? ""] } }
}

private final class FixtureHTTPProtocol: URLProtocol, @unchecked Sendable {
  private let lock = NSLock()
  private var cancelled = false

  override class func canInit(with request: URLRequest) -> Bool {
    FixtureHTTP.registry.fixture(request.url) != nil
  }
  override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

  override func startLoading() {
    guard let fixture = FixtureHTTP.registry.fixture(request.url), let url = request.url else {
      client?.urlProtocol(self, didFailWithError: URLError(.badURL))
      return
    }
    let body = fixture.responseBody()
    let response = HTTPURLResponse(
      url: url, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: ["Transfer-Encoding": "chunked"])!
    client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
    DispatchQueue.global().async { [self] in
      for _ in 0..<fixture.chunks {
        guard !lock.withLock({ cancelled }) else { return }
        client?.urlProtocol(self, didLoad: body)
        fixture.sentChunk()
        if fixture.chunks > 1 { Thread.sleep(forTimeInterval: 0.005) }
      }
      guard !lock.withLock({ cancelled }) else { return }
      client?.urlProtocolDidFinishLoading(self)
    }
  }

  override func stopLoading() {
    lock.withLock { cancelled = true }
    FixtureHTTP.registry.fixture(request.url)?.stopped()
  }
}
