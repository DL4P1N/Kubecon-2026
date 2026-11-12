import Foundation

/// `confcompanion://ticket?c=<slug>&name=&role=&interests=a,b&avatar=<wire>`
///
/// SECURITY: the slug is untrusted text from a link. `parse` only accepts a slug that is in the catalogue the caller
/// passes in, so the caller must pass the catalogue it actually loaded; never create a conference from the link itself.
struct DeepLinkTicket: Equatable {
    var conference: Conference
    var name: String
    var role: String
    var interests: [String]
    var avatar: Avatar?
}

enum DeepLink {
    static let scheme = "confcompanion"
    static let knownHosts: Set<String> = ["ticket", "linked"]
    static let providerIDs: [String] = ["github"]

    static let nameLimit = 80
    static let roleLimit = 80
    static let interestLimit = 40
    static let interestCount = 12

    /// First value of a query item, with control characters removed, trimmed and capped. Duplicates and unknown keys are ignored.
    private static func value(_ key: String, in items: [URLQueryItem], limit: Int) -> String {
        let raw = items.first { $0.name == key }?.value ?? ""
        let cleaned = String(String.UnicodeScalarView(raw.unicodeScalars.filter { !$0.properties.isDefaultIgnorableCodePoint && !CharacterSet.controlCharacters.contains($0) && $0 != "\n" }))
        return String(cleaned.trimmingCharacters(in: .whitespacesAndNewlines).prefix(limit))
    }

    private static func queryItems(_ url: URL, host: String) -> [URLQueryItem]? {
        guard url.scheme?.lowercased() == scheme, let urlHost = url.host()?.lowercased(),
              knownHosts.contains(urlHost), urlHost == host,
              let components = URLComponents(url: url, resolvingAgainstBaseURL: false)
        else { return nil }
        return components.queryItems ?? []
    }

    /// Ticket links. nil unless the host is `ticket` and the slug is in `catalog`.
    static func parse(_ url: URL, catalog: [Conference]) -> DeepLinkTicket? {
        guard let items = queryItems(url, host: "ticket") else { return nil }
        let slug = value("c", in: items, limit: 100)
        guard !slug.isEmpty, let conference = catalog.first(where: { $0.slug == slug }) else { return nil }
        var seen = Set<String>()
        let interests = value("interests", in: items, limit: 12 * (interestLimit + 1))
            .split(separator: ",")
            .map { String($0.trimmingCharacters(in: .whitespaces).lowercased().prefix(interestLimit)) }
            .filter { !$0.isEmpty && seen.insert($0).inserted }
            .prefix(interestCount)
        return DeepLinkTicket(
            conference: conference,
            name: value("name", in: items, limit: nameLimit),
            role: value("role", in: items, limit: roleLimit),
            interests: Array(interests),
            avatar: Avatar(wire: value("avatar", in: items, limit: 40))
        )
    }

    /// `confcompanion://linked?provider=github&name=<display name>`. nil for any other provider or host.
    static func parseLinked(_ url: URL, now: Date = .now) -> LinkedAccount? {
        guard let items = queryItems(url, host: "linked") else { return nil }
        let provider = value("provider", in: items, limit: 20).lowercased()
        guard providerIDs.contains(provider) else { return nil }
        let name = value("name", in: items, limit: nameLimit)
        return LinkedAccount(provider: provider, name: name.isEmpty ? "Linked" : name, linkedAt: now)
    }
}
