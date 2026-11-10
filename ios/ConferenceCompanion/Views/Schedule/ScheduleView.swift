import SwiftUI

/// "My schedule": the talks you are going to, with navigation to each talk's room.
/// Integration: second tab, `NavigationStack { ScheduleView() }`.
struct ScheduleView: View {
    @Environment(AppStore.self) private var store
    @Environment(AppNavigation.self) private var nav
    @AppStorage("serverURL") private var serverURL = ""

    @State private var talks: [ScheduledTalk] = []
    @State private var isSample = false
    @State private var loaded = false
    @State private var selectedSlug: String?
    @State private var detail: ScheduledTalk?

    private var ticket: Ticket? {
        if let selectedSlug, let match = store.upcoming.first(where: { $0.conference.slug == selectedSlug }) { return match }
        return store.activeTicket
    }

    private var loadKey: String { "\(ticket?.id.uuidString ?? "none")|\(serverURL)|\(ticket?.attendeeToken ?? "")" }

    var body: some View {
        TimelineView(.periodic(from: .now, by: 30)) { context in
            content(now: context.date)
        }
        .screenBackground()
        .navigationTitle("My schedule")
        .navigationBarTitleDisplayMode(.large)
        .task(id: loadKey) { await load() }
        .refreshable { await load() }
        .sheet(item: $detail) { talk in
            TalkDetailSheet(talk: talk, isSample: isSample) {
                detail = nil
                ScheduleNav.go(to: talk, ticket: ticket, nav: nav)
            }
        }
    }

    @ViewBuilder
    private func content(now: Date) -> some View {
        let upcoming = talks.filter { $0.end > now }
        let next = upcoming.first
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 12) {
                if store.upcoming.count > 1 { picker }
                if isSample { Tag(text: "Sample schedule", tone: .warn) }
                if loaded && talks.isEmpty {
                    empty
                } else if !talks.isEmpty {
                    if let next {
                        UpNextCard(
                            talk: next, tag: ScheduleFormat.timeTag(next, now: now, isNext: true),
                            go: { go(next) }, open: { detail = next }
                        )
                    }
                    ForEach(grouped(), id: \.day) { group in
                        CCSectionLabel(ScheduleFormat.day(group.day))
                            .padding(.top, 8)
                        ForEach(group.talks.filter { $0.id != next?.id }) { talk in
                            TalkRow(
                                talk: talk,
                                tag: ScheduleFormat.timeTag(talk, now: now, isNext: false),
                                past: talk.end <= now,
                                go: { go(talk) }, open: { detail = talk }
                            )
                        }
                    }
                } else {
                    ProgressView().tint(Theme.accent).frame(maxWidth: .infinity).padding(.top, 40)
                }
            }
            .padding(Theme.spacing)
        }
    }

    private var picker: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(store.upcoming) { item in
                    Button { selectedSlug = item.conference.slug } label: {
                        Text(item.conference.name).ccChip(selected: item.id == ticket?.id)
                    }
                    .buttonStyle(.plain)
                    .frame(minHeight: Theme.minTarget)
                }
            }
        }
        .accessibilityLabel("Conference")
    }

    private var empty: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Your schedule is empty. Register for a conference to get talks picked for you.").ccBody()
            Button { nav.tab = .tickets } label: { Text("Go to Tickets") }
                .buttonStyle(.ccPrimary)
        }
        .ccCard()
    }

    private struct DayGroup { let day: Date; let talks: [ScheduledTalk] }

    private func grouped() -> [DayGroup] {
        let calendar = Calendar.current
        let byDay = Dictionary(grouping: talks) { calendar.startOfDay(for: $0.start) }
        return byDay.keys.sorted().map { day in
            DayGroup(day: day, talks: (byDay[day] ?? []).sorted { $0.start < $1.start })
        }
    }

    private func go(_ talk: ScheduledTalk) {
        ScheduleNav.go(to: talk, ticket: ticket, nav: nav)
    }

    private func load() async {
        let result = await ScheduleService.load(ticket: ticket, serverURL: serverURL)
        talks = result.talks
        isSample = result.isSample
        loaded = true
    }
}
