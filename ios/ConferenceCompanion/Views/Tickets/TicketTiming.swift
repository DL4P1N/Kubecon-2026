import Foundation

/// "TODAY" / "TOMORROW" / "IN 3 DAYS" / "PAST" for a conference.
enum TicketTiming {
    static func isToday(_ conference: Conference, now: Date = .now) -> Bool {
        !conference.isPast && conference.startDay <= now
    }

    static func tag(for conference: Conference, now: Date = .now) -> String {
        if conference.isPast { return "Past" }
        if conference.startDay <= now { return "Today" }
        let days = Calendar.current.dateComponents([.day], from: Calendar.current.startOfDay(for: now), to: conference.startDay).day ?? 0
        switch days {
        case ...0: return "Today"
        case 1: return "Tomorrow"
        default: return "In \(days) days"
        }
    }
}
