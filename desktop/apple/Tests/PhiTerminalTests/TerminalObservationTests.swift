import Foundation
import PhiWire
import XCTest
@testable import PhiTerminal

final class TerminalObservationTests: XCTestCase {
  func testDefaultReadyPathIsUnchanged() async throws {
    let recorder = ObservationRecorder()
    let client = try makeClient(checkpointKind: PaneWireClient.readyKind)
    addTeardownBlock { await client.close() }
    _ = try await client.applyAttach(attach(kind: PaneWireClient.readyKind, through: 5, data: Data()))

    let status = await client.status()
    XCTAssertEqual(status.frontier, 5)
    XCTAssertEqual(status.attach?.checkpoint?.kind, PaneWireClient.readyKind)
    let events = await recorder.events()
    XCTAssertTrue(events.isEmpty)
  }

  func testCheckpointDeltaAndResizeAreOrdered() async throws {
    let recorder = ObservationRecorder()
    let client = try makeClient(observer: { event in try await recorder.accept(event) })
    addTeardownBlock { await client.close() }
    let connection = UUID()
    _ = try await client.applyAttach(
      attach(through: 10, data: Data("base".utf8)), connection: connection)
    let page = RecordingPage(
      epoch: 7, start: 10, end: 13,
      resizes: [RecordingPage.Resize(at: 12, cols: 40, rows: 10)],
      data: Data("abc".utf8))
    try await client.applyRecordedPage(page, source: .boundary, connection: connection)

    let events = await recorder.events()
    XCTAssertEqual(events.count, 4)
    XCTAssertEqual(events[0], .reset(
      connection: connection, epoch: 7, frontier: 10, cols: 80, rows: 24,
      bytes: Data("base".utf8)))
    XCTAssertEqual(events[1], .bytes(
      connection: connection, epoch: 7, start: 10, end: 12, data: Data("ab".utf8)))
    XCTAssertEqual(events[2], .resize(
      connection: connection, epoch: 7, position: 12, cols: 40, rows: 10))
    XCTAssertEqual(events[3], .bytes(
      connection: connection, epoch: 7, start: 12, end: 13, data: Data("c".utf8)))
    let status = await client.status()
    XCTAssertEqual(status.frontier, 13)
    let maybeFrame = await client.readFrame()
    let frame = try XCTUnwrap(maybeFrame)
    XCTAssertEqual(frame.cols, 40)
    XCTAssertEqual(frame.rows, 10)
  }

  func testOverlapIsNotEmittedTwice() async throws {
    let recorder = ObservationRecorder()
    let client = try makeClient(observer: { event in try await recorder.accept(event) })
    addTeardownBlock { await client.close() }
    let connection = UUID()
    _ = try await client.applyAttach(attach(through: 0, data: Data()), connection: connection)

    var first = Phi_Websocket_Terminal_V1_TerminalOutput()
    first.start = 0
    first.data = Data("abc".utf8)
    try await client.applyOutput(first, connection: connection)
    var overlap = Phi_Websocket_Terminal_V1_TerminalOutput()
    overlap.start = 1
    overlap.data = Data("bcDE".utf8)
    try await client.applyOutput(overlap, connection: connection)

    let byteEvents = await recorder.events().compactMap { event -> (UInt64, UInt64, Data)? in
      guard case .bytes(_, _, let start, let end, let data) = event else { return nil }
      return (start, end, data)
    }
    XCTAssertEqual(byteEvents.count, 2)
    XCTAssertEqual(byteEvents[0].0, 0)
    XCTAssertEqual(byteEvents[0].1, 3)
    XCTAssertEqual(byteEvents[0].2, Data("abc".utf8))
    XCTAssertEqual(byteEvents[1].0, 3)
    XCTAssertEqual(byteEvents[1].1, 5)
    XCTAssertEqual(byteEvents[1].2, Data("DE".utf8))
    let status = await client.status()
    XCTAssertEqual(status.frontier, 5)
  }

  func testObserverFailureDoesNotCommitResetOrOutput() async throws {
    let resetRecorder = ObservationRecorder()
    await resetRecorder.failNext()
    let resetClient = try makeClient(observer: { event in try await resetRecorder.accept(event) })
    let beforeFrame = await resetClient.readFrame()
    let before = try XCTUnwrap(beforeFrame)
    do {
      _ = try await resetClient.applyAttach(attach(through: 10, data: Data("base".utf8)))
      XCTFail("a failed reset observer was accepted")
    } catch PaneWireError.observerFailure {
      // The staged terminal must not replace the previous terminal.
    }
    let resetStatus = await resetClient.status()
    XCTAssertEqual(resetStatus.frontier, 0)
    XCTAssertNil(resetStatus.attach)
    let afterResetFrame = await resetClient.readFrame()
    XCTAssertEqual(try XCTUnwrap(afterResetFrame), before)
    await resetClient.close()

    let outputRecorder = ObservationRecorder()
    let outputClient = try makeClient(observer: { event in try await outputRecorder.accept(event) })
    addTeardownBlock { await outputClient.close() }
    let connection = UUID()
    _ = try await outputClient.applyAttach(
      attach(through: 10, data: Data("before".utf8)), connection: connection)
    await outputRecorder.failNext()
    var output = Phi_Websocket_Terminal_V1_TerminalOutput()
    output.start = 10
    output.data = Data("after".utf8)
    do {
      try await outputClient.applyOutput(output, connection: connection)
      XCTFail("a failed output observer was accepted")
    } catch PaneWireError.observerFailure {
      // The observer's last successful display remains the checkpoint.
    }
    let outputStatus = await outputClient.status()
    XCTAssertEqual(outputStatus.frontier, 10)
    let visibleBytes = await outputRecorder.display()
    XCTAssertEqual(visibleBytes, Data("before".utf8))
    let outputEvents = await outputRecorder.events()
    XCTAssertEqual(outputEvents.count, 1)
  }

  func testCloseDuringObserverAwaitDiscardsLateWork() async throws {
    let gate = ObserverGate()
    let client = try makeClient(observer: { _ in await gate.hold() })
    let connection = UUID()
    let wire = attach(through: 10, data: Data("late".utf8))
    let applying = Task {
      try await client.applyAttach(wire, connection: connection)
    }
    try await waitForGate(gate, entered: true)
    await client.close()
    await gate.release()
    do {
      _ = try await applying.value
      XCTFail("close did not invalidate the held reset")
    } catch PaneWireError.staleConnection {
      // The staged terminal is discarded and its frontier never commits.
    }
    let status = await client.status()
    XCTAssertEqual(status.frontier, 0)
    XCTAssertNil(status.attach)
  }

  private func makeClient(
    checkpointKind: String = PaneWireClient.ansiKind,
    observer: TerminalObserver? = nil
  ) throws -> PaneWireClient {
    try PaneWireClient(
      origin: URL(string: "http://127.0.0.1:1")!, paneID: "observer-pane",
      useKeychain: false, checkpointKind: checkpointKind, observer: observer)
  }

  private func attach(
    kind: String = PaneWireClient.ansiKind, through: UInt64, data: Data,
    cols: UInt32 = 80, rows: UInt32 = 24
  ) -> Phi_Websocket_Terminal_V1_TerminalAttach {
    var wire = Phi_Websocket_Terminal_V1_TerminalAttach()
    wire.epoch = 7
    wire.oldest = 0
    wire.head = through
    var checkpoint = Phi_Websocket_Terminal_V1_TerminalCheckpoint()
    checkpoint.kind = kind
    checkpoint.through = through
    checkpoint.cols = cols
    checkpoint.rows = rows
    checkpoint.data = data
    wire.checkpoint = checkpoint
    return wire
  }
}

private enum ObserverTestError: Error {
  case rejected
}

private actor ObservationRecorder {
  private var recorded: [TerminalObservation] = []
  private var visibleBytes = Data()
  private var shouldFailNext = false

  func accept(_ event: TerminalObservation) throws {
    if shouldFailNext {
      shouldFailNext = false
      throw ObserverTestError.rejected
    }
    recorded.append(event)
    switch event {
    case .reset(_, _, _, _, _, let bytes): visibleBytes = bytes
    case .bytes(_, _, _, _, let bytes): visibleBytes.append(bytes)
    case .resize: break
    }
  }

  func failNext() { shouldFailNext = true }
  func events() -> [TerminalObservation] { recorded }
  func display() -> Data { visibleBytes }
}

private actor ObserverGate {
  private var entered = false
  private var released = false
  private var continuation: CheckedContinuation<Void, Never>?

  func hold() async {
    entered = true
    guard !released else { return }
    await withCheckedContinuation { continuation = $0 }
  }

  func release() {
    released = true
    continuation?.resume()
    continuation = nil
  }

  func hasEntered() -> Bool { entered }
}

private func waitForGate(
  _ gate: ObserverGate, entered: Bool, timeout: Duration = .seconds(5)
) async throws {
  let deadline = ContinuousClock.now + timeout
  while ContinuousClock.now < deadline {
    if await gate.hasEntered() == entered { return }
    try await Task.sleep(for: .milliseconds(10))
  }
  throw NSError(
    domain: "TerminalObservationTests", code: 1,
    userInfo: [NSLocalizedDescriptionKey: "observer gate did not reach its expected state"])
}
