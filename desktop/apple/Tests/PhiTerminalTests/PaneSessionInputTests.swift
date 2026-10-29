import Darwin
import Foundation
@testable import PhiKit
import PhiTerminal
import XCTest

final class PaneSessionInputTests: XCTestCase {
  @MainActor
  func testOfflineABIsReservedOnceInOrder() async throws {
    let endpoint = try OwnedUnavailableEndpoint()
    let directory = FileManager.default.temporaryDirectory
      .appendingPathComponent("phi-input-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    defer {
      try? FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: directory.path)
      try? FileManager.default.removeItem(at: directory)
    }

    let session = try PaneSession(
      origin: endpoint.origin, paneID: "offline-pane", stateDir: directory, useKeychain: false)
    defer { session.stop() }
    session.start()
    session.send(bytes: Array("a".utf8))

    let actionsURL = directory.appendingPathComponent("actions-offline-pane.json")
    let first = try await waitForActions(at: actionsURL) { $0.count == 1 }
    XCTAssertEqual(first.map(\.text), ["a"])

    session.send(bytes: Array("b".utf8))
    let final = try await waitForActions(at: actionsURL) { $0.count >= 2 }
    XCTAssertEqual(final.map(\.text), ["a", "b"])
    XCTAssertEqual(Set(final.map(\.id)).count, 2)
  }

  @MainActor
  func testStorageRecoveryClearsWarningAndShowsSavedQueuedInput() async throws {
    let endpoint = try OwnedUnavailableEndpoint()
    let directory = try makeStateDirectory()
    let session = try PaneSession(
      origin: endpoint.origin, paneID: "storage-status", stateDir: directory, useKeychain: false)
    defer {
      session.stop()
      try? FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: directory.path)
      try? FileManager.default.removeItem(at: directory)
    }
    session.start()
    session.send(bytes: [65])
    let file = directory.appendingPathComponent("actions-storage-status.json")
    _ = try await waitForActions(at: file) { $0.count == 1 }
    try FileManager.default.setAttributes([.posixPermissions: 0o500], ofItemAtPath: directory.path)
    session.send(bytes: [66])
    try await waitForStatus(session) { $0.contains("draft not saved") }
    try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: directory.path)
    _ = try await waitForActions(at: file) { $0.count == 2 }
    try await waitForStatus(session) { $0.contains("queued 2") && !$0.contains("journal:") }
    XCTAssertFalse(session.snapshot.statusLine.contains("draft kept"))
  }

  @MainActor
  func testRawBytesSurviveJournalRestart() async throws {
    let directory = try makeStateDirectory()
    defer { try? FileManager.default.removeItem(at: directory) }
    let bytes: [UInt8] = [0x00, 0x1b, 0x5b, 0x41, 0xff]
    let reserved: ActionJournal.Action
    do {
      let first = try await ActionJournal.open(directory: directory, pane: "raw-pane")
      reserved = try await first.reserve(String(decoding: bytes, as: UTF8.self), rawBytes: Data(bytes))
    }

    let restarted = try await ActionJournal.open(directory: directory, pane: "raw-pane")
    let pending = await restarted.pending()
    XCTAssertEqual(pending.map(\.id), [reserved.id])
    XCTAssertEqual(pending.first?.rawBytes, Data(bytes))
  }

  @MainActor
  func testRawInputBeforeJournalOpenIsPreserved() async throws {
    let endpoint = try OwnedUnavailableEndpoint()
    let directory = try makeStateDirectory()
    defer {
      try? FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: directory.path)
      try? FileManager.default.removeItem(at: directory)
    }
    let gate = JournalOpeningGate()
    let session = try PaneSession(
      origin: endpoint.origin, paneID: "raw-before-open", stateDir: directory, useKeychain: false)
    session.journalOpener = { directory, pane in
      await gate.hold()
      let opened = try await ActionJournal.open(directory: directory, pane: pane)
      await gate.didOpen()
      return opened
    }
    defer { session.stop() }
    session.start()
    try await waitForGate(gate, entered: true)
    let bytes: [UInt8] = [0x00, 0x1b, 0x5b, 0x41, 0xff]
    session.send(bytes: bytes)
    await gate.release()

    let actionsURL = directory.appendingPathComponent("actions-raw-before-open.json")
    let actions = try await waitForActions(at: actionsURL) { $0.count == 1 }
    XCTAssertEqual(actions.first?.rawBytes, Data(bytes))
    try await waitForGate(gate, entered: false)
  }

  @MainActor
  func testCloseDuringJournalOpenStopsLateWork() async throws {
    let endpoint = try OwnedUnavailableEndpoint()
    let directory = try makeStateDirectory()
    defer {
      try? FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: directory.path)
      try? FileManager.default.removeItem(at: directory)
    }
    let gate = JournalOpeningGate()
    let inputCalls = InputCallCounter()
    let session = try PaneSession(
      origin: endpoint.origin, paneID: "close-during-open", stateDir: directory, useKeychain: false)
    session.journalOpener = { directory, pane in
      await gate.hold()
      let opened = try await ActionJournal.open(directory: directory, pane: pane)
      await gate.didOpen()
      return opened
    }
    session.inputDeliveryOverride = { _ in
      inputCalls.increment()
      return .sentUnconfirmed
    }
    var closed = false
    var lateUpdates = 0
    session.onUpdate = { _ in if closed { lateUpdates += 1 } }
    session.start()
    try await waitForGate(gate, entered: true)
    session.send(bytes: [0x00, 0x1b, 0x5b, 0x41, 0xff])
    session.stop()
    closed = true
    await gate.release()
    try await waitForGate(gate, entered: false)
    try await Task.sleep(for: .milliseconds(200))

    XCTAssertEqual(inputCalls.value, 0)
    XCTAssertEqual(lateUpdates, 0)
    XCTAssertFalse(FileManager.default.fileExists(
      atPath: directory.appendingPathComponent("actions-close-during-open.json").path))
  }

  @MainActor
  private func makeStateDirectory() throws -> URL {
    let directory = FileManager.default.temporaryDirectory
      .appendingPathComponent("phi-input-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: directory.path)
    return directory
  }

  @MainActor
  private func waitForGate(
    _ gate: JournalOpeningGate, entered: Bool, timeout: Duration = .seconds(5)
  ) async throws {
    let deadline = ContinuousClock.now + timeout
    while ContinuousClock.now < deadline {
      let reached = entered ? await gate.hasEntered() : await gate.hasOpened()
      if reached { return }
      try await Task.sleep(for: .milliseconds(10))
    }
    throw NSError(
      domain: "PaneSessionInputTests", code: 2,
      userInfo: [NSLocalizedDescriptionKey: "journal opener gate did not reach its expected state"])
  }

  @MainActor
  private func waitForStatus(_ session: PaneSession, _ predicate: (String) -> Bool) async throws {
    let deadline = ContinuousClock.now + .seconds(5)
    while ContinuousClock.now < deadline {
      if predicate(session.snapshot.statusLine) { return }
      try await Task.sleep(for: .milliseconds(25))
    }
    XCTFail("status did not recover: \(session.snapshot.statusLine)")
  }

  @MainActor
  private func waitForActions(
    at url: URL, timeout: Duration = .seconds(10),
    where predicate: ([ActionJournal.Action]) -> Bool
  ) async throws -> [ActionJournal.Action] {
    let deadline = ContinuousClock.now + timeout
    while ContinuousClock.now < deadline {
      if let data = try? Data(contentsOf: url),
         let snapshot = try? JSONDecoder().decode(ActionJournal.Snapshot.self, from: data),
         predicate(snapshot.actions) {
        return snapshot.actions
      }
      try await Task.sleep(for: .milliseconds(25))
    }
    throw NSError(
      domain: "PaneSessionInputTests", code: 1,
      userInfo: [NSLocalizedDescriptionKey: "journal did not reach the expected action count"])
  }
}

private actor JournalOpeningGate {
  private var entered = false
  private var released = false
  private var opened = false
  private var releaseContinuation: CheckedContinuation<Void, Never>?

  func hold() async {
    entered = true
    guard !released else { return }
    await withCheckedContinuation { releaseContinuation = $0 }
  }

  func release() {
    released = true
    releaseContinuation?.resume()
    releaseContinuation = nil
  }

  func didOpen() { opened = true }
  func hasEntered() -> Bool { entered }
  func hasOpened() -> Bool { opened }
}

private final class InputCallCounter: @unchecked Sendable {
  private let lock = NSLock()
  private var count = 0

  func increment() {
    lock.lock()
    count += 1
    lock.unlock()
  }

  var value: Int {
    lock.lock()
    defer { lock.unlock() }
    return count
  }
}

private final class OwnedUnavailableEndpoint {
  let origin: URL
  private let descriptor: Int32

  init() throws {
    let fd = Darwin.socket(AF_INET, SOCK_STREAM, 0)
    guard fd >= 0 else { throw POSIXError(.init(rawValue: errno) ?? .EIO) }

    var address = sockaddr_in()
    address.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
    address.sin_family = sa_family_t(AF_INET)
    address.sin_port = 0
    address.sin_addr = in_addr(s_addr: in_addr_t(INADDR_LOOPBACK).bigEndian)
    let bound = withUnsafePointer(to: &address) { pointer in
      pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) {
        Darwin.bind(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size))
      }
    }
    guard bound == 0 else {
      Darwin.close(fd)
      throw POSIXError(.init(rawValue: errno) ?? .EIO)
    }

    var local = sockaddr_in()
    var length = socklen_t(MemoryLayout<sockaddr_in>.size)
    let named = withUnsafeMutablePointer(to: &local) { pointer in
      pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) {
        getsockname(fd, $0, &length)
      }
    }
    guard named == 0 else {
      Darwin.close(fd)
      throw POSIXError(.init(rawValue: errno) ?? .EIO)
    }
    descriptor = fd
    origin = URL(string: "http://127.0.0.1:\(UInt16(bigEndian: local.sin_port))")!
  }

  deinit { Darwin.close(descriptor) }
}
