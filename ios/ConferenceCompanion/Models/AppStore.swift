import Foundation
import Observation

private struct StoredState: Codable {
    var profile: Profile
    var tickets: [Ticket]
}

@MainActor @Observable
final class AppStore {
    var profile = Profile()
    var tickets: [Ticket] = []
    var qrStatus: [UUID: String] = [:]
    private(set) var catalog: [Conference]
    private(set) var catalogStatus = "Catalogue: bundled"

    @ObservationIgnored private let fileURL: URL
    @ObservationIgnored private let cacheURL: URL

    init() {
        catalog = ConferenceCatalog.load()
        fileURL = URL.applicationSupportDirectory.appending(path: "conference-companion.json")
        cacheURL = URL.applicationSupportDirectory.appending(path: "catalogue-cache.json")
        load()
        loadCatalogueCache()
        // Launch argument `-seedTicket 1` adds one demo ticket (used for screenshots).
        if UserDefaults.standard.bool(forKey: "seedTicket"), tickets.isEmpty, let conference = catalog.first {
            tickets.append(Ticket(
                conference: conference, name: "Erick W", role: "Engineer", interests: ["search"], source: .demo,
                qrToken: "DEMO-" + UUID().uuidString, qrExpires: nil
            ))
        }
    }

    var upcoming: [Ticket] {
        tickets.filter { !$0.conference.isPast }.sorted { $0.conference.startDay < $1.conference.startDay }
    }

    var past: [Ticket] {
        tickets.filter { $0.conference.isPast }.sorted { $0.conference.startDay > $1.conference.startDay }
    }

    var activeTicket: Ticket? { upcoming.first { $0.source != .sample } ?? upcoming.first }

    func ticket(id: UUID) -> Ticket? { tickets.first { $0.id == id } }

    // MARK: Registration

    func register(_ conference: Conference, name: String, role: String, interests: [String], serverURL: String) async -> UUID {
        profile = Profile(name: name, role: role, interests: interests)
        var ticket = Ticket(
            conference: conference, name: name, role: role, interests: interests,
            source: .demo, qrToken: "DEMO-" + UUID().uuidString, qrExpires: nil
        )
        let trimmed = serverURL.trimmingCharacters(in: .whitespacesAndNewlines)
        if !trimmed.isEmpty {
            if let client = APIClient(string: trimmed) {
                do {
                    let registration = try await client.register(name: name, interests: interests, conference: conference.slug)
                    let access = try await client.accessToken(bearer: registration.token)
                    ticket.source = .api
                    ticket.attendeeToken = registration.token
                    ticket.attendeeTokenExpires = ISODate.parse(registration.expiresAt)
                    ticket.qrToken = access.token
                    ticket.qrExpires = ISODate.parse(access.expiresAt)
                } catch where APIClient.isMissingEndpoint(error) {
                    // Static host without /api/register: keep the local Demo ticket path.
                } catch {
                    ticket.note = "The server could not be reached (\(error.localizedDescription)), so this is a local demo ticket."
                }
            } else {
                ticket.note = "The Server URL is not valid, so this is a local demo ticket."
            }
        }
        for old in tickets where old.conference.slug == conference.slug && old.source != .sample {
            NotificationService.cancelAll(ticketID: old.id)
        }
        tickets.removeAll { $0.conference.slug == conference.slug && $0.source != .sample }
        tickets.append(ticket)
        save()
        let added = ticket
        Task { await NotificationService.ticketAdded(added) }
        return ticket.id
    }

    func refreshQRIfNeeded(id: UUID, serverURL: String) async {
        guard let index = tickets.firstIndex(where: { $0.id == id }),
              tickets[index].source == .api,
              let client = APIClient(string: serverURL),
              let bearer = tickets[index].attendeeToken
        else { return }
        if let expiry = tickets[index].qrExpires, expiry.timeIntervalSinceNow > 45 { return }
        if let expiry = tickets[index].attendeeTokenExpires, expiry < .now {
            qrStatus[id] = "Registration expired. Register again to get a fresh ticket."
            return
        }
        do {
            let access = try await client.accessToken(bearer: bearer)
            guard let current = tickets.firstIndex(where: { $0.id == id }) else { return }
            tickets[current].qrToken = access.token
            tickets[current].qrExpires = ISODate.parse(access.expiresAt)
            qrStatus[id] = nil
            save()
        } catch {
            qrStatus[id] = "Could not refresh the QR code. Showing the last one; check the server connection."
        }
    }

    /// Creates or updates a local ticket from a confcompanion:// link. Local only; nothing is synced.
    func ingest(_ link: DeepLinkTicket) -> UUID {
        let name = link.name.isEmpty ? (profile.name.isEmpty ? "Guest" : profile.name) : link.name
        if profile.name.isEmpty { profile.name = name }
        if profile.role.isEmpty { profile.role = link.role }
        if profile.interests.isEmpty { profile.interests = link.interests }
        if let avatar = link.avatar { profile.avatar = avatar.wire }
        let id: UUID
        if let index = tickets.firstIndex(where: { $0.conference.slug == link.conference.slug && $0.source != .sample }) {
            tickets[index].name = name
            if !link.role.isEmpty { tickets[index].role = link.role }
            if !link.interests.isEmpty { tickets[index].interests = link.interests }
            id = tickets[index].id
        } else {
            let ticket = Ticket(
                conference: link.conference, name: name, role: link.role, interests: link.interests,
                source: .demo, qrToken: "DEMO-" + UUID().uuidString, qrExpires: nil,
                note: "Added from a link on the website. This ticket exists only on this phone."
            )
            tickets.append(ticket)
            id = ticket.id
        }
        save()
        if let ticket = ticket(id: id) { Task { await NotificationService.ticketAdded(ticket) } }
        return id
    }

    var avatar: Avatar {
        get { profile.avatarValue }
        set { profile.avatar = newValue.wire; save() }
    }

    func link(_ account: LinkedAccount) {
        profile.linked = (profile.linked ?? []).filter { $0.provider != account.provider } + [account]
        save()
    }

    func unlink(provider: String) {
        profile.linked = (profile.linked ?? []).filter { $0.provider != provider }
        save()
    }

    func setReminders(id: UUID, on: Bool) {
        guard let index = tickets.firstIndex(where: { $0.id == id }) else { return }
        tickets[index].reminders = on
        save()
        let ticket = tickets[index]
        if on { Task { await NotificationService.schedule(ticket) } } else { NotificationService.cancelReminders(ticketID: id) }
    }

    func remove(id: UUID) {
        NotificationService.cancelAll(ticketID: id)
        tickets.removeAll { $0.id == id }
        save()
    }

    func loadSampleHistory() {
        guard !tickets.contains(where: { $0.source == .sample }) else { return }
        let name = profile.name.isEmpty ? "Sample Attendee" : profile.name
        for conference in ConferenceCatalog.sampleHistory() {
            tickets.append(Ticket(
                conference: conference, name: name, role: profile.role.isEmpty ? "Engineer" : profile.role,
                interests: conference.topics, source: .sample, qrToken: "SAMPLE-" + UUID().uuidString, qrExpires: nil,
                note: "Sample entry for previewing the app. Not a real registration."
            ))
        }
        save()
    }

    // MARK: Catalogue

    private struct CatalogueCache: Codable {
        var host: String
        var fetchedAt: Date
        var conferences: [Conference]
    }

    private func statusText(host: String, at date: Date) -> String {
        "Catalogue: updated \(date.formatted(date: .omitted, time: .shortened)) from \(host)"
    }

    private func loadCatalogueCache() {
        let saved = UserDefaults.standard.string(forKey: "serverURL") ?? ""
        guard let host = APIClient(string: saved)?.base.host(),
              let data = try? Data(contentsOf: cacheURL),
              let cache = try? JSONDecoder().decode(CatalogueCache.self, from: data),
              cache.host == host, !cache.conferences.isEmpty
        else { return }
        catalog = cache.conferences.sorted { $0.startDay < $1.startDay }
        catalogStatus = statusText(host: host, at: cache.fetchedAt)
    }

    /// Server URL doubles as the catalogue source: site/data, then data, then the bundled copy.
    func refreshCatalogue(serverURL: String) async {
        guard let client = APIClient(string: serverURL), let host = client.base.host() else {
            catalog = ConferenceCatalog.load()
            catalogStatus = "Catalogue: bundled"
            return
        }
        for path in ["site/data/conferences.json", "data/conferences.json"] {
            guard let list = try? await client.fetchCatalogue(path: path) else { continue }
            let now = Date.now
            catalog = list.sorted { $0.startDay < $1.startDay }
            catalogStatus = statusText(host: host, at: now)
            if let data = try? JSONEncoder().encode(CatalogueCache(host: host, fetchedAt: now, conferences: list)) {
                try? FileManager.default.createDirectory(at: cacheURL.deletingLastPathComponent(), withIntermediateDirectories: true)
                try? data.write(to: cacheURL, options: .atomic)
            }
            return
        }
        if !catalogStatus.contains(host) {
            catalog = ConferenceCatalog.load()
            catalogStatus = "Catalogue: bundled (could not reach \(host))"
        }
    }

    // MARK: Persistence

    func save() {
        let state = StoredState(profile: profile, tickets: tickets)
        guard let data = try? JSONEncoder().encode(state) else { return }
        try? FileManager.default.createDirectory(at: fileURL.deletingLastPathComponent(), withIntermediateDirectories: true)
        try? data.write(to: fileURL, options: .atomic)
    }

    private func load() {
        guard let data = try? Data(contentsOf: fileURL),
              let state = try? JSONDecoder().decode(StoredState.self, from: data)
        else { return }
        profile = state.profile
        tickets = state.tickets
    }
}
