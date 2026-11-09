import Foundation

/// One talk on the user's schedule.
struct ScheduledTalk: Identifiable, Hashable {
    var id: String
    var title: String
    var speaker: String
    var abstract: String
    var start: Date
    var end: Date
    var room: String
    var track: String
    var tags: [String]
    /// "Why picked", when the API returns it.
    var reason: String?
}

enum ScheduleService {
    static let defaultServer = "https://conference-companion-ecan4.vercel.app"

    // MARK: Wire shapes (shared/src/contract.ts: ScheduleResponse)

    private struct WireTalk: Decodable {
        var id: String
        var title: String
        var speaker: String?
        var abstract: String?
        var track: String?
        var room: String?
        var start: String
        var end: String
        var tags: [String]?
    }
    private struct WireItem: Decodable { var talk: WireTalk; var reason: String? }
    private struct WireSchedule: Decodable { var items: [WireItem] }

    struct Failure: Error {}

    private static let session: URLSession = {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = 6
        configuration.timeoutIntervalForResource = 8
        configuration.waitsForConnectivity = false
        return URLSession(configuration: configuration)
    }()

    /// GET <base>/api/schedule with the bearer session token.
    static func loadSchedule(base: String, token: String) async throws -> [ScheduledTalk] {
        var text = base.trimmingCharacters(in: .whitespacesAndNewlines)
        if text.isEmpty { text = defaultServer }
        if !text.contains("://") { text = "https://" + text }
        while text.hasSuffix("/") { text.removeLast() }
        guard let root = URL(string: text), root.host() != nil else { throw Failure() }
        var request = URLRequest(url: root.appending(path: "api/schedule"), timeoutInterval: 6)
        request.setValue("Bearer \(token)", forHTTPHeaderField: "authorization")
        request.setValue("application/json", forHTTPHeaderField: "accept")
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse, http.statusCode == 200 else { throw Failure() }
        let wire = try JSONDecoder().decode(WireSchedule.self, from: data)
        let talks: [ScheduledTalk] = wire.items.compactMap { item in
            guard let start = parseDate(item.talk.start), let end = parseDate(item.talk.end) else { return nil }
            return ScheduledTalk(
                id: item.talk.id, title: item.talk.title, speaker: item.talk.speaker ?? "",
                abstract: item.talk.abstract ?? "", start: start, end: end,
                room: item.talk.room ?? "", track: item.talk.track ?? "", tags: item.talk.tags ?? [],
                reason: item.reason
            )
        }
        return talks.sorted { $0.start < $1.start }
    }

    /// Live schedule when possible, otherwise the local sample schedule. Never throws.
    static func load(ticket: Ticket?, serverURL: String) async -> (talks: [ScheduledTalk], isSample: Bool) {
        if let ticket, let token = ticket.attendeeToken, !token.isEmpty, ticket.source == .api {
            if let talks = try? await loadSchedule(base: serverURL, token: token), !talks.isEmpty {
                return (talks, false)
            }
        }
        return (sampleSchedule(for: ticket), true)
    }

    static func parseDate(_ text: String) -> Date? {
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = fractional.date(from: text) { return date }
        return ISO8601DateFormatter().date(from: text)
    }

    // MARK: Room mapping

    /// Maps a talk's room string to a FloorPlan room id: stage, room-a, room-b, lobby or lounge.
    static func roomID(forTalkRoom room: String) -> String {
        let lower = room.lowercased()
        let words = Set(lower.split { !$0.isLetter && !$0.isNumber }.map(String.init))
        let stageWords = ["keynote", "main", "stage", "ballroom", "auditorium", "plenary"]
        if stageWords.contains(where: { lower.contains($0) }) { return "stage" }
        if words.contains("a") || words.contains("1") { return "room-a" }
        if words.contains("b") || words.contains("2") { return "room-b" }
        if lower.contains("lobby") || lower.contains("registration") { return "lobby" }
        if ["lounge", "hall", "expo"].contains(where: { lower.contains($0) }) { return "lounge" }
        var hash: UInt32 = 5381
        for scalar in lower.unicodeScalars { hash = hash &* 33 &+ scalar.value }
        return ["stage", "room-a", "room-b"][Int(hash % 3)]
    }

    // MARK: Sample schedule

    private struct Sample {
        let id: String, title: String, speaker: String, abstract: String, room: String, track: String
        let from: Int, to: Int, tags: [String]
    }

    private static let samples: [Sample] = [
        Sample(id: "s1", title: "Opening keynote: search that explains itself", speaker: "Maya Okafor", abstract: "Why relevance debugging belongs in the platform, and how teams ship it.", room: "Main Stage", track: "Keynote", from: 540, to: 580, tags: ["search"]),
        Sample(id: "s2", title: "Tracing a query from ingress to shard", speaker: "Dev Patel", abstract: "A walk through distributed tracing for search clusters.", room: "Breakout A", track: "Observability", from: 600, to: 645, tags: ["observability", "search"]),
        Sample(id: "s3", title: "Operating Kubernetes without pager fatigue", speaker: "Lena Fischer", abstract: "Alert design, SLOs and runbooks that survive a bad night.", room: "Breakout B", track: "Kubernetes", from: 600, to: 645, tags: ["kubernetes"]),
        Sample(id: "s4", title: "Hands-on: an AI SRE for your cluster", speaker: "Tomas Rivera", abstract: "Build a triage agent that reads logs and proposes fixes.", room: "Breakout A", track: "AI SRE", from: 660, to: 720, tags: ["ai sre", "observability"]),
        Sample(id: "s5", title: "Code review at the speed of CI", speaker: "Priya Nair", abstract: "Automated review that engineers actually trust.", room: "Breakout B", track: "Code review", from: 660, to: 705, tags: ["code review"]),
        Sample(id: "s6", title: "Lunch and demo tables", speaker: "Community", abstract: "", room: "Lounge", track: "Social", from: 720, to: 780, tags: []),
        Sample(id: "s7", title: "Hybrid search: BM25 meets embeddings", speaker: "Jonas Weber", abstract: "Fusing keyword and semantic retrieval with rank fusion.", room: "Main Stage", track: "Search", from: 810, to: 855, tags: ["search"]),
        Sample(id: "s8", title: "Kubernetes upgrades you can sleep through", speaker: "Amira Haddad", abstract: "Surge, drain and rollback strategies for production clusters.", room: "Breakout A", track: "Kubernetes", from: 870, to: 915, tags: ["kubernetes"]),
        Sample(id: "s9", title: "Reviewing AI-written code", speaker: "Chris Lund", abstract: "What changes when half the diff is generated.", room: "Breakout B", track: "Code review", from: 930, to: 975, tags: ["code review", "ai sre"]),
        Sample(id: "s10", title: "Hackathon showcase", speaker: "All teams", abstract: "Five-minute demos from every team.", room: "Main Stage", track: "Showcase", from: 1020, to: 1080, tags: ["search", "kubernetes", "observability"]),
        Sample(id: "s11", title: "Closing and awards", speaker: "Organisers", abstract: "Winners, thanks and where to go next.", room: "Main Stage", track: "Keynote", from: 1090, to: 1120, tags: [])
    ]

    static func sampleSchedule(for ticket: Ticket?) -> [ScheduledTalk] {
        let day = ticket.map { $0.conference.startDay }.flatMap { $0 == .distantFuture ? nil : $0 }
            ?? Calendar.current.startOfDay(for: .now)
        let interests = Set((ticket?.interests ?? []).map { $0.lowercased() })
        let calendar = Calendar.current
        func build(_ list: [Sample]) -> [ScheduledTalk] {
            list.compactMap { sample in
                guard let start = calendar.date(byAdding: .minute, value: sample.from, to: day),
                      let end = calendar.date(byAdding: .minute, value: sample.to, to: day) else { return nil }
                return ScheduledTalk(
                    id: sample.id, title: sample.title, speaker: sample.speaker, abstract: sample.abstract,
                    start: start, end: end, room: sample.room, track: sample.track, tags: sample.tags,
                    reason: nil
                )
            }
        }
        guard !interests.isEmpty else { return build(samples) }
        let filtered = samples.filter { sample in
            sample.tags.isEmpty || !interests.isDisjoint(with: sample.tags.map { $0.lowercased() })
        }
        return build(filtered.count >= 3 ? filtered : samples)
    }
}
