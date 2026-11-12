import SwiftUI

struct SettingsView: View {
    @AppStorage("serverURL") private var serverURL = ""
    @Environment(\.dismiss) private var dismiss
    @Environment(AppStore.self) private var store
    @State private var testMessage: String?
    @State private var confirmReset = false
    @State private var resetDone = false

    private var server: (url: URL, host: String)? { AuthService.validatedServer(serverURL) }
    private var hasText: Bool { !serverURL.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 24) {
                    serverSection
                    remindersSection
                    resetSection
                }
                .padding(16)
            }
            .screenBackground()
            .navigationTitle("Settings")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
            .onChange(of: serverURL) { serverURL = serverURL.trimmingCharacters(in: .whitespacesAndNewlines) }
            .confirmationDialog("Reset demo data?", isPresented: $confirmReset, titleVisibility: .visible) {
                Button("Reset tickets and profile", role: .destructive, action: resetDemoData)
                Button("Cancel", role: .cancel) {}
            } message: {
                Text("Removes every ticket, your profile, character and linked accounts from this phone. The Server URL stays.")
            }
        }
    }

    private var serverSection: some View {
        VStack(alignment: .leading, spacing: 12) {
            SectionTitle("Server URL")
            TextField("https://your-app.example", text: $serverURL)
                .font(.mono(.body))
                .keyboardType(.URL)
                .textContentType(.URL)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .padding(10)
                .frame(minHeight: 44)
                .overlay { Rectangle().strokeBorder(hasText && server == nil ? Theme.down : Theme.line) }
            if let server {
                Text("Using \(server.host) (\(server.url.scheme ?? "http")).")
                    .font(.mono(.footnote, weight: .semibold)).foregroundStyle(Theme.accent)
            } else if hasText {
                Text("Not a usable address. Enter the HTTPS origin configured for your deployment.")
                    .font(.mono(.footnote, weight: .semibold)).foregroundStyle(Theme.down)
            } else {
                Text("Empty: local Demo tickets and the bundled catalogue.")
                    .font(.mono(.footnote)).foregroundStyle(Theme.muted)
            }
            Text("When set, registration uses POST /api/register and POST /api/access/token on this server, exactly as the web app does. The same address serves the catalogue (<url>/site/data/conferences.json, then <url>/data/conferences.json, then the bundled copy), the website links and account sign-in. Plain http works on a local network.")
                .font(.mono(.footnote))
                .foregroundStyle(Theme.muted)
            Text(store.catalogStatus)
                .font(.mono(.footnote, weight: .semibold)).foregroundStyle(Theme.accent)
            Button("Refresh catalogue") { Task { await store.refreshCatalogue(serverURL: serverURL) } }
                .buttonStyle(.ccQuiet)
        }
    }

    private var remindersSection: some View {
        VStack(alignment: .leading, spacing: 12) {
            SectionTitle("Reminders")
            Button("Send test reminder") {
                Task {
                    testMessage = await NotificationService.sendTest()
                        ? "Sent. It arrives in 5 seconds; lock the phone or go Home to see it."
                        : "Notifications are not allowed. Turn them on in Settings."
                }
            }
            .buttonStyle(.ccQuiet)
            if let testMessage { Text(testMessage).font(.mono(.footnote)).foregroundStyle(Theme.muted) }
        }
    }

    private var resetSection: some View {
        VStack(alignment: .leading, spacing: 12) {
            SectionTitle("Demo data")
            Button("Reset demo data", systemImage: "trash") { confirmReset = true }
                .buttonStyle(.ccQuiet)
            if resetDone {
                Text("Reset. Tickets, profile and character are cleared.")
                    .font(.mono(.footnote)).foregroundStyle(Theme.muted)
            }
        }
    }

    private func resetDemoData() {
        for ticket in store.tickets { NotificationService.cancelAll(ticketID: ticket.id) }
        store.tickets = []
        store.profile = Profile()
        store.save()
        resetDone = true
    }
}
