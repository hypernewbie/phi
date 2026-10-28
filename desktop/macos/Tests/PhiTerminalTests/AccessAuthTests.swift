import Foundation
import XCTest
@testable import PhiTerminal

/// The access-password primitives must produce exactly the bytes the Go server
/// accepts (`auth.go`), or every login fails in a way that looks like a typo.
final class AccessAuthTests: XCTestCase {
  /// PBKDF2-HMAC-SHA256 KATs (RFC 8018 parameters, cross-checked with openssl).
  func testPBKDF2SHA256MatchesKnownAnswers() throws {
    func hex(_ bytes: [UInt8]) -> String {
      bytes.map { String(format: "%02x", $0) }.joined()
    }
    let expected = [
      (1, "120fb6cffcf8b32c43e7225256c4f837a86548c92ccc35480805987cb70be17b"),
      (2, "ae4d0c95af6b46d32d0adff928f06dd02a303f8ef3c251dfd6e2d85a95474c43"),
      (4096, "c5e478d59288c841aa530db6845c4c8d962893a001ce4e11a4963873aa98134a"),
    ]
    for (iterations, want) in expected {
      let got = try XCTUnwrap(AccessAuth.pbkdf2SHA256(
        password: Array("password".utf8), salt: Array("salt".utf8), iterations: iterations))
      XCTAssertEqual(hex(got), want, "iterations \(iterations)")
    }
    XCTAssertNil(AccessAuth.pbkdf2SHA256(password: [], salt: [1], iterations: 1))
    XCTAssertNil(AccessAuth.pbkdf2SHA256(password: [1], salt: [1], iterations: 0))
  }

  func testBase64URLRoundTripsAndRejectsNonBase64() throws {
    let bytes = (0..<32).map { UInt8(truncatingIfNeeded: $0 * 37) }
    let text = AccessAuth.base64URL(Data(bytes))
    XCTAssertFalse(text.contains("+"))
    XCTAssertFalse(text.contains("/"))
    XCTAssertFalse(text.contains("="))
    XCTAssertEqual(try XCTUnwrap(AccessAuth.base64URLDecode(text)), Data(bytes))
    XCTAssertNil(AccessAuth.base64URLDecode("not base64!"))
  }

  func testPasswordHashIsTheOnlyFormatTheServerParses() throws {
    let salt = [UInt8](repeating: 7, count: 16)
    let verifier = try XCTUnwrap(AccessAuth.pbkdf2SHA256(
      password: Array("correct horse".utf8), salt: salt, iterations: AccessAuth.iterations))
    let hash = AccessAuth.passwordHash(verifier: verifier, salt: salt, iterations: AccessAuth.iterations)
    let parts = hash.split(separator: ".")
    XCTAssertEqual(parts.count, 5)
    XCTAssertEqual(parts[0], "v1")
    XCTAssertEqual(parts[1], "pbkdf2-sha256")
    XCTAssertEqual(parts[2], "600000")
    XCTAssertEqual(AccessAuth.base64URLDecode(String(parts[3])), Data(salt))
    XCTAssertEqual(AccessAuth.base64URLDecode(String(parts[4])), Data(verifier))
  }

  func testSessionCookieIsReadFromTheSetCookieHeader() throws {
    let response = try XCTUnwrap(HTTPURLResponse(
      url: URL(string: "http://127.0.0.1/auth")!, statusCode: 200, httpVersion: nil,
      headerFields: ["Set-Cookie": "phi_access_session=abc.123.sig; Path=/; HttpOnly"]))
    XCTAssertEqual(AccessAuth.sessionCookie(from: response), "abc.123.sig")

    let other = try XCTUnwrap(HTTPURLResponse(
      url: URL(string: "http://127.0.0.1/auth")!, statusCode: 200, httpVersion: nil,
      headerFields: ["Set-Cookie": "other=1; Path=/"]))
    XCTAssertNil(AccessAuth.sessionCookie(from: other))
  }
}
