import Foundation
import UserNotifications

final class NotificationDelegate: NSObject, UNUserNotificationCenterDelegate {
    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification) async -> UNNotificationPresentationOptions {
        [.banner, .sound]
    }
}

/// Local notifications only: no push server. Permission is asked when the first ticket is created.
@MainActor
enum NotificationService {
    private static let delegate = NotificationDelegate()

    static func install() {
        UNUserNotificationCenter.current().delegate = delegate
    }

    static func requestPermission() async -> Bool {
        (try? await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound])) ?? false
    }

    static func ticketAdded(_ ticket: Ticket) async {
        guard ticket.source != .sample else { return }
        // Schedule first: pending reminders do not depend on the immediate ping.
        guard await requestPermission() else { return }
        if ticket.remindersEnabled { await schedule(ticket) }
        await ping(ticket)
    }

    static func ping(_ ticket: Ticket) async {
        let content = UNMutableNotificationContent()
        content.title = "You're registered for \(ticket.conference.name)"
        content.body = "Your door ticket is ready in Conference Companion."
        content.sound = .default
        content.threadIdentifier = "ticket-\(ticket.id)"
        let request = UNNotificationRequest(identifier: "\(ticket.id)-ping", content: content, trigger: nil)
        try? await UNUserNotificationCenter.current().add(request)
    }

    /// Evening before (18:00) and one hour before an assumed 09:00 start. Skipped when already past.
    static func schedule(_ ticket: Ticket) async {
        cancelReminders(ticketID: ticket.id)
        guard !ticket.conference.isPast, ticket.conference.startDay != .distantFuture else { return }
        let start = ticket.conference.startDay
        let calendar = Calendar.current
        guard let eveningBefore = calendar.date(byAdding: .hour, value: -6, to: start),
              let oneHourBefore = calendar.date(byAdding: .hour, value: 8, to: start) else { return }
        let items: [(String, Date, String)] = [
            ("evening", eveningBefore, "Tomorrow: \(ticket.conference.name) at \(ticket.conference.venue). Your ticket is in the app."),
            ("hour", oneHourBefore, "\(ticket.conference.name) starts in about an hour. Open your door ticket.")
        ]
        for (suffix, date, body) in items where date > .now {
            let content = UNMutableNotificationContent()
            content.title = ticket.conference.name
            content.body = body
            content.sound = .default
            let components = calendar.dateComponents([.year, .month, .day, .hour, .minute], from: date)
            let trigger = UNCalendarNotificationTrigger(dateMatching: components, repeats: false)
            try? await UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: "\(ticket.id)-\(suffix)", content: content, trigger: trigger))
        }
    }

    static func cancelReminders(ticketID: UUID) {
        UNUserNotificationCenter.current().removePendingNotificationRequests(withIdentifiers: ["\(ticketID)-evening", "\(ticketID)-hour"])
    }

    static func cancelAll(ticketID: UUID) {
        cancelReminders(ticketID: ticketID)
        UNUserNotificationCenter.current().removePendingNotificationRequests(withIdentifiers: ["\(ticketID)-ping"])
        UNUserNotificationCenter.current().removeDeliveredNotifications(withIdentifiers: ["\(ticketID)-ping"])
    }

    /// Fires in 5 seconds, for demos. Returns false when notifications are not allowed.
    static func sendTest() async -> Bool {
        guard await requestPermission() else { return false }
        let content = UNMutableNotificationContent()
        content.title = "Test reminder"
        content.body = "Reminders for your conference tickets will look like this."
        content.sound = .default
        let request = UNNotificationRequest(
            identifier: "test-\(UUID().uuidString)", content: content,
            trigger: UNTimeIntervalNotificationTrigger(timeInterval: 5, repeats: false)
        )
        return (try? await UNUserNotificationCenter.current().add(request)) != nil
    }
}
