import Foundation

/// One pane's durable terminal-input outbox: a single JSON document written
/// whole with `.atomic`. Acceptance is local; `.sentUnconfirmed` work is kept
/// for display and never resent.
public actor ActionJournal {
  public enum Delivery: String, Codable, Sendable {
    case neverSent
    case sentUnconfirmed
  }

  public struct Action: Codable, Sendable, Equatable {
    public var id: String
    public var text: String
    public var delivery: Delivery
  }

  public struct Snapshot: Codable, Sendable, Equatable {
    public var pane: String
    public var actions: [Action]
  }

  /// Terminal input has no ack, so the attempted list is a short receipt, not a
  /// full history: an unbounded one would rewrite a growing file per keystroke.
  static let attemptedLimit = 32

  private let file: URL
  private let pane: String
  private var snapshot: Snapshot

  public var fileURL: URL { file }

  /// Reads and creates its directory, so open it through `open` off the
  /// caller's context. A missing file is a first run; an unreadable one throws
  /// rather than silently discarding a draft.
  public init(directory: URL, pane: String) throws {
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    // Pane-scoped name so two windows sharing one state dir never clobber.
    let safeName = pane.map { $0.isLetter || $0.isNumber || $0 == "-" ? $0 : "_" }
    file = directory.appendingPathComponent("actions-\(String(safeName)).json")
    self.pane = pane
    if FileManager.default.fileExists(atPath: file.path) {
      let decoded = try JSONDecoder().decode(Snapshot.self, from: Data(contentsOf: file))
      snapshot = decoded.pane == pane ? decoded : Snapshot(pane: pane, actions: [])
    } else {
      snapshot = Snapshot(pane: pane, actions: [])
    }
  }

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
  public func reserve(_ text: String) throws -> Action {
    let action = Action(id: UUID().uuidString, text: text, delivery: .neverSent)
    try commit(snapshot.actions + [action])
    return action
  }

  /// Persist the attempt before sending: after this a crash or a lost reply can
  /// only leave the action ambiguous, never silently resendable.
  public func markAttempted(_ id: String) throws {
    guard let index = snapshot.actions.firstIndex(where: { $0.id == id }) else { return }
    var actions = snapshot.actions
    actions[index].delivery = .sentUnconfirmed
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
    try data.write(to: file, options: .atomic)
    snapshot = next
  }
}
