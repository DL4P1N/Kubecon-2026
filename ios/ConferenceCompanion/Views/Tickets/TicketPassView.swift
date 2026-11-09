import SwiftUI

/// The ticket as one physical object: event part, tear line, admit part. Flat, never glass.
struct TicketPassView: View {
    let ticket: Ticket
    let avatar: Avatar
    let stateLine: String
    var statusWarning: String?

    @ScaledMetric(relativeTo: .body) private var qrSize: CGFloat = 188

    var body: some View {
        VStack(spacing: 0) {
            eventPart
                .background(TicketShape(cuts: [.bottomLeading, .bottomTrailing]).fill(Theme.surface))
                .overlay { TicketShape(cuts: [.bottomLeading, .bottomTrailing]).stroke(Theme.line, lineWidth: Theme.hairline) }
                .overlay(alignment: .bottom) { TearLine().padding(.horizontal, 12).offset(y: 0.5) }
            admitPart
                .background(TicketShape(cuts: [.topLeading, .topTrailing]).fill(Theme.surface))
                .overlay { TicketShape(cuts: [.topLeading, .topTrailing]).stroke(Theme.line, lineWidth: Theme.hairline) }
        }
        .accessibilityElement(children: .contain)
    }

    private var eventPart: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("Conference").ccLabel()
            Text(ticket.conference.name)
                .font(.system(.title, weight: .semibold))
                .tracking(-0.7)
                .foregroundStyle(Theme.ink)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityAddTraits(.isHeader)
            ViewThatFits(in: .horizontal) {
                HStack(alignment: .top, spacing: 12) { facts }
                VStack(alignment: .leading, spacing: 12) { facts }
            }
            HStack(alignment: .center, spacing: 16) {
                PixelPersonView(avatar: avatar, pixel: 3)
                VStack(alignment: .leading, spacing: 4) {
                    Text(ticket.name)
                        .font(.system(.headline, weight: .semibold))
                        .foregroundStyle(Theme.ink)
                    if !ticket.role.isEmpty {
                        Text(ticket.role).font(.subheadline).foregroundStyle(Theme.muted)
                    }
                }
                Spacer(minLength: 0)
            }
            .accessibilityElement(children: .combine)
        }
        .padding(.horizontal, 20)
        .padding(.top, 20)
        .padding(.bottom, 24)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    @ViewBuilder
    private var facts: some View {
        fact("Date", ticket.conference.dateRange)
        fact("Venue", ticket.conference.venue)
        fact("City", ticket.conference.city)
    }

    private func fact(_ label: String, _ value: String) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(label).ccLabel()
            Text(value)
                .ccData()
                .font(.mono(.footnote, weight: .medium))
                .monospacedDigit()
                .fixedSize(horizontal: false, vertical: true)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .combine)
    }

    private var admitPart: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack(alignment: .firstTextBaseline) {
                Text("Door ticket").ccLabel()
                Spacer(minLength: 8)
                Tag(text: ticket.label, tone: .muted)
            }
            QRView(text: ticket.qrToken)
                .frame(maxWidth: qrSize)
                .frame(maxWidth: .infinity)
            Text(stateLine)
                .font(.footnote)
                .monospacedDigit()
                .foregroundStyle(Theme.muted)
                .fixedSize(horizontal: false, vertical: true)
            if let statusWarning {
                Text(statusWarning).font(.footnote).foregroundStyle(Theme.warn)
            }
        }
        .padding(.horizontal, 20)
        .padding(.top, 24)
        .padding(.bottom, 20)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}
