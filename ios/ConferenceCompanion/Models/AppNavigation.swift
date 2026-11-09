import Foundation
import Observation

enum AppTab: Hashable {
    case tickets, schedule, find, profile, organizer
}

@MainActor @Observable
final class AppNavigation {
    var tab: AppTab = .tickets
    var ticketPath: [UUID] = []
    /// Conference chosen via "Find my room" on a ticket.
    var findSlug: String?
    /// FloorPlan room id preselected as the destination in Find my room.
    var findRoomID: String?
    /// Talk title shown as "To: <title>" in Find my room.
    var findTalkTitle: String?

    init() {
        // Launch argument `-startTab find|profile` (used for screenshots).
        switch UserDefaults.standard.string(forKey: "startTab") {
        case "find": tab = .find
        case "profile": tab = .profile
        default: break
        }
    }
}
