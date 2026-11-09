import SwiftUI

/// Where you are, the distance left, the ordered steps with the current one highlighted, and the arrived state.
struct GuidancePanel: View {
    @Environment(PositionEngine.self) private var engine
    /// Flips the location-sharing toggle on.
    var turnOnLocation: () -> Void = {}

    var body: some View {
        if engine.sharing {
            guidance
        } else {
            sharingOff
        }
    }

    /// Without sharing there is no position: one card explains why and offers the single action.
    private var sharingOff: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Location sharing is off").ccTitle()
            Text("Turn on \u{201C}Let venue receivers locate this phone\u{201D} to see where you are and get directions.")
                .ccBody()
                .foregroundStyle(Theme.muted)
                .fixedSize(horizontal: false, vertical: true)
            Text("Broadcasts a random ID tied to this ticket over Bluetooth: no name, no attendee ID.")
                .ccCaption()
            Button("Turn on location", systemImage: "location.fill", action: turnOnLocation)
                .buttonStyle(.ccPrimary)
        }
        .panel()
    }

    private var guidance: some View {
        VStack(alignment: .leading, spacing: 12) {
            VStack(alignment: .leading, spacing: 4) {
                SectionTitle("You are in")
                Text(engine.currentRoom?.name ?? "Position unknown")
                    .ccTitle()
                    .accessibilityLabel(engine.currentRoom.map { "You are in \($0.name)" } ?? "Position unknown")
                if let fix = engine.fix {
                    Text("Accuracy about \(Int(fix.accuracy.rounded())) m")
                        .font(.mono(.footnote))
                        .foregroundStyle(Theme.muted)
                }
            }
            if let destination = engine.destination {
                Divider().overlay(Theme.line)
                if engine.hasArrived {
                    arrived(destination)
                } else {
                    heading(destination)
                    steps
                }
            } else {
                Divider().overlay(Theme.line)
                Text("Choose a room below and the plan draws your route.")
                    .ccCaption()
            }
        }
        .panel()
    }

    private func arrived(_ destination: Room) -> some View {
        Label {
            VStack(alignment: .leading, spacing: 2) {
                Text("Arrived").ccHeadline().foregroundStyle(Theme.accent)
                Text(engine.talkTitle.map { "You are at \(destination.name) for \($0)." } ?? "You are at \(destination.name).").ccCaption()
            }
        } icon: {
            Image(systemName: "checkmark.square.fill").foregroundStyle(Theme.accent)
        }
        .foregroundStyle(Theme.accent)
        .accessibilityElement(children: .combine)
    }

    private func heading(_ destination: Room) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .firstTextBaseline) {
                SectionTitle(engine.talkTitle.map { "To: \($0)" } ?? "To \(destination.name)")
                Spacer()
                if let metres = engine.distanceMetres {
                    Text("\(metres) m")
                        .font(.mono(.headline, weight: .semibold))
                        .foregroundStyle(Theme.accent)
                        .accessibilityLabel("\(metres) metres to go")
                }
            }
            if engine.talkTitle != nil {
                Text(destination.name).ccCaption()
            }
            if let next = engine.nextLine {
                Text(next)
                    .ccBody()
                    .fontWeight(.semibold)
                    .foregroundStyle(Theme.accent)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    @ViewBuilder
    private var steps: some View {
        if let guidance = engine.guidance {
            let current = guidance.progress
            VStack(alignment: .leading, spacing: 8) {
                ForEach(Array(guidance.steps.enumerated()), id: \.offset) { index, step in
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        Text("\(index + 1)")
                            .font(.mono(.caption, weight: .semibold))
                            .frame(minWidth: 18)
                            .foregroundStyle(index == current ? Theme.background : Theme.muted)
                            .background(index == current ? Theme.accent : Color.clear)
                        Text(step)
                            .font(.subheadline.weight(index == current ? .semibold : .regular))
                            .foregroundStyle(index < current ? Theme.muted.opacity(0.6) : index == current ? Theme.ink : Theme.muted)
                            .strikethrough(index < current)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    .accessibilityElement(children: .combine)
                    .accessibilityLabel("Step \(index + 1), \(step)")
                    .accessibilityValue(index < current ? "done" : index == current ? "current" : "")
                }
            }
        }
    }
}
