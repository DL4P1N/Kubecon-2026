import SwiftUI

/// The venue plan, drawn in one `Canvas` driven by one `TimelineView` (no per-person views).
/// Rooms, receivers, route, the user and simulated attendees all share the plan's metre grid.
struct FloorPlanCanvas: View {
    let avatar: Avatar

    @Environment(PositionEngine.self) private var engine
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.displayScale) private var displayScale

    /// Receivers share the neutral tone; lime stays the only accent.
    private static let receiverTone = Theme.muted
    private static let doorsTop: [CGFloat] = [7, 19.5, 30.5]
    private static let doorsBottom: [CGFloat] = [7, 25]

    var body: some View {
        // Read observable state here so only this view refreshes at the engine's tick rate.
        let snapshot = Snapshot(
            fix: engine.fix, crowd: engine.crowd, route: engine.guidance, destinationID: engine.destinationID,
            receivers: engine.receivers, activeReceiverIDs: Set(engine.assignments.map.keys), moving: !engine.paused
        )
        TimelineView(.animation(minimumInterval: 1.0 / 15, paused: reduceMotion)) { timeline in
            Canvas(opaque: true, rendersAsynchronously: false) { context, size in
                draw(context, size: size, snapshot: snapshot, time: reduceMotion ? 0 : timeline.date.timeIntervalSinceReferenceDate)
            }
        }
        .aspectRatio(FloorPlan.size.width / FloorPlan.size.height, contentMode: .fit)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Floor plan")
        .accessibilityValue(summary(crowdCount: snapshot.crowd.count))
        .accessibilityAddTraits(.isImage)
    }

    /// Text equivalent of the plan for VoiceOver.
    private func summary(crowdCount: Int) -> String {
        guard engine.sharing else {
            var parts = ["Location sharing is off, so your position is not shown."]
            if let destination = engine.destination { parts.append("Destination: \(destination.name).") }
            if crowdCount > 0 { parts.append("\(crowdCount) other attendees shown (simulated).") }
            return parts.joined(separator: " ")
        }
        var parts = [engine.currentRoom.map { "You are in \($0.name)." } ?? "Position unknown."]
        if let destination = engine.destination { parts.append("Destination: \(destination.name).") }
        if let next = engine.nextLine { parts.append(next.hasSuffix(".") ? next : next + ".") }
        if let metres = engine.distanceMetres, !engine.hasArrived { parts.append("About \(metres) metres to go.") }
        if crowdCount > 0 { parts.append("\(crowdCount) other attendees shown (simulated).") }
        parts.append(engine.tag + ".")
        return parts.joined(separator: " ")
    }

    private struct Snapshot {
        let fix: PositionFix?
        let crowd: [CrowdPerson]
        let route: Guidance?
        let destinationID: String
        let receivers: [VenueReceiver]
        let activeReceiverIDs: Set<String>
        let moving: Bool
    }

    private func draw(_ context: GraphicsContext, size: CGSize, snapshot: Snapshot, time: Double) {
        var context = context
        context.fill(Path(CGRect(origin: .zero, size: size)), with: .color(Theme.background))
        let margin: CGFloat = 3
        let scale = min((size.width - margin * 2) / FloorPlan.size.width, (size.height - margin * 2) / FloorPlan.size.height)
        let origin = CGPoint(
            x: ((size.width - FloorPlan.size.width * scale) / 2),
            y: ((size.height - FloorPlan.size.height * scale) / 2)
        )
        let ds = max(displayScale, 1)
        func snap(_ value: CGFloat) -> CGFloat { (value * ds).rounded() / ds }
        func point(_ p: CGPoint) -> CGPoint { CGPoint(x: origin.x + p.x * scale, y: origin.y + p.y * scale) }
        func rect(_ r: CGRect) -> CGRect {
            let a = point(r.origin), b = point(CGPoint(x: r.maxX, y: r.maxY))
            return CGRect(x: snap(a.x), y: snap(a.y), width: snap(b.x) - snap(a.x), height: snap(b.y) - snap(a.y))
        }
        let hairline = 1 / ds

        // Rooms: 1px walls, flat fills, no interpolation.
        for room in FloorPlan.rooms {
            let r = rect(room.rect)
            if room.id != "hallway" {
                context.fill(Path(r), with: .color(Theme.surface))
            }
            context.stroke(Path(r.insetBy(dx: hairline / 2, dy: hairline / 2)), with: .color(Theme.line), lineWidth: hairline)
        }
        // Doorways: gaps in the walls where the hallway meets a room.
        let gap = 1.6 * scale
        for x in Self.doorsTop {
            let c = point(CGPoint(x: x, y: 10))
            context.fill(Path(CGRect(x: snap(c.x - gap), y: snap(c.y) - hairline, width: snap(gap * 2), height: hairline * 3)), with: .color(Theme.background))
        }
        for x in Self.doorsBottom {
            let c = point(CGPoint(x: x, y: 14))
            let color: Color = Theme.surface
            context.fill(Path(CGRect(x: snap(c.x - gap), y: snap(c.y) - hairline, width: snap(gap * 2), height: hairline * 3)), with: .color(color))
        }

        // Destination: lime outline over its walls.
        if let room = FloorPlan.room(id: snapshot.destinationID) {
            let r = rect(room.rect).insetBy(dx: 1, dy: 1)
            context.fill(Path(r), with: .color(Theme.accent.opacity(0.08)))
            context.stroke(Path(r), with: .color(Theme.accent), lineWidth: 2)
        }

        // Room labels: monospaced small caps.
        let labelSize = min(max(scale * 0.95, 8), 11)
        for room in FloorPlan.rooms {
            let r = rect(room.rect)
            let isDestination = room.id == snapshot.destinationID
            let text = Text(room.shortName)
                .font(.system(size: labelSize, weight: .semibold, design: .monospaced).smallCaps())
                .foregroundStyle(isDestination ? Theme.accent : Theme.muted)
            if room.id == "hallway" {
                context.draw(text, at: CGPoint(x: r.minX + 6, y: r.midY), anchor: .leading)
            } else {
                context.draw(text, at: CGPoint(x: r.minX + 6, y: r.minY + 6), anchor: .topLeading)
            }
        }

        // Receivers: small neutral squares with a slow, subtle pulse.
        for (index, receiver) in snapshot.receivers.enumerated() {
            let p = point(receiver.point)
            let active = snapshot.activeReceiverIDs.contains(receiver.id)
            let half: CGFloat = 3
            if !reduceMotion {
                let phase = ((time / 2.4) + Double(index) * 0.31).truncatingRemainder(dividingBy: 1)
                let grow = CGFloat(phase) * 9
                let ring = CGRect(x: snap(p.x - half - grow), y: snap(p.y - half - grow), width: snap((half + grow) * 2), height: snap((half + grow) * 2))
                context.stroke(Path(ring), with: .color(Self.receiverTone.opacity(0.45 * (1 - phase))), lineWidth: hairline * 2)
            }
            let square = CGRect(x: snap(p.x - half), y: snap(p.y - half), width: half * 2, height: half * 2)
            context.fill(Path(square), with: .color(Self.receiverTone.opacity(active ? 1 : 0.7)))
        }

        // Route: dashed lime, marching toward the destination.
        if let route = snapshot.route, let fix = snapshot.fix, !route.isFinished {
            var path = Path()
            let remaining = route.remainingPoints(from: fix.point).map(point)
            path.move(to: remaining[0])
            for p in remaining.dropFirst() { path.addLine(to: p) }
            let phase = reduceMotion || !snapshot.moving ? 0 : -CGFloat(time * 10).truncatingRemainder(dividingBy: 10)
            context.stroke(path, with: .color(Theme.accent), style: StrokeStyle(lineWidth: 2, lineCap: .butt, lineJoin: .miter, dash: [6, 4], dashPhase: phase))
        }

        // Simulated attendees: smaller pixel people, back to front.
        let bob = (time * 3).rounded(.down)
        for person in snapshot.crowd.sorted(by: { $0.point.y < $1.point.y }) {
            let p = point(person.point)
            let lift: CGFloat = reduceMotion || !snapshot.moving ? 0 : (Int(bob) + person.id) % 2 == 0 ? 0 : 1
            let feet = CGPoint(x: p.x.rounded(), y: p.y.rounded() + 6)
            context.fill(Path(CGRect(x: feet.x - 3, y: feet.y, width: 6, height: 1)), with: .color(.black.opacity(0.3)))
            context.drawPixelPerson(person.avatar, bottomCenter: CGPoint(x: feet.x, y: feet.y - lift), cell: 1)
        }

        // You: accuracy ring, your pixel character, and a label.
        if let fix = snapshot.fix {
            let center = point(fix.point)
            let radius = min(fix.accuracy, 6) * scale
            let ring = Path(ellipseIn: CGRect(x: center.x - radius, y: center.y - radius, width: radius * 2, height: radius * 2))
            context.fill(ring, with: .color(Theme.accent.opacity(0.12)))
            context.stroke(ring, with: .color(Theme.accent.opacity(0.7)), lineWidth: 1)
            let feet = CGPoint(x: center.x.rounded(), y: center.y.rounded() + 12)
            context.fill(Path(CGRect(x: feet.x - 8, y: feet.y, width: 16, height: 2)), with: .color(Theme.accent))
            context.drawPixelPerson(avatar, bottomCenter: feet, cell: 2)
            context.draw(
                Text("YOU").font(.system(size: 8, weight: .bold, design: .monospaced)).foregroundStyle(Theme.accent),
                at: CGPoint(x: feet.x, y: feet.y + 4), anchor: .top
            )
        }
    }
}
