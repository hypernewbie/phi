import PhiKit
import PhiTerminal
import SwiftUI

/// Server entry. The password is used once to derive a verifier; the server
/// never receives it, and the verifier lives in the Keychain.
struct ConnectView: View {
  @State private var server = "http://hyperion:7070"
  @State private var password = ""
  @State private var busy = false
  @State private var error: String?

  let onConnect: (SavedTarget) -> Void

  var body: some View {
    Form {
      Section("Server") {
        TextField("http://host:7070", text: $server)
          .textInputAutocapitalization(.never)
          .autocorrectionDisabled()
          .keyboardType(.URL)
      }
      Section("Access password") {
        SecureField("Leave empty when the server has none", text: $password)
        Text("Only a derived verifier is stored, in the Keychain.")
          .font(.footnote)
          .foregroundStyle(.secondary)
      }
      if let error {
        Section {
          Text(error).foregroundStyle(.red).font(.footnote)
        }
      }
      Section {
        Button(busy ? "Connecting…" : "Connect") { connect() }
          .disabled(busy || origin == nil)
      }
    }
    .navigationTitle("Phi")
  }

  private var origin: URL? {
    guard let url = URL(string: server.trimmingCharacters(in: .whitespaces)),
          let scheme = url.scheme?.lowercased(), scheme == "http" || scheme == "https",
          url.host != nil else { return nil }
    return url
  }

  private func connect() {
    guard let origin else { return }
    busy = true
    error = nil
    let secret = password.isEmpty ? nil : password
    Task {
      do {
        let provider: AccessAuth.PasswordProvider? = secret.map { value in
          { @Sendable in value }
        }
        _ = try await PaneCatalog.panes(origin: origin, password: provider)
        let target = SavedTarget(origin: origin.absoluteString)
        target.save()
        onConnect(target)
      } catch {
        self.error = describe(error)
      }
      busy = false
    }
  }

  private func describe(_ error: Error) -> String {
    if let failure = error as? AccessAuth.Failure {
      switch failure {
      case .noPassword: return "This server needs an access password."
      case .wrongPassword: return "Wrong password."
      case .rateLimited: return "Too many attempts; wait a few seconds."
      case .badStatus: return "The server answered with unexpected auth settings."
      case .server(let message): return message
      }
    }
    return error.localizedDescription
  }
}
