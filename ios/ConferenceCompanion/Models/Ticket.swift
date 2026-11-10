import Foundation

struct Profile: Codable, Equatable {
    var name = ""
    var role = ""
    var interests: [String] = []
    /// Avatar wire string; nil means the standard character.
    var avatar: String?
    var linked: [LinkedAccount]?

    var avatarValue: Avatar { Avatar(wire: avatar) ?? .standard }
}

struct LinkedAccount: Codable, Equatable, Hashable {
    var provider: String
    var name: String
    var linkedAt: Date
}

struct Ticket: Codable, Identifiable, Hashable {
    enum Source: String, Codable { case api, demo, sample }

    var id = UUID()
    var conference: Conference
    var name: String
    var role: String
    var interests: [String]
    var source: Source
    var attendeeToken: String?
    var attendeeTokenExpires: Date?
    var qrToken: String
    var qrExpires: Date?
    /// Random per-ticket UUID used for the optional Bluetooth beacon. Not derived from name or attendee ID.
    var beaconUUID = UUID()
    var createdAt = Date()
    var note: String?
    /// nil means on (older saved tickets).
    var reminders: Bool?

    var remindersEnabled: Bool { reminders ?? true }

    var label: String {
        switch source {
        case .api: "Live ticket"
        case .demo: "Demo ticket"
        case .sample: "Sample"
        }
    }
}
