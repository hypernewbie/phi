import XCTest

/// Drives the real app on a simulator: connect, list panes, attach a terminal.
/// Point it at a throwaway server with `PHI_UITEST_SERVER` (default port 17080).
final class PhiOSUITests: XCTestCase {
  private var server = ProcessInfo.processInfo.environment["PHI_UITEST_SERVER"]
    ?? "http://127.0.0.1:17080"

  override func setUp() {
    continueAfterFailure = false
  }

  func testConnectListsPanes() {
    let app = launchFresh()
    connect(app)
    XCTAssertTrue(
      app.staticTexts["Panes"].waitForExistence(timeout: 20),
      "pane list did not appear after Connect"
    )
    // The list is titled with the host, so this also proves the form carried
    // the isolated test server and not a default.
    XCTAssertTrue(app.staticTexts["127.0.0.1"].exists, "connected somewhere unexpected")
    XCTAssertFalse(app.staticTexts["No panes on this server."].exists)
    // The isolated server is started with one bash pane.
    XCTAssertTrue(app.cells.count > 0 || app.buttons.matching(NSPredicate(
      format: "label CONTAINS 'bash'")).firstMatch.exists)
  }

  func testTerminalAttachesAndSendsInput() {
    let app = launchFresh()
    connect(app)
    XCTAssertTrue(app.staticTexts["Panes"].waitForExistence(timeout: 20))

    let label = app.staticTexts["bash"].firstMatch
    if label.waitForExistence(timeout: 5) {
      label.tap()
    } else {
      let row = app.buttons.matching(NSPredicate(format: "label CONTAINS 'bash'")).firstMatch
      XCTAssertTrue(row.waitForExistence(timeout: 5), "no row for the bash pane\(app.debugDescription)")
      row.tap()
    }

    let field = app.textFields["Type for the pane"]
    XCTAssertTrue(field.waitForExistence(timeout: 10), "terminal screen did not open")

    // The status line only says "attached" once a frame arrived over the socket.
    let attached = app.staticTexts.matching(
      NSPredicate(format: "label BEGINSWITH 'attached'")
    ).firstMatch
    XCTAssertTrue(attached.waitForExistence(timeout: 20), "pane never attached")

    let status = attached.label
    XCTAssertFalse(status.contains("offline"), status)

    field.tap()
    field.typeText("echo PHIOS-OK")
    app.buttons["Send"].tap()
    XCTAssertTrue(
      app.textFields["Type for the pane"].waitForExistence(timeout: 5),
      "composer did not clear after Send"
    )

    let shot = XCTAttachment(screenshot: app.screenshot())
    shot.name = "terminal"
    shot.lifetime = .keepAlways
    add(shot)
  }

  // MARK: helpers

  private func launchFresh() -> XCUIApplication {
    let app = XCUIApplication()
    // A non-Data value in the argument domain makes `SavedTarget.load()` see
    // nothing, so every run starts on the connect form.
    app.launchArguments = ["-phi.target", "reset"]
    app.launch()
    return app
  }

  private func connect(_ app: XCUIApplication) {
    let field = app.textFields.firstMatch
    XCTAssertTrue(field.waitForExistence(timeout: 10), "connect form missing")
    // Put the caret past the default text, then clear it. Command-A needs a
    // hardware keyboard, which a headless simulator does not have.
    field.coordinate(withNormalizedOffset: CGVector(dx: 0.95, dy: 0.5)).tap()
    field.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: 64))
    field.typeText(server)
    XCTAssertEqual(field.value as? String, server, "server field kept the old text")
    app.buttons["Connect"].tap()
  }
}
