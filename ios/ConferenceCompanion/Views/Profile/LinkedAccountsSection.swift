import AuthenticationServices
import SwiftUI

struct LinkedAccountsSection: View {
    @Environment(AppStore.self) private var store
    @Environment(\.webAuthenticationSession) private var webAuthentication
    @AppStorage("serverURL") private var serverURL = ""
    @State private var enabled: [String: Bool]?
    @State private var message: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            SectionTitle("Linked accounts")
            ForEach(AuthService.providers, id: \.0) { id, title in
                row(id: id, title: title)
            }
            if let message { Text(message).font(.mono(.footnote)).foregroundStyle(Theme.warn) }
            Text("Links are stored on this phone only.").font(.mono(.caption)).foregroundStyle(Theme.muted)
        }
        .task(id: serverURL) {
            // Debounced: the Server URL field may still be changing.
            enabled = nil
            guard AuthService.validatedServer(serverURL) != nil else { return }
            try? await Task.sleep(for: .milliseconds(500))
            guard !Task.isCancelled else { return }
            enabled = await AuthService.enabledProviders(base: serverURL)
        }
    }

    @ViewBuilder
    private func row(id: String, title: String) -> some View {
        let linked = store.profile.linked?.first { $0.provider == id }
        HStack {
            VStack(alignment: .leading, spacing: 4) {
                Text(title).font(.mono(.subheadline, weight: .semibold))
                if let linked {
                    Text("\(linked.name) · \(linked.linkedAt.formatted(date: .abbreviated, time: .omitted))")
                        .font(.mono(.caption)).foregroundStyle(Theme.accent)
                } else if enabled?[id] != true {
                    Text("Needs a server with sign-in").font(.mono(.caption)).foregroundStyle(Theme.muted)
                }
            }
            Spacer()
            if linked != nil {
                Button("Unlink") { store.unlink(provider: id) }
                    .font(.mono(.footnote, weight: .semibold))
                    .frame(minWidth: 60, minHeight: 44)
            } else if enabled?[id] == true {
                Button("Link") { link(id) }
                    .font(.mono(.footnote, weight: .semibold))
                    .frame(minWidth: 60, minHeight: 44)
                    .accessibilityLabel("Link \(title)")
            }
        }
        .frame(minHeight: 44)
        .panel()
    }

    private func link(_ provider: String) {
        guard let url = AuthService.startURL(base: serverURL, provider: provider) else { return }
        message = nil
        Task {
            do {
                let callback = try await webAuthentication.authenticate(using: url, callbackURLScheme: DeepLink.scheme, preferredBrowserSession: .shared)
                if let account = AuthService.parseLinked(callback), account.provider == provider {
                    store.link(account)
                } else {
                    message = "The server did not confirm the link."
                }
            } catch let error as ASWebAuthenticationSessionError where error.code == .canceledLogin {
                // User closed the sheet.
            } catch {
                message = "Could not link: \(error.localizedDescription)"
            }
        }
    }
}
