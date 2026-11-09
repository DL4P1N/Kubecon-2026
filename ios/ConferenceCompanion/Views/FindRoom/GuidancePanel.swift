import SwiftUI

/// Where you are, the distance left, the ordered steps with the current one highlighted, and the arrived state.
struct GuidancePanel: View {
    @Environment(PositionEngine.self) private var engine

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            VStack(alignment: .leading, spacing: 4) {
                SectionTitle("You are in")
                Text(engine.currentRoom?.name ?? "Position unknown")
                    .font(.mono(.title3, weight: .semibold))
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
                    .font(.mono(.footnote))
                    .foregroundStyle(Theme.muted)
            }
        }
        .panel()
    }

    private func arrived(_ destination: Room) -> some View {
        Label {
            VStack(alignment: .leading, spacing: 2) {
                Text("Arrived").font(.mono(.headline, weight: .semibold))
                Text("You are at \(destination.name).").font(.mono(.footnote)).foregroundStyle(Theme.muted)
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
                SectionTitle("To \(destination.name)")
                Spacer()
                if let metres = engine.distanceMetres {
                    Text("\(metres) m")
                        .font(.mono(.headline, weight: .semibold))
                        .foregroundStyle(Theme.accent)
                        .accessibilityLabel("\(metres) metres to go")
                }
            }
            if let next = engine.nextLine {
                Text(next)
                    .font(.mono(.subheadline, weight: .semibold))
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
                            .font(.mono(.footnote, weight: index == current ? .semibold : .regular))
                            .foregroundStyle(index < current ? Theme.muted.opacity(0.6) : index == current ? Color.white : Theme.muted)
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
