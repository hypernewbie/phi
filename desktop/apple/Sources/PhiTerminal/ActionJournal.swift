import Darwin
import Foundation

/// One pane's durable terminal-input outbox: a single JSON document written
/// whole with atomic replacement. Acceptance is local; `.sentUnconfirmed` work is kept
/// for display and never resent.
public actor ActionJournal {
  public enum Delivery: String, Codable, Sendable {
    case neverSent
    case sentUnconfirmed
  }

  public struct Action: Codable, Sendable, Equatable {
    public var id: String
    public var text: String
    public var rawBytes: Data?
    public var delivery: Delivery
  }

  public struct Snapshot: Codable, Sendable, Equatable {
    public var pane: String
    public var actions: [Action]
  }

  public enum JournalError: Error, Equatable, LocalizedError {
    case unknownAction
    case alreadyAttempted
    case alreadyOwned
    case unsafeState

    public var errorDescription: String? {
      switch self {
      case .unknownAction: "Input reservation is missing."
      case .alreadyAttempted: "Input was already attempted."
      case .alreadyOwned: "This pane's input journal is in use. Use a separate state directory."
      case .unsafeState: "Input state must use owned files in a directory without shared write access."
      }
    }
  }

  /// Terminal input has no ack, so the attempted list is a short receipt, not a
  /// full history: an unbounded one would rewrite a growing file per keystroke.
  static let attemptedLimit = 32

  private let file: URL
  private let pane: String
  private let lease: Int32
  private var snapshot: Snapshot

  public var fileURL: URL { file }

  /// Reads and creates its directory, so open it through `open` off the
  /// caller's context. A missing file is a first run; an unreadable one throws
  /// rather than silently discarding a draft.
  public init(directory: URL, pane: String) throws {
    try FileManager.default.createDirectory(
      at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
    let attributes = try FileManager.default.attributesOfItem(atPath: directory.path)
    guard attributes[.type] as? FileAttributeType == .typeDirectory,
          (attributes[.ownerAccountID] as? NSNumber)?.uint32Value == getuid(),
          let permissions = attributes[.posixPermissions] as? NSNumber,
          permissions.intValue & 0o022 == 0 else { throw JournalError.unsafeState }
    let safeName = pane.map { $0.isLetter || $0.isNumber || $0 == "-" ? $0 : "_" }
    let file = directory.appendingPathComponent("actions-\(String(safeName)).json")
    // The lease must survive replacement of the payload inode.
    let descriptor = Darwin.open(file.path + ".lock", O_RDWR | O_CREAT | O_NOFOLLOW | O_CLOEXEC, 0o600)
    guard descriptor >= 0 else { throw POSIXError(.init(rawValue: errno) ?? .EIO) }
    var retained = false
    defer { if !retained { Darwin.close(descriptor) } }
    var info = stat()
    guard fstat(descriptor, &info) == 0, info.st_uid == getuid(),
          info.st_mode & S_IFMT == S_IFREG else { throw JournalError.unsafeState }
    guard flock(descriptor, LOCK_EX | LOCK_NB) == 0 else {
      if errno == EWOULDBLOCK { throw JournalError.alreadyOwned }
      throw POSIXError(.init(rawValue: errno) ?? .EIO)
    }
    guard fchmod(descriptor, 0o600) == 0 else { throw POSIXError(.init(rawValue: errno) ?? .EIO) }
    let contents: Snapshot
    let payload = Darwin.open(file.path, O_RDONLY | O_NOFOLLOW | O_CLOEXEC)
    if payload >= 0 {
      let handle = FileHandle(fileDescriptor: payload, closeOnDealloc: true)
      guard fstat(payload, &info) == 0, info.st_uid == getuid(),
            info.st_mode & S_IFMT == S_IFREG else { throw JournalError.unsafeState }
      guard fchmod(payload, 0o600) == 0 else { throw POSIXError(.init(rawValue: errno) ?? .EIO) }
      let decoded = try JSONDecoder().decode(Snapshot.self, from: handle.readToEnd() ?? Data())
      contents = decoded.pane == pane ? decoded : Snapshot(pane: pane, actions: [])
    } else if errno == ENOENT {
      contents = Snapshot(pane: pane, actions: [])
    } else {
      throw POSIXError(.init(rawValue: errno) ?? .EIO)
    }
    self.file = file
    self.pane = pane
    snapshot = contents
    lease = descriptor
    retained = true
  }

  deinit { Darwin.close(lease) }

  public static func open(directory: URL, pane: String) async throws -> ActionJournal {
    try await Task.detached(priority: .utility) {
      try ActionJournal(directory: directory, pane: pane)
    }.value
  }

  /// Work reserved but never attempted: the only resendable state.
  public func pending() -> [Action] {
    snapshot.actions.filter { $0.delivery == .neverSent }
  }

  /// Work that may have reached the server. Shown, never resent.
  public func attempted() -> [Action] {
    snapshot.actions.filter { $0.delivery == .sentUnconfirmed }
  }

  public func snapshotOfActions() -> Snapshot { snapshot }

  /// Reserves the whole text as one action before any chunk leaves; the wire
  /// client splits it into ≤1 MiB frames afterwards. A failed write throws and
  /// leaves the document as it was, so the caller keeps the draft.
  public func reserve(_ text: String, rawBytes: Data? = nil) throws -> Action {
    let action = Action(id: UUID().uuidString, text: text, rawBytes: rawBytes, delivery: .neverSent)
    try commit(snapshot.actions + [action])
    return action
  }

  /// Persist the attempt before sending: after this a crash or a lost reply can
  /// only leave the action ambiguous, never silently resendable. Refuses an
  /// action that already left, so a duplicate queue entry cannot send twice.
  public func markAttempted(_ id: String) throws {
    guard let index = snapshot.actions.firstIndex(where: { $0.id == id }) else {
      throw JournalError.unknownAction
    }
    guard snapshot.actions[index].delivery == .neverSent else {
      throw JournalError.alreadyAttempted
    }
    var actions = snapshot.actions
    actions[index].delivery = .sentUnconfirmed
    try commit(actions)
  }

  /// A definite non-send (no transport attempt) returns the action to the only
  /// resendable state. Never used for work that may have reached the server.
  public func revertToNeverSent(_ id: String) throws {
    guard let index = snapshot.actions.firstIndex(where: { $0.id == id }) else {
      throw JournalError.unknownAction
    }
    guard snapshot.actions[index].delivery == .sentUnconfirmed else { return }
    var actions = snapshot.actions
    actions[index].delivery = .neverSent
    try commit(actions)
  }

  private func commit(_ actions: [Action]) throws {
    var kept = actions
    let attempted = kept.filter { $0.delivery == .sentUnconfirmed }
    if attempted.count > Self.attemptedLimit {
      let dropped = Set(attempted.prefix(attempted.count - Self.attemptedLimit).map(\.id))
      kept.removeAll { dropped.contains($0.id) }
    }
    let next = Snapshot(pane: pane, actions: kept)
    let data = try JSONEncoder().encode(next)
    // mkstemp is private from creation; rename preserves that mode atomically.
    var template = Array((file.path + ".XXXXXX").utf8CString)
    let descriptor = mkstemp(&template)
    guard descriptor >= 0 else {
      let failure = errno
      let underlying = POSIXError(.init(rawValue: failure) ?? .EIO)
      throw CocoaError(
        failure == EACCES || failure == EPERM ? .fileWriteNoPermission : .fileWriteUnknown,
        userInfo: [NSUnderlyingErrorKey: underlying])
    }
    let handle = FileHandle(fileDescriptor: descriptor, closeOnDealloc: true)
    defer { unlink(template) }
    guard fchmod(descriptor, 0o600) == 0, fcntl(descriptor, F_SETFD, FD_CLOEXEC) == 0 else {
      throw POSIXError(.init(rawValue: errno) ?? .EIO)
    }
    try handle.write(contentsOf: data)
    try handle.synchronize()
    try handle.close()
    guard rename(template, file.path) == 0 else { throw POSIXError(.init(rawValue: errno) ?? .EIO) }
    snapshot = next
  }
}
