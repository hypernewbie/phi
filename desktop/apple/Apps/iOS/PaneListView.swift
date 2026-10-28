import PhiKit
import PhiTerminal
import SwiftUI

/// Panes on one server. Reads the same `/api/terminals` reply as the macOS app
/// and the probe, through the shared access-password path.
struct PaneListView: View {
  let target: SavedTarget
  let onDisconnect: () -> Void

  @State private var panes: [PaneCatalog.Pane] = []
  @State private var password = ""
  @State private var needsPassword = false
  @State private var busy = false
  @State private var error: String?

  var body: some View {
    List {
      if needsPassword {
        Section("Access password") {
          SecureField("Password", text: $password)
          Button("Unlock") { Task { await load() } }.disabled(busy)
        }
      }
      if let error {
        Section { Text(error).foregroundStyle(.red).font(.footnote) }
      }
      Section("Panes") {
        if panes.isEmpty, error == nil {
          Text(busy ? "Loading…" : "No panes on this server.").foregroundStyle(.secondary)
        }
        ForEach(panes) { pane in
          NavigationLink(pane.title ?? pane.coder) {
            TerminalScreen(target: target, pane: pane)
          }
          .badge(Text(pane.coder))
        }
      }
      Section {
        Button("Refresh") { Task { await load() } }.disabled(busy)
        Button("Disconnect", role: .destructive) {
          SavedTarget.clear()
          onDisconnect()
        }
      }
    }
    .navigationTitle(URL(string: target.origin)?.host() ?? "Phi")
    .task { await load() }
    .refreshable { await load() }
  }

  private func load() async {
    guard let origin = URL(string: target.origin) else { return }
    busy = true
    error = nil
    let secret = password.isEmpty ? nil : password
    do {
      let provider: AccessAuth.PasswordProvider? = secret.map { value in
        { @Sendable in value }
      }
      panes = try await PaneCatalog.panes(origin: origin, password: provider)
      needsPassword = false
    } catch AccessAuth.Failure.noPassword {
      needsPassword = true
      error = "This server needs an access password."
    } catch AccessAuth.Failure.wrongPassword {
      needsPassword = true
      error = "Wrong password."
    } catch AccessAuth.Failure.rateLimited {
      error = "Too many attempts; wait a few seconds."
    } catch PaneWireError.http(401) {
      needsPassword = true
      error = "This server needs an access password."
    } catch {
      self.error = error.localizedDescription
    }
    busy = false
  }
}
