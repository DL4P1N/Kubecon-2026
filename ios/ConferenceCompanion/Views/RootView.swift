import SwiftUI

struct RootView: View {
    @Environment(AppStore.self) private var store
    @Environment(AppNavigation.self) private var nav
    @AppStorage("serverURL") private var serverURL = ""

    var body: some View {
        @Bindable var nav = nav
        TabView(selection: $nav.tab) {
            Tab("Tickets", systemImage: "qrcode", value: AppTab.tickets) { TicketsView() }
            Tab("Find my room", systemImage: "map", value: AppTab.find) { FindRoomView(initialDestinationID: nav.findRoomID) }
            Tab("Profile", systemImage: "person", value: AppTab.profile) { ProfileView() }
            Tab("Organiser", systemImage: "viewfinder", value: AppTab.organizer) { NavigationStack { OrganizerToolsView() } }
        }
        .task(id: serverURL) {
            try? await Task.sleep(for: .milliseconds(800))
            if !Task.isCancelled { await store.refreshCatalogue(serverURL: serverURL) }
        }
        .onAppear {
            if UserDefaults.standard.string(forKey: "startTab") == "ticket", let id = store.tickets.first?.id {
                nav.ticketPath = [id]
            }
        }
        .onOpenURL { url in
            if let account = AuthService.parseLinked(url) {
                store.link(account)
                nav.tab = .profile
                return
            }
            guard let link = DeepLink.parse(url, catalog: store.catalog) else { return }
            let id = store.ingest(link)
            nav.tab = .tickets
            nav.ticketPath = [id]
        }
    }
}
