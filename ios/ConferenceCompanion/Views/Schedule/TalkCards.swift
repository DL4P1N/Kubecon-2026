import SwiftUI

enum ScheduleFormat {
    static func range(_ talk: ScheduledTalk) -> String {
        let a = talk.start.formatted(date: .omitted, time: .shortened)
        let b = talk.end.formatted(date: .omitted, time: .shortened)
        return "\(a) – \(b)"
    }

    static func day(_ date: Date) -> String {
        date.formatted(.dateTime.weekday(.wide).month(.abbreviated).day())
    }

    /// "NOW", "IN 25 MIN" (within the hour), or "NEXT" for the first later talk.
    static func timeTag(_ talk: ScheduledTalk, now: Date, isNext: Bool) -> String? {
        if talk.start <= now && talk.end > now { return "NOW" }
        guard talk.start > now else { return nil }
        let minutes = Int((talk.start.timeIntervalSince(now) / 60).rounded(.up))
        if minutes <= 60 { return "IN \(minutes) MIN" }
        return isNext ? "NEXT" : nil
    }

    static func spoken(_ talk: ScheduledTalk, tag: String?) -> String {
        var parts = [talk.title]
        if !talk.speaker.isEmpty { parts.append("by \(talk.speaker)") }
        parts.append(range(talk))
        if !talk.room.isEmpty { parts.append("in \(talk.room)") }
        if let tag { parts.append(tag.lowercased()) }
        return parts.joined(separator: ", ")
    }
}

struct TalkInfo: View {
    let talk: ScheduledTalk
    let tag: String?
    var large = false

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text(ScheduleFormat.range(talk)).ccData()
                Spacer(minLength: 4)
                if let tag { Tag(text: tag, tone: tag == "NOW" ? .accent : .muted) }
            }
            Text(talk.title)
                .font(.system(large ? .title3 : .headline, weight: .semibold))
                .foregroundStyle(Theme.ink)
                .lineLimit(large ? 3 : 2)
                .multilineTextAlignment(.leading)
            if !talk.speaker.isEmpty { Text(talk.speaker).ccCaption() }
            if !talk.room.isEmpty {
                Text(talk.room.uppercased())
                    .font(.mono(.caption2, weight: .semibold))
                    .foregroundStyle(Theme.muted)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(ScheduleFormat.spoken(talk, tag: tag))
    }
}

struct RoomMapping: View {
    let talk: ScheduledTalk

    var body: some View {
        Text("Room: \(talk.room.isEmpty ? "unknown" : talk.room) → \(ScheduleNav.planRoomName(for: talk))")
            .font(.mono(.caption2))
            .foregroundStyle(Theme.muted)
            .frame(maxWidth: .infinity, alignment: .leading)
    }
}

struct UpNextCard: View {
    let talk: ScheduledTalk
    let tag: String?
    let go: () -> Void
    let open: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Up next").ccLabel()
            Button(action: open) { TalkInfo(talk: talk, tag: tag, large: true) }
                .buttonStyle(.plain)
                .accessibilityHint("Shows talk details")
            if let reason = talk.reason, !reason.isEmpty { Text(reason).ccCaption() }
            Button(action: go) { Text("Take me there") }
                .buttonStyle(.ccPrimary)
            RoomMapping(talk: talk)
        }
        .ccCard(padding: 18, raised: true)
        .overlay(alignment: .top) { Rectangle().fill(Theme.accent).frame(height: 2) }
    }
}

struct TalkRow: View {
    let talk: ScheduledTalk
    let tag: String?
    let past: Bool
    let go: () -> Void
    let open: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Button(action: open) { TalkInfo(talk: talk, tag: tag) }
                .buttonStyle(.plain)
                .accessibilityHint("Shows talk details")
            Button(action: go) { Text("Navigate") }
                .buttonStyle(.ccSecondary)
            RoomMapping(talk: talk)
        }
        .ccCard()
        .opacity(past ? 0.55 : 1)
    }
}

struct TalkDetailSheet: View {
    let talk: ScheduledTalk
    let isSample: Bool
    let go: () -> Void
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    Text(ScheduleFormat.day(talk.start)).ccLabel()
                    Text(ScheduleFormat.range(talk)).ccData()
                    Text(talk.title).ccTitle()
                    if !talk.speaker.isEmpty { Text(talk.speaker).ccHeadline() }
                    if !talk.abstract.isEmpty { Text(talk.abstract).ccBody() }
                    if let reason = talk.reason, !reason.isEmpty {
                        VStack(alignment: .leading, spacing: 4) {
                            Text("Why picked").ccLabel()
                            Text(reason).ccBody()
                        }
                    }
                    if !talk.room.isEmpty {
                        Text(talk.room.uppercased())
                            .font(.mono(.footnote, weight: .semibold))
                            .foregroundStyle(Theme.muted)
                    }
                    let chips = ([talk.track] + talk.tags).filter { !$0.isEmpty }
                    if !chips.isEmpty {
                        FlowLayout(spacing: 6) {
                            ForEach(chips, id: \.self) { Tag(text: $0, tone: .muted) }
                        }
                    }
                    if isSample { Tag(text: "Sample schedule", tone: .warn) }
                    Button(action: go) { Text("Take me there") }
                        .buttonStyle(.ccPrimary)
                    RoomMapping(talk: talk)
                }
                .padding(Theme.spacing)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .screenBackground()
            .navigationTitle("Talk")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
        }
        .presentationDetents([.medium, .large])
    }
}
