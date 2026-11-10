import SwiftUI

@main
struct ConferenceCompanionApp: App {
    @State private var store = AppStore()
    @State private var engine = PositionEngine()
    @State private var advertiser = PhoneAdvertiser()
    @State private var nav = AppNavigation()

    init() {
        ServerDefaults.apply()
        NotificationService.install()
    }

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(store)
                .environment(engine)
                .environment(advertiser)
                .environment(nav)
                .preferredColorScheme(.dark)
                .tint(Theme.accent)
        }
    }
}
