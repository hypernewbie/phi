import SwiftUI

@main
struct PhiOSApp: App {
  @State private var target: SavedTarget? = SavedTarget.load()

  var body: some Scene {
    WindowGroup {
      RootView(target: $target)
    }
  }
}

struct RootView: View {
  @Binding var target: SavedTarget?

  var body: some View {
    NavigationStack {
      if let current = target {
        PaneListView(target: current, onDisconnect: { target = nil })
      } else {
        ConnectView(onConnect: { connected in target = connected })
      }
    }
  }
}

/// Where the app connects. The access password never lands here: only the
/// derived verifier is kept, by `AccessAuth`, in the Keychain.
struct SavedTarget: Codable, Equatable {
  var origin: String

  static func load() -> SavedTarget? {
    guard let data = UserDefaults.standard.data(forKey: "phi.target") else { return nil }
    return try? JSONDecoder().decode(SavedTarget.self, from: data)
  }

  func save() {
    guard let data = try? JSONEncoder().encode(self) else { return }
    UserDefaults.standard.set(data, forKey: "phi.target")
  }

  static func clear() {
    UserDefaults.standard.removeObject(forKey: "phi.target")
  }
}
