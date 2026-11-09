import Foundation

/// Optional account linking through the server's own sign-in. No client ids or secrets live in the app.
enum AuthService {
    static let providers = [("github", "GitHub"), ("google", "Google"), ("linkedin", "LinkedIn")]

    private struct ProviderList: Decodable {
        struct Item: Decodable { let id: String; let enabled: Bool }
        let providers: [Item]
    }

    /// nil when the server is unset or unreachable.
    static func enabledProviders(base: String) async -> [String: Bool]? {
        guard let client = APIClient(string: base) else { return nil }
        let request = URLRequest(url: client.base.appending(path: "api/auth/providers"), timeoutInterval: 6)
        guard let (data, response) = try? await URLSession.shared.data(for: request),
              (response as? HTTPURLResponse)?.statusCode == 200,
              let list = try? JSONDecoder().decode(ProviderList.self, from: data)
        else { return nil }
        return Dictionary(list.providers.map { ($0.id, $0.enabled) }, uniquingKeysWith: { first, _ in first })
    }

    static func startURL(base: String, provider: String) -> URL? {
        guard providers.contains(where: { $0.0 == provider }), let client = APIClient(string: base),
              var components = URLComponents(url: client.base.appending(path: "api/auth/\(provider)/start"), resolvingAgainstBaseURL: false)
        else { return nil }
        components.queryItems = [URLQueryItem(name: "app", value: "1"), URLQueryItem(name: "return", value: "/site/profile.html")]
        return components.url
    }

    /// confcompanion://linked?provider=<p>&name=<display name>; strict parsing lives in `DeepLink`.
    static func parseLinked(_ url: URL) -> LinkedAccount? { DeepLink.parseLinked(url) }

    /// The host the Server URL resolves to, for display; nil when it is not a usable http(s) URL.
    static func validatedServer(_ text: String) -> (url: URL, host: String)? {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        guard let client = APIClient(string: trimmed),
              let scheme = client.base.scheme?.lowercased(), scheme == "http" || scheme == "https",
              let host = client.base.host(), !host.isEmpty
        else { return nil }
        let port = client.base.port.map { ":\($0)" } ?? ""
        return (client.base, host + port)
    }
}
