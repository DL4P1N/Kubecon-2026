import SwiftUI

/// Sharp rectangle whose chosen corners are cut with a two-step pixel stair. Two pieces joined at a
/// seam read as one ticket with stepped pixel notches on both sides.
struct TicketShape: Shape {
    struct Corners: OptionSet {
        let rawValue: Int
        static let topLeading = Corners(rawValue: 1)
        static let topTrailing = Corners(rawValue: 2)
        static let bottomTrailing = Corners(rawValue: 4)
        static let bottomLeading = Corners(rawValue: 8)
    }

    var cuts: Corners
    var step: CGFloat = 4

    func path(in rect: CGRect) -> Path {
        // Clockwise: (corner, direction travelling into it, direction leaving it).
        let corners: [(Corners, CGPoint, CGVector, CGVector)] = [
            (.topLeading, CGPoint(x: rect.minX, y: rect.minY), CGVector(dx: 0, dy: -1), CGVector(dx: 1, dy: 0)),
            (.topTrailing, CGPoint(x: rect.maxX, y: rect.minY), CGVector(dx: 1, dy: 0), CGVector(dx: 0, dy: 1)),
            (.bottomTrailing, CGPoint(x: rect.maxX, y: rect.maxY), CGVector(dx: 0, dy: 1), CGVector(dx: -1, dy: 0)),
            (.bottomLeading, CGPoint(x: rect.minX, y: rect.maxY), CGVector(dx: -1, dy: 0), CGVector(dx: 0, dy: -1))
        ]
        var path = Path()
        var first = true
        func add(_ p: CGPoint) {
            if first { path.move(to: p); first = false } else { path.addLine(to: p) }
        }
        for (corner, p, a, b) in corners {
            if cuts.contains(corner) {
                func at(_ ka: CGFloat, _ kb: CGFloat) -> CGPoint {
                    CGPoint(x: p.x + step * (ka * a.dx + kb * b.dx), y: p.y + step * (ka * a.dy + kb * b.dy))
                }
                add(at(-2, 0)); add(at(-2, 1)); add(at(-1, 1)); add(at(-1, 2)); add(at(0, 2))
            } else {
                add(p)
            }
        }
        path.closeSubpath()
        return path
    }
}

/// Dashed tear line.
struct TearLine: View {
    var vertical = false

    var body: some View {
        Path { path in
            path.move(to: .zero)
            path.addLine(to: vertical ? CGPoint(x: 0, y: 1000) : CGPoint(x: 1000, y: 0))
        }
        .stroke(Theme.lineStrong, style: StrokeStyle(lineWidth: 1, dash: [4, 4]))
        .frame(width: vertical ? 1 : nil, height: vertical ? nil : 1)
        .clipped()
        .accessibilityHidden(true)
    }
}
