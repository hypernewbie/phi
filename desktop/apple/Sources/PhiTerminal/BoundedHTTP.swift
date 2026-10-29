import Foundation

/// Reads a native HTTP byte stream without retaining an oversized response.
/// Callers also cancel on header rejection, before they call this function.
public func readBoundedHTTPBody(_ bytes: URLSession.AsyncBytes, maxBytes: Int) async throws -> Data {
  defer { bytes.task.cancel() }
  var body = Data()
  for try await byte in bytes {
    try Task.checkCancellation()
    guard body.count < maxBytes else {
      throw PaneWireError.protocolViolation("reply body exceeds its bound")
    }
    body.append(byte)
  }
  return body
}
