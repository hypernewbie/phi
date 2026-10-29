import Foundation
import XCTest
@testable import PhiTerminal

/// M0 durability gate: local acceptance, attempt-before-send and restart
/// behaviour of the input journal (§7.4).
final class ActionJournalTests: XCTestCase {
  private var directory: URL!

  override func setUpWithError() throws {
    directory = URL(fileURLWithPath: NSTemporaryDirectory())
      .appendingPathComponent("phi-journal-\(UUID().uuidString)")
    addTeardownBlock { [directory] in
      guard let directory else { return }
      try? FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: directory.path)
      try? FileManager.default.removeItem(at: directory)
    }
  }

  func testRestartRecoversPendingWorkAndNeverResendsAttemptedWork() async throws {
    let pending: ActionJournal.Action
    do {
      let first = try await ActionJournal.open(directory: directory, pane: "pane-a")
      pending = try await first.reserve("echo ke")
      let attempted = try await first.reserve("echo pt\r")
      try await first.markAttempted(attempted.id)

      let data = try Data(contentsOf: await first.fileURL)
      let root = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
      XCTAssertEqual(root["pane"] as? String, "pane-a")
      XCTAssertEqual((root["actions"] as? [Any])?.count, 2)
    }

    do {
      let restarted = try await ActionJournal.open(directory: directory, pane: "pane-a")
      let recoveredPending = await restarted.pending()
      XCTAssertEqual(recoveredPending.map(\.text), ["echo ke"])
      XCTAssertEqual(recoveredPending.map(\.id), [pending.id])
      let recoveredAttempted = await restarted.attempted()
      XCTAssertEqual(recoveredAttempted.map(\.text), ["echo pt\r"])

      try await restarted.markAttempted(pending.id)
      let afterRetry = await restarted.pending()
      XCTAssertTrue(afterRetry.isEmpty)
    }

    let third = try await ActionJournal.open(directory: directory, pane: "pane-a")
    let thirdPending = await third.pending()
    XCTAssertTrue(thirdPending.isEmpty, "attempted work came back as resendable")
    let thirdAttempted = await third.attempted()
    XCTAssertEqual(thirdAttempted.map(\.text), ["echo ke", "echo pt\r"])
  }

  func testActionBeyondTheChunkLimitIsReservedAndQuarantinedWhole() async throws {
    let journal = try await ActionJournal.open(directory: directory, pane: "pane-a")
    let limit = PaneWireClient.maxInputChunk
    let text = String(repeating: "a", count: limit) + "01234567"
    XCTAssertGreaterThan(text.utf8.count, limit)

    let action = try await journal.reserve(text)
    let stored = await journal.pending()
    XCTAssertEqual(stored.count, 1, "the journal split one action at the wire chunk boundary")
    XCTAssertEqual(stored.first?.text.utf8.count, limit + 8)

    // Attempting any chunk quarantines the entire action: no resendable suffix.
    try await journal.markAttempted(action.id)
    let afterQuarantine = await journal.pending()
    XCTAssertTrue(afterQuarantine.isEmpty)
    let quarantined = await journal.attempted()
    XCTAssertEqual(quarantined.first?.text.utf8.count, limit + 8)
  }

  func testFailedWriteKeepsTheDraftAndThePreviousDocument() async throws {
    guard getuid() != 0 else {
      XCTFail("write-failure test needs a normal user: root ignores directory permissions")
      return
    }
    do {
      let journal = try await ActionJournal.open(directory: directory, pane: "pane-a")
      _ = try await journal.reserve("kept")
      try FileManager.default.setAttributes([.posixPermissions: 0o500], ofItemAtPath: directory.path)
      defer { try? FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: directory.path) }

      let draft = "unsaved"
      do {
        _ = try await journal.reserve(draft)
        XCTFail("a read-only state directory accepted a reservation")
      } catch {
        XCTAssertEqual(
          (error as? CocoaError)?.code, .fileWriteNoPermission,
          "reservation failed for another reason: \(error)")
        XCTAssertEqual(draft, "unsaved", "a failed write must not consume the draft")
      }
    }
    try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: directory.path)
    let reopened = try await ActionJournal.open(directory: directory, pane: "pane-a")
    let kept = await reopened.pending()
    XCTAssertEqual(kept.map(\.text), ["kept"])
  }

  func testSecondAttemptIsRefusedAndDefiniteNonSendBecomesResendable() async throws {
    let journal = try await ActionJournal.open(directory: directory, pane: "p1")
    let action = try await journal.reserve("x")
    try await journal.markAttempted(action.id)

    do {
      try await journal.markAttempted(action.id)
      XCTFail("a second attempt must be refused")
    } catch ActionJournal.JournalError.alreadyAttempted {
      // Expected: a duplicate queue entry can never send twice.
    }

    let attempted = await journal.attempted().map(\.id)
    XCTAssertEqual(attempted, [action.id])
    let pendingAfterAttempt = await journal.pending().map(\.id)
    XCTAssertEqual(pendingAfterAttempt, [], "attempted work is never resendable")

    try await journal.revertToNeverSent(action.id)
    let pendingAfterRevert = await journal.pending().map(\.id)
    XCTAssertEqual(pendingAfterRevert, [action.id], "definite non-send returns to pending")
  }

  func testLegacyTextActionStillLoads() async throws {
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    let file = directory.appendingPathComponent("actions-legacy-pane.json")
    let legacy = #"{"pane":"legacy-pane","actions":[{"id":"legacy-id","text":"echo old","delivery":"sentUnconfirmed"}]}"#
    try Data(legacy.utf8).write(to: file)

    let journal = try await ActionJournal.open(directory: directory, pane: "legacy-pane")
    let actions = await journal.snapshotOfActions().actions
    let action = try XCTUnwrap(actions.first)
    XCTAssertEqual(action.id, "legacy-id")
    XCTAssertEqual(action.text, "echo old")
    XCTAssertNil(action.rawBytes)
    XCTAssertEqual(action.delivery, .sentUnconfirmed)
  }

  func testSecondOwnerCannotOverwriteReceipts() async throws {
    let first = try await ActionJournal.open(directory: directory, pane: "pane-a")
    do {
      let second = try await ActionJournal.open(directory: directory, pane: "pane-a")
      let action = try await first.reserve("must remain quarantined")
      try await first.markAttempted(action.id)
      _ = try await second.reserve("stale writer")
      let stored = try JSONDecoder().decode(
        ActionJournal.Snapshot.self, from: Data(contentsOf: await first.fileURL))
      XCTAssertTrue(stored.actions.contains { $0.id == action.id && $0.delivery == .sentUnconfirmed })
      XCTFail("a second journal writer acquired the same pane")
    } catch {
      XCTAssertEqual(String(describing: error), "alreadyOwned")
    }
  }

  func testPayloadPermissionsRemainPrivateAcrossAtomicRewrite() async throws {
    let journal = try await ActionJournal.open(directory: directory, pane: "pane-a")
    let action = try await journal.reserve("synthetic input")
    let path = await journal.fileURL.path
    func permissions() throws -> Int {
      let attributes = try FileManager.default.attributesOfItem(atPath: path)
      return try XCTUnwrap(attributes[.posixPermissions] as? NSNumber).intValue & 0o777
    }
    XCTAssertEqual(try permissions(), 0o600)
    try FileManager.default.setAttributes([.posixPermissions: 0o644], ofItemAtPath: path)
    try await journal.markAttempted(action.id)
    XCTAssertEqual(try permissions(), 0o600)
  }

  func testFailedInitializationReleasesTheWriterLease() async throws {
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    let file = directory.appendingPathComponent("actions-pane-a.json")
    try Data("invalid fixture".utf8).write(to: file)
    do {
      _ = try await ActionJournal.open(directory: directory, pane: "pane-a")
      XCTFail("invalid journal was accepted")
    } catch is DecodingError {}
    try Data(#"{"pane":"pane-a","actions":[]}"#.utf8).write(to: file)
    let reopened = try await ActionJournal.open(directory: directory, pane: "pane-a")
    let pending = await reopened.pending()
    XCTAssertTrue(pending.isEmpty)
  }

  func testExistingDirectoryModeIsNotChanged() async throws {
    try FileManager.default.createDirectory(
      at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o755])
    let journal = try await ActionJournal.open(directory: directory, pane: "pane-a")
    _ = try await journal.reserve("synthetic input")
    let attributes = try FileManager.default.attributesOfItem(atPath: directory.path)
    XCTAssertEqual((attributes[.posixPermissions] as? NSNumber)?.intValue, 0o755)
    let fileAttributes = try FileManager.default.attributesOfItem(atPath: await journal.fileURL.path)
    XCTAssertEqual((fileAttributes[.posixPermissions] as? NSNumber)?.intValue, 0o600)
  }

  func testActionsAreScopedToOnePane() async throws {
    let journal = try await ActionJournal.open(directory: directory, pane: "pane-a")
    _ = try await journal.reserve("a")
    let other = try await ActionJournal.open(directory: directory, pane: "pane-b")
    let otherPending = await other.pending()
    XCTAssertTrue(otherPending.isEmpty, "a journal reused another pane's actions")
  }
}
