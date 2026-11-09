import Foundation

/// The team's real API host. An empty stored Server URL means "use this"; a user-entered value wins.
enum ServerDefaults {
    static let url = "https://conference-companion-ecan4.vercel.app"
    private static let key = "serverURL"

    static func apply() {
        let defaults = UserDefaults.standard
        defaults.register(defaults: [key: url])
        let stored = defaults.string(forKey: key)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if stored.isEmpty { defaults.set(url, forKey: key) }
    }
}
