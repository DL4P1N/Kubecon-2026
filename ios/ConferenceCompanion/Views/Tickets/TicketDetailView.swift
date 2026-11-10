import SwiftUI

struct TicketDetailView: View {
    @Environment(AppStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    @AppStorage("serverURL") private var serverURL = ""
    let ticketID: UUID
    @Environment(AppNavigation.self) private var nav
    @Environment(\.openURL) private var openURL
    @State private var confirmRemove = false
    @State private var isJoiningWiFi = false
    @State private var wifiMessage: String?
    @State private var showWiFiFallback = false

    var body: some View {
        Group {
            if let ticket = store.ticket(id: ticketID) {
                content(ticket)
            } else {
                Text("This ticket was removed.").ccBody().foregroundStyle(Theme.muted)
            }
        }
        .screenBackground()
        .navigationTitle("Ticket")
        .navigationBarTitleDisplayMode(.inline)
        .safeAreaInset(edge: .bottom) { actionCluster }
        .onAppear { ScreenBrightness.raise() }
        .onDisappear { ScreenBrightness.restore() }
        .task(id: ticketID) { await refreshLoop() }
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button("Remove ticket", systemImage: "trash") { confirmRemove = true }
            }
        }
        .confirmationDialog("Remove this ticket?", isPresented: $confirmRemove, titleVisibility: .visible) {
            Button("Remove ticket", role: .destructive) {
                store.remove(id: ticketID)
                dismiss()
            }
        }
    }

    /// Floating control layer: Liquid Glass actions over the pass. The pass itself stays flat.
    /// One prominent action (Find my room on the day, Directions otherwise), the rest as icon + label.
    @ViewBuilder
    private var actionCluster: some View {
        if let ticket = store.ticket(id: ticketID) {
            let today = TicketTiming.isToday(ticket.conference)
            glassControlGroup(spacing: 8) {
                VStack(spacing: 8) {
                    if today { findRoomButton(ticket, prominent: true) } else { directionsButton(ticket, prominent: true) }
                    HStack(spacing: 8) {
                        if today { directionsButton(ticket, prominent: false) } else { findRoomButton(ticket, prominent: false) }
                        Button {
                            joinWiFi(ticket.conference.network)
                        } label: {
                            if isJoiningWiFi {
                                ProgressView().frame(maxWidth: .infinity, minHeight: 36)
                            } else {
                                Label("Wi-Fi", systemImage: "wifi")
                            }
                        }
                        .ccGlassButton()
                        .disabled(isJoiningWiFi)
                        .accessibilityLabel("Join venue Wi-Fi")
                        if let web = WebLinks.conference(serverURL, slug: ticket.conference.slug) {
                            Link(destination: web) { Label("Web", systemImage: "safari") }
                                .ccGlassButton()
                                .accessibilityLabel("Open in browser")
                        }
                        WalletSection(slug: ticket.conference.slug, serverURL: serverURL)
                    }
                    .labelStyle(StackedActionLabelStyle())
                }
                .font(.footnote.weight(.semibold))
                .buttonBorderShape(.roundedRectangle(radius: 20))
                .controlSize(.large)
                .dynamicTypeSize(...DynamicTypeSize.xxxLarge)
            }
            .padding(.horizontal, 20)
            .padding(.bottom, 8)
        }
    }

    private func directionsButton(_ ticket: Ticket, prominent: Bool) -> some View {
        Button {
            Task {
                if await !VenueMaps.open(ticket.conference), let url = VenueMaps.fallbackURL(ticket.conference) { openURL(url) }
            }
        } label: {
            if prominent {
                Label("Directions to the venue", systemImage: "car").frame(maxWidth: .infinity)
            } else {
                Label("Route", systemImage: "car")
            }
        }
        .ccGlassButton(prominent: prominent)
        .accessibilityLabel("Directions to the venue")
    }

    private func findRoomButton(_ ticket: Ticket, prominent: Bool) -> some View {
        Button {
            nav.findSlug = ticket.conference.slug
            nav.tab = .find
        } label: {
            if prominent {
                Label("Find my room", systemImage: "map").frame(maxWidth: .infinity)
            } else {
                Label("Rooms", systemImage: "map")
            }
        }
        .ccGlassButton(prominent: prominent)
        .accessibilityLabel("Find my room")
    }

    private func joinWiFi(_ network: WiFiNetwork) {
        isJoiningWiFi = true
        wifiMessage = nil
        Task {
            let result = await WiFiJoiner.join(network)
            isJoiningWiFi = false
            wifiMessage = result.message(for: network)
            if result.isFailure { showWiFiFallback = true }
        }
    }

    private func content(_ ticket: Ticket) -> some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 24) {
                TicketPassView(
                    ticket: ticket,
                    avatar: store.avatar,
                    stateLine: stateLine(ticket),
                    statusWarning: store.qrStatus[ticket.id]
                )
                if ticket.conference.assumed == true || (ticket.note != nil && ticket.source != .sample) || ticket.source == .sample {
                    notes(ticket)
                }
                if ticket.source != .sample {
                    Toggle("Reminders (evening before, 1 hour before)", isOn: Binding(
                        get: { ticket.remindersEnabled },
                        set: { store.setReminders(id: ticket.id, on: $0) }
                    ))
                    .font(.subheadline)
                    .tint(Theme.accent)
                    .frame(minHeight: 44)
                    .ccCard()
                }
                WiFiSection(network: ticket.conference.network, message: wifiMessage, showFallback: $showWiFiFallback)
                invite(ticket)
            }
            .padding(.horizontal, 20)
            .padding(.vertical, 16)
        }
    }

    private func stateLine(_ ticket: Ticket) -> String {
        switch ticket.source {
        case .demo: "Demo ticket: room doors will not accept it."
        case .sample: "Sample entry for previewing the app."
        case .api:
            if let expiry = ticket.qrExpires {
                "Refreshes every minute. Expires \(expiry.formatted(date: .omitted, time: .standard))."
            } else {
                "Refreshes every minute."
            }
        }
    }

    @ViewBuilder
    private func notes(_ ticket: Ticket) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            if ticket.conference.assumed == true { Text("Assumed details: dates and venue are a stand-in.") }
            if let note = ticket.note, ticket.source != .sample { Text(note) }
            if ticket.source == .sample { Text("Sample entry for previewing the app.") }
        }
        .font(.footnote)
        .foregroundStyle(Theme.muted)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    @ViewBuilder
    private func invite(_ ticket: Ticket) -> some View {
        if let url = InviteLink.url(base: serverURL, slug: ticket.conference.slug, avatar: store.profile.avatar) {
            ShareLink(item: url, subject: Text("Join me at \(ticket.conference.name)"), message: Text("Register for \(ticket.conference.name)")) {
                Label("Invite a friend", systemImage: "square.and.arrow.up")
            }
            .buttonStyle(.ccQuiet)
        }
    }

    private func refreshLoop() async {
        while !Task.isCancelled {
            await store.refreshQRIfNeeded(id: ticketID, serverURL: serverURL)
            guard let ticket = store.ticket(id: ticketID), ticket.source == .api else { return }
            let remaining = ticket.qrExpires?.timeIntervalSinceNow ?? 60
            try? await Task.sleep(for: .seconds(max(15, remaining - 40)))
        }
    }
}

/// Icon over a short mono caption, for the compact action row.
private struct StackedActionLabelStyle: LabelStyle {
    func makeBody(configuration: Configuration) -> some View {
        VStack(spacing: 4) {
            configuration.icon.font(.body)
            configuration.title.font(.caption2.weight(.semibold)).lineLimit(1).minimumScaleFactor(0.7)
        }
        .frame(maxWidth: .infinity)
    }
}
