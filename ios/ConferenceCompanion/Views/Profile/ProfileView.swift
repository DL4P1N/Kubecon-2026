import SwiftUI

struct ProfileView: View {
    @Environment(AppStore.self) private var store
    @AppStorage("serverURL") private var serverURL = ""
    @State private var showSettings = false
    @State private var customText = ""

    private var inviteConferences: [Conference] {
        let fromTickets = store.upcoming.map(\.conference)
        if !fromTickets.isEmpty { return fromTickets }
        return store.catalog.filter { !$0.isPast }.prefix(1).map { $0 }
    }

    var body: some View {
        @Bindable var store = store
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    VStack(alignment: .leading, spacing: 8) {
                        SectionTitle("Name")
                        TextField("Name", text: $store.profile.name, prompt: Text("Name").foregroundStyle(Theme.muted))
                            .ccBody()
                            .textContentType(.name)
                            .padding(10).frame(minHeight: 44)
                            .overlay { Rectangle().strokeBorder(Theme.lineStrong, lineWidth: 1) }
                        SectionTitle("Role")
                        TextField("Role", text: $store.profile.role, prompt: Text("Role").foregroundStyle(Theme.muted))
                            .ccBody()
                            .textContentType(.jobTitle)
                            .padding(10).frame(minHeight: 44)
                            .overlay { Rectangle().strokeBorder(Theme.lineStrong, lineWidth: 1) }
                    }

                    VStack(alignment: .leading, spacing: 10) {
                        SectionTitle("Interests")
                        if store.profile.interests.isEmpty {
                            Text("None yet. Add some here or while registering.")
                                .ccCaption()
                        }
                        FlowLayout {
                            ForEach(store.profile.interests, id: \.self) { interest in
                                Button {
                                    store.profile.interests.removeAll { $0 == interest }
                                } label: {
                                    Label(interest, systemImage: "xmark")
                                        .font(.subheadline)
                                        .foregroundStyle(Theme.accent)
                                        .padding(.horizontal, 12)
                                        .frame(minHeight: 44)
                                        .overlay { Rectangle().strokeBorder(Theme.accent) }
                                }
                                .buttonStyle(.plain)
                                .accessibilityLabel("Remove \(interest)")
                            }
                        }
                        HStack {
                            TextField("Add an interest", text: $customText, prompt: Text("Add an interest").foregroundStyle(Theme.muted))
                                .ccBody()
                                .textInputAutocapitalization(.never)
                                .padding(10).frame(minHeight: 44)
                                .overlay { Rectangle().strokeBorder(Theme.lineStrong, lineWidth: 1) }
                                .onSubmit(addInterest)
                            Button("Add", action: addInterest)
                                .buttonStyle(.ccQuiet)
                                .frame(maxWidth: 100)
                                .disabled(customText.trimmingCharacters(in: .whitespaces).isEmpty || store.profile.interests.count >= DeepLink.interestCount)
                        }
                    }

                    AvatarEditor(avatar: Binding(get: { store.avatar }, set: { store.avatar = $0 }))

                    conferences("Upcoming", store.upcoming)
                    conferences("Past", store.past)

                    VStack(alignment: .leading, spacing: 10) {
                        SectionTitle("Invite")
                        if let first = inviteConferences.first, InviteLink.url(base: serverURL, slug: first.slug) != nil {
                            ForEach(inviteConferences) { conference in
                                if let url = InviteLink.url(base: serverURL, slug: conference.slug) {
                                    ShareLink(item: url, subject: Text("Join me at \(conference.name)"), message: Text("Register for \(conference.name)")) {
                                        Label("Invite to \(conference.name)", systemImage: "square.and.arrow.up")
                                    }
                                    .buttonStyle(.ccSecondary)
                                }
                            }
                        } else {
                            Text("Set a Server URL in Settings to share registration links.")
                                .ccCaption()
                            Button("Open Settings") { showSettings = true }.buttonStyle(.ccQuiet)
                        }
                    }

                    LinkedAccountsSection()

                    VStack(alignment: .leading, spacing: 10) {
                        SectionTitle("Website")
                        if let home = WebLinks.home(serverURL), let profile = WebLinks.profile(serverURL) {
                            Link(destination: home) { Label("Open website", systemImage: "safari").frame(maxWidth: .infinity, minHeight: 44) }
                                .buttonStyle(.ccQuiet)
                            Link(destination: profile) { Label("Open my profile on the web", systemImage: "person.crop.square").frame(maxWidth: .infinity, minHeight: 44) }
                                .buttonStyle(.ccQuiet)
                        } else {
                            Text("Set a Server URL in Settings to open the website.").ccCaption()
                        }
                    }

                    if hasSample {
                        Button("Clear sample history", systemImage: "xmark.bin") { clearSampleHistory() }
                            .buttonStyle(.ccQuiet)
                    } else {
                        Button("Load sample history", systemImage: "clock.arrow.circlepath") { store.loadSampleHistory() }
                            .buttonStyle(.ccQuiet)
                    }
                }
                .padding(16)
            }
            .screenBackground()
            .navigationTitle("Profile")
            .toolbar {
                ToolbarItem(placement: .primaryAction) {
                    Button("Settings", systemImage: "gearshape") { showSettings = true }
                }
            }
            .sheet(isPresented: $showSettings) { SettingsView() }
            .onChange(of: store.profile) {
                if store.profile.name.count > DeepLink.nameLimit { store.profile.name = String(store.profile.name.prefix(DeepLink.nameLimit)) }
                if store.profile.role.count > DeepLink.roleLimit { store.profile.role = String(store.profile.role.prefix(DeepLink.roleLimit)) }
                store.save()
            }
        }
    }

    @ViewBuilder
    private func conferences(_ title: String, _ tickets: [Ticket]) -> some View {
        if !tickets.isEmpty {
            VStack(alignment: .leading, spacing: 8) {
                SectionTitle(title)
                ForEach(tickets) { ticket in
                    HStack(alignment: .top) {
                        VStack(alignment: .leading, spacing: 4) {
                            Text(ticket.conference.name).font(.system(.subheadline, weight: .semibold))
                            Text("\(ticket.conference.dateRange) · \(ticket.conference.city)")
                                .font(.mono(.caption)).foregroundStyle(Theme.muted)
                        }
                        Spacer()
                        if ticket.source == .sample { Tag(text: "Sample", tone: .warn) }
                    }
                    .panel()
                }
            }
        }
    }

    private var hasSample: Bool { store.tickets.contains { $0.source == .sample } }

    private func clearSampleHistory() {
        store.tickets.removeAll { $0.source == .sample }
        store.save()
    }

    private func addInterest() {
        let value = String(customText.trimmingCharacters(in: .whitespaces).lowercased().prefix(DeepLink.interestLimit))
        guard !value.isEmpty, store.profile.interests.count < DeepLink.interestCount else { customText = ""; return }
        if !store.profile.interests.contains(value) { store.profile.interests.append(value) }
        customText = ""
    }
}
