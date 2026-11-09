import SwiftUI

/// 2D outline of a scanned room drawn with Canvas. Walls are lime, doors teal, receivers teal squares.
struct RoomOutlineView: View {
    let room: ScannedRoom
    var showReceivers = true

    private let margin = 1.2   // metres of padding around the room

    private var aspect: Double {
        let w = room.width + margin * 2, d = room.depth + margin * 2
        guard w.isFinite, d.isFinite, d > 0.1 else { return 1.4 }
        return min(3, max(0.5, w / d))
    }

    var body: some View {
        Canvas { context, size in
            let w = room.width + margin * 2, d = room.depth + margin * 2
            guard w > 0.1, d > 0.1, size.width > 1, size.height > 1 else { return }
            let scale = min(size.width / w, size.height / d)
            let ox = (size.width - room.width * scale) / 2
            let oy = (size.height - room.depth * scale) / 2
            func pt(_ p: Point2D) -> CGPoint { CGPoint(x: ox + p.x * scale, y: oy + p.y * scale) }

            // Floor
            if room.outline.count >= 3 {
                var floor = Path()
                floor.move(to: pt(room.outline[0]))
                for p in room.outline.dropFirst() { floor.addLine(to: pt(p)) }
                floor.closeSubpath()
                context.fill(floor, with: .color(Theme.floor))
            }

            // Walls
            for wall in room.walls {
                var path = Path()
                path.move(to: pt(wall.a))
                path.addLine(to: pt(wall.b))
                context.stroke(path, with: .color(Theme.accent), style: StrokeStyle(lineWidth: 2, lineCap: .square))
            }

            // Doors, windows, openings
            for mark in room.openings {
                let half = mark.width / 2
                var path = Path()
                path.move(to: pt(Point2D(x: mark.position.x - mark.dx * half, y: mark.position.y - mark.dy * half)))
                path.addLine(to: pt(Point2D(x: mark.position.x + mark.dx * half, y: mark.position.y + mark.dy * half)))
                switch mark.kind {
                case .door:
                    context.stroke(path, with: .color(Theme.floor), lineWidth: 5)
                    context.stroke(path, with: .color(OrganizerStyle.teal), lineWidth: 3)
                case .opening:
                    context.stroke(path, with: .color(Theme.floor), lineWidth: 5)
                case .window:
                    context.stroke(path, with: .color(Theme.ink.opacity(0.6)), style: StrokeStyle(lineWidth: 3, dash: [4, 3]))
                }
            }

            // Receivers
            if showReceivers, room.receiverSpots.count == 3 {
                var links = Path()
                let pts = room.receiverSpots.map(pt)
                links.move(to: pts[0]); links.addLine(to: pts[1]); links.addLine(to: pts[2]); links.closeSubpath()
                context.stroke(links, with: .color(OrganizerStyle.teal.opacity(0.7)), style: StrokeStyle(lineWidth: 1, dash: [4, 3]))
                for (i, p) in pts.enumerated() {
                    let rect = CGRect(x: p.x - 6, y: p.y - 6, width: 12, height: 12)
                    context.fill(Path(rect), with: .color(OrganizerStyle.teal))
                    context.draw(
                        Text(String(UnicodeScalar(65 + i).map(Character.init) ?? "?"))
                            .font(.system(size: 11, weight: .bold, design: .monospaced))
                            .foregroundStyle(Theme.ink),
                        at: CGPoint(x: p.x, y: p.y - 14))
                }
            }

            // Dimensions
            let label = Text("\(ScannedRoom.fmt(room.width)) m")
                .font(.system(size: 11, design: .monospaced)).foregroundStyle(Theme.muted)
            context.draw(label, at: CGPoint(x: size.width / 2, y: max(8, oy - 10)))
            let side = Text("\(ScannedRoom.fmt(room.depth)) m")
                .font(.system(size: 11, design: .monospaced)).foregroundStyle(Theme.muted)
            context.draw(side, at: CGPoint(x: max(20, ox - 22), y: size.height / 2))
        }
        .aspectRatio(aspect, contentMode: .fit)
        .frame(maxWidth: .infinity)
        .background(Theme.background)
        .overlay { Rectangle().strokeBorder(Theme.line, lineWidth: Theme.hairline) }
        .accessibilityElement()
        .accessibilityLabel("Room outline")
        .accessibilityValue(room.summary)
    }
}

#Preview {
    RoomOutlineView(room: .sample)
        .padding()
        .background(Theme.background)
        .preferredColorScheme(.dark)
}
