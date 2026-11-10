import Foundation

/// The one place Schedule jumps to Find my room.
@MainActor
enum ScheduleNav {
    static func go(to talk: ScheduledTalk, ticket: Ticket?, nav: AppNavigation) {
        nav.findRoomID = ScheduleService.roomID(forTalkRoom: talk.room)
        if let ticket { nav.findSlug = ticket.conference.slug }
        nav.findTalkTitle = talk.title
        nav.tab = .find
    }

    static func planRoomName(for talk: ScheduledTalk) -> String {
        FloorPlan.room(id: ScheduleService.roomID(forTalkRoom: talk.room))?.name ?? "Main Stage"
    }
}
