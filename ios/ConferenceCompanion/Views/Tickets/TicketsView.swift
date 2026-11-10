import SwiftUI

struct TicketsView: View {
    @Environment(AppStore.self) private var store
    @Environment(AppNavigation.self) private var nav
    @AppStorage("serverURL") private var serverURL = ""
    @State private var showRegister = false
    @State private var ticketToRemove: Ticket?
    @Namespace private var zoom

    var body: some View {
        @Bindable var nav = nav
        NavigationStack(path: $nav.ticketPath) {
            List {
                if store.tickets.isEmpty {
                    emptyState
                } else {
                    section("Upcoming", tickets: store.upcoming)
                    section("Past", tickets: store.past)
                }
                Text(store.catalogStatus)
                    .font(.mono(.caption))
                    .foregroundStyle(Theme.muted)
                    .plainRow()
            }
            .listStyle(.plain)
            .scrollContentBackground(.hidden)
            .refreshable { await store.refreshCatalogue(serverURL: serverURL) }
            .screenBackground()
            .navigationTitle("Tickets")
            .navigationDestination(for: UUID.self) { id in
                TicketDetailView(ticketID: id).navigationTransition(.zoom(sourceID: id, in: zoom))
            }
            .toolbar {
                if !store.tickets.isEmpty {
                    ToolbarItem(placement: .primaryAction) {
                        Button("Register for a conference", systemImage: "plus") { showRegister = true }
                    }
                }
            }
            .sheet(isPresented: $showRegister) {
                RegisterFlowView { newID in
                    showRegister = false
                    nav.ticketPath.append(newID)
                }
            }
            .confirmationDialog(
                "Remove this ticket?", isPresented: Binding(get: { ticketToRemove != nil }, set: { if !$0 { ticketToRemove = nil } }),
                titleVisibility: .visible, presenting: ticketToRemove
            ) { ticket in
                Button("Remove ticket", role: .destructive) { store.remove(id: ticket.id) }
            } message: { ticket in
                Text("\(ticket.conference.name) will be removed from this phone and its reminders cancelled.")
            }
        }
    }

    private var emptyState: some View {
        VStack(alignment: .leading, spacing: 16) {
            PixelPersonView(avatar: store.avatar, pixel: 4)
            Text("No tickets yet")
                .font(.system(.title2, weight: .semibold))
                .foregroundStyle(Theme.ink)
            Text("Register for a conference to get a QR ticket for room doors.")
                .font(.subheadline)
                .foregroundStyle(Theme.muted)
            Button("Register for a conference", systemImage: "plus") { showRegister = true }
                .buttonStyle(.cc)
        }
        .ccCard(padding: 20)
        .plainRow()
    }

    @ViewBuilder
    private func section(_ title: String, tickets: [Ticket]) -> some View {
        if !tickets.isEmpty {
            CCSectionLabel(title, detail: "\(tickets.count)").plainRow()
            ForEach(tickets) { ticket in
                Button { nav.ticketPath.append(ticket.id) } label: { TicketRow(ticket: ticket, avatar: store.avatar) }
                    .buttonStyle(.plain)
                    .matchedTransitionSource(id: ticket.id, in: zoom)
                    .plainRow()
                    .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                        Button("Remove", systemImage: "trash", role: .destructive) { ticketToRemove = ticket }
                    }
                    .accessibilityAction(named: "Remove ticket") { ticketToRemove = ticket }
            }
        }
    }
}

private extension View {
    /// Flat, separator-free list row on the screen background.
    func plainRow() -> some View {
        listRowBackground(Color.clear)
            .listRowSeparator(.hidden)
            .listRowInsets(EdgeInsets(top: 6, leading: 20, bottom: 6, trailing: 20))
    }
}

/// A miniature of the pass: same notched silhouette, vertical tear line, small pixel character.
struct TicketRow: View {
    let ticket: Ticket
    let avatar: Avatar

    var body: some View {
        let past = ticket.conference.isPast
        let today = TicketTiming.isToday(ticket.conference)
        HStack(spacing: 0) {
            VStack(alignment: .leading, spacing: 8) {
                Text(TicketTiming.tag(for: ticket.conference))
                    .font(.mono(.caption2, weight: .semibold))
                    .tracking(1)
                    .textCase(.uppercase)
                    .foregroundStyle(today ? Theme.ink : Theme.muted)
                Text(ticket.conference.name)
                    .font(.system(.headline, weight: .semibold))
                    .tracking(-0.3)
                    .foregroundStyle(Theme.ink)
                    .multilineTextAlignment(.leading)
                    .fixedSize(horizontal: false, vertical: true)
                Text("\(ticket.conference.dateRange) · \(ticket.conference.city)")
                    .ccData()
                    .font(.mono(.footnote))
                    .monospacedDigit()
                    .foregroundStyle(Theme.muted)
                    .multilineTextAlignment(.leading)
            }
            .padding(.leading, 16)
            .padding(.vertical, 16)
            .padding(.trailing, 12)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(TicketShape(cuts: [.topTrailing, .bottomTrailing]).fill(Theme.surface))
            .overlay { TicketShape(cuts: [.topTrailing, .bottomTrailing]).stroke(Theme.line, lineWidth: Theme.hairline) }
            .overlay(alignment: .trailing) { TearLine(vertical: true).padding(.vertical, 12).offset(x: 0.5) }
            VStack(spacing: 4) {
                PixelPersonView(avatar: avatar, pixel: 2)
                Image(systemName: "chevron.right")
                    .font(.caption2)
                    .foregroundStyle(Theme.muted)
                    .accessibilityHidden(true)
            }
            .frame(width: 64)
            .frame(maxHeight: .infinity)
            .background(TicketShape(cuts: [.topLeading, .bottomLeading]).fill(Theme.surface))
            .overlay { TicketShape(cuts: [.topLeading, .bottomLeading]).stroke(Theme.line, lineWidth: Theme.hairline) }
        }
        .opacity(past ? 0.55 : 1)
        .frame(minHeight: 44)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(ticket.conference.name), \(ticket.conference.dateRange), \(ticket.conference.city), \(TicketTiming.tag(for: ticket.conference))")
        .accessibilityHint("Opens the ticket")
    }
}
