import AppKit
import Foundation
import XCTest

@testable import PhiSwiftTermSpike

/// The application menu is what makes Quit, Copy/Paste, and reopening the
/// catalog reachable from the keyboard, so its items are pinned here.
final class AppMenuTests: XCTestCase {
  private var workDirectory: URL!

  override func setUpWithError() throws {
    workDirectory = URL(fileURLWithPath: NSTemporaryDirectory())
      .appendingPathComponent("app-menu-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(
      at: workDirectory, withIntermediateDirectories: false,
      attributes: [.posixPermissions: 0o700])
  }

  override func tearDownWithError() throws {
    for window in NSApp.windows where window.title == "Phi" {
      window.close()
    }
    try? FileManager.default.removeItem(at: workDirectory)
  }

  private func menuItem(_ title: String) -> NSMenuItem? {
    guard let mainMenu = NSApp.mainMenu else { return nil }
    for item in mainMenu.items {
      if let submenu = item.submenu,
         let match = submenu.items.first(where: { $0.title == title }) {
        return match
      }
    }
    return nil
  }

  @MainActor
  func testMenuProvidesTheStandardCommands() throws {
    let options = try SpikeOptions.parse(["--state-dir", workDirectory.path])
    let delegate = SpikeApplicationDelegate(options: options)
    delegate.applicationDidFinishLaunching(
      Notification(name: NSApplication.didFinishLaunchingNotification))

    XCTAssertEqual(menuItem("Quit Phi")?.keyEquivalent, "q")
    XCTAssertEqual(menuItem("Copy")?.keyEquivalent, "c")
    XCTAssertEqual(menuItem("Paste")?.keyEquivalent, "v")
    XCTAssertEqual(menuItem("Select All")?.keyEquivalent, "a")
    XCTAssertEqual(menuItem("Pane Catalog")?.keyEquivalent, "0")
    XCTAssertTrue(
      menuItem("Pane Catalog").map { $0.target != nil } ?? false,
      "the catalog item needs a target, or the menu cannot reopen the window")
  }

  @MainActor
  func testCatalogLaunchShowsTheCatalogWindow() throws {
    let options = try SpikeOptions.parse(["--state-dir", workDirectory.path])
    let delegate = SpikeApplicationDelegate(options: options)
    delegate.applicationDidFinishLaunching(
      Notification(name: NSApplication.didFinishLaunchingNotification))

    XCTAssertTrue(
      NSApp.windows.contains { $0.title == "Phi" && $0.isVisible },
      "catalog mode must put its window on screen")
  }
}
