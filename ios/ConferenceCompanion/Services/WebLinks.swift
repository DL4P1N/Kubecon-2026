import Foundation

/// Every link the app opens or shares uses the Settings base URL.
enum WebLinks {
    static func base(_ text: String) -> URL? { APIClient(string: text)?.base }

    static func home(_ text: String) -> URL? { base(text)?.appending(path: "site/") }

    static func profile(_ text: String) -> URL? { base(text)?.appending(path: "site/profile.html") }

    static func conference(_ text: String, slug: String, avatar: String? = nil) -> URL? {
        guard let page = base(text)?.appending(path: "site/conference.html"),
              var components = URLComponents(url: page, resolvingAgainstBaseURL: false) else { return nil }
        components.queryItems = [URLQueryItem(name: "c", value: slug)] + (avatar.map { [URLQueryItem(name: "avatar", value: $0)] } ?? [])
        return components.url
    }
}

enum InviteLink {
    static func url(base: String, slug: String, avatar: String? = nil) -> URL? {
        WebLinks.conference(base, slug: slug, avatar: avatar)
    }
}
