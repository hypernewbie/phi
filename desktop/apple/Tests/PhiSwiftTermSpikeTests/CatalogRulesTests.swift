import AppKit
import Foundation
import XCTest

@testable import PhiKit
@testable import PhiTerminal
@testable import PhiSwiftTermSpike

/// The catalog's failure rules: a broken refresh keeps what is on screen, a
/// failed origin is not remembered, and a pane that did not open is not
/// reported as opened.
final class CatalogRulesTests: XCTestCase {
  private var workDirectory: URL!
  private let originKey = "phi.spike.origin"
  private let origin = URL(string: "http://127.0.0.1:17777")!

  override func setUpWithError() throws {
    workDirectory = URL(fileURLWithPath: NSTemporaryDirectory())
      .appendingPathComponent("catalog-rules-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(
      at: workDirectory, withIntermediateDirectories: false,
      attributes: [.posixPermissions: 0o700])
  }

  override func tearDownWithError() throws {
    UserDefaults.standard.removeObject(forKey: originKey)
    try? FileManager.default.removeItem(at: workDirectory)
  }

  private func pane(_ id: String, coder: String = "bash", title: String? = nil)
    -> PaneCatalog.Pane
  {
    PaneCatalog.Pane(id: id, coder: coder, title: title, cwd: nil)
  }

  @MainActor
  private func makeCatalog(onAttach: @escaping (URL, PaneCatalog.Pane, AccessAuth.PasswordProvider?) -> String?)
    -> SpikeCatalogWindow
  {
    SpikeCatalogWindow(stateDirectory: workDirectory, onAttach: onAttach)
  }

  @MainActor
  func testFailedRefreshKeepsTheListOnScreen() async {
    let catalog = makeCatalog(onAttach: { _, _, _ in nil })
    var calls = 0
    catalog.paneLoader = { _, _ in
      calls += 1
      if calls == 1 { return [self.pane("a1"), self.pane("b2")] }
      throw PaneWireError.badOrigin
    }

    await catalog.loadPanes(origin: origin)
    XCTAssertEqual(catalog.catalogSummary.panes, 2)

    await catalog.loadPanes(origin: origin)
    XCTAssertEqual(catalog.catalogSummary.panes, 2, "a failed refresh must not blank the catalog")
    XCTAssertTrue(catalog.catalogSummary.status.contains("showing the last list"))
  }

  @MainActor
  func testFailedConnectToAnotherServerClearsTheList() async {
    let catalog = makeCatalog(onAttach: { _, _, _ in nil })
    var calls = 0
    catalog.paneLoader = { _, _ in
      calls += 1
      if calls == 1 { return [self.pane("a1")] }
      throw PaneWireError.badOrigin
    }

    await catalog.loadPanes(origin: origin)
    XCTAssertEqual(catalog.catalogSummary.panes, 1)

    await catalog.loadPanes(origin: URL(string: "http://127.0.0.1:17778")!)
    XCTAssertEqual(
      catalog.catalogSummary.panes, 0,
      "rows from one server must not linger under another server's address")
  }

  @MainActor
  func testOnlyASuccessfulListingIsRemembered() async {
    UserDefaults.standard.removeObject(forKey: originKey)
    let catalog = makeCatalog(onAttach: { _, _, _ in nil })
    catalog.paneLoader = { _, _ in throw PaneWireError.badOrigin }

    await catalog.loadPanes(origin: origin)
    XCTAssertNil(
      UserDefaults.standard.string(forKey: originKey),
      "a server that did not answer must not become the next launch's default")

    catalog.paneLoader = { _, _ in [self.pane("a1")] }
    await catalog.loadPanes(origin: origin)
    XCTAssertEqual(UserDefaults.standard.string(forKey: originKey), origin.absoluteString)
  }

  @MainActor
  func testAFailedAttachIsNotReportedAsOpened() async {
    let catalog = makeCatalog(onAttach: { _, _, _ in "state directory is busy" })
    catalog.paneLoader = { _, _ in [self.pane("a1")] }
    await catalog.loadPanes(origin: origin)

    XCTAssertFalse(catalog.attachRow(0), "a pane that did not open must not report success")
    let status = catalog.catalogSummary.status
    XCTAssertTrue(status.contains("Could not open"), status)
    XCTAssertTrue(status.contains("state directory is busy"), status)
    XCTAssertFalse(status.contains("Opened"), status)
  }

  @MainActor
  func testASuccessfulAttachIsReportedOnce() async {
    var attached: [String] = []
    let catalog = makeCatalog(onAttach: { _, pane, _ in
      attached.append(pane.id)
      return nil
    })
    catalog.paneLoader = { _, _ in [self.pane("a1", coder: "bash")] }
    await catalog.loadPanes(origin: origin)

    XCTAssertTrue(catalog.attachRow(0))
    XCTAssertEqual(attached, ["a1"])
    XCTAssertEqual(catalog.catalogSummary.status, "Opened bash.")
  }

  @MainActor
  func testAttachWithoutASelectionDoesNothing() async {
    var attached = 0
    let catalog = makeCatalog(onAttach: { _, _, _ in
      attached += 1
      return nil
    })
    catalog.paneLoader = { _, _ in [self.pane("a1")] }
    await catalog.loadPanes(origin: origin)

    XCTAssertFalse(catalog.attachRow(4))
    XCTAssertFalse(catalog.attachRow(-1))
    XCTAssertEqual(attached, 0)
  }
}

extension CatalogRulesTests {
  @MainActor
  func testListingDropsDraftsForPanesTheServerNoLongerHas() async {
    let catalog = makeCatalog(onAttach: { _, _, _ in nil })
    catalog.paneLoader = { _, _ in
      [self.pane("kept1"), self.pane("kept2")]
    }
    let keptKey = PhiComposerView.draftKey(paneID: "kept1")
    let goneKey = PhiComposerView.draftKey(paneID: "gone9")
    UserDefaults.standard.set("still here", forKey: keptKey)
    UserDefaults.standard.set("abandoned", forKey: goneKey)
    defer {
      UserDefaults.standard.removeObject(forKey: keptKey)
      UserDefaults.standard.removeObject(forKey: goneKey)
    }

    await catalog.loadPanes(origin: origin)

    XCTAssertEqual(UserDefaults.standard.string(forKey: keptKey), "still here")
    XCTAssertNil(
      UserDefaults.standard.string(forKey: goneKey),
      "a draft for a pane the server dropped must not stay on disk")
  }
}

@MainActor
final class PaneTitleTests: XCTestCase {
  func testTheTabUsesThePaneTitleAndFallsBackToItsCoder() {
    XCTAssertEqual(
      SpikeApplicationDelegate.title(
        of: PaneCatalog.Pane(id: "a1", coder: "bash", title: "release build", cwd: nil)),
      "release build")
    XCTAssertEqual(
      SpikeApplicationDelegate.title(
        of: PaneCatalog.Pane(id: "a1", coder: "bash", title: nil, cwd: nil)),
      "bash")
    XCTAssertEqual(
      SpikeApplicationDelegate.title(
        of: PaneCatalog.Pane(id: "a1", coder: "pi", title: "", cwd: nil)),
      "pi", "an empty title is no title")
  }
}
