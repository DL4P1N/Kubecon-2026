import Foundation

/// Turn-by-turn state for one destination: the route polyline, its steps and how far along the user is.
struct Guidance: Equatable {
    var destinationID: String
    /// Polyline from where the route was planned, through each graph node, to the destination.
    var points: [CGPoint]
    /// One step per node leg, plus a final "arrived" step.
    var steps: [String]
    /// 1 when `points` starts with the planning position (not a node), else 0.
    var segmentOffset: Int
    /// Polyline segment being walked; `points.count - 1` means at the destination.
    var segment: Int

    var progress: Int { steps.isEmpty ? 0 : min(max(0, segment - segmentOffset), steps.count - 1) }
    var currentStep: String { steps.isEmpty ? "" : steps[progress] }
    var isFinished: Bool { segment >= points.count - 1 }

    /// The dashed line still to walk: the position, then every point ahead of it.
    func remainingPoints(from position: CGPoint) -> [CGPoint] {
        [position] + points.dropFirst(min(segment + 1, points.count))
    }

    func remainingDistance(from position: CGPoint) -> Double {
        let remaining = remainingPoints(from: position)
        return zip(remaining, remaining.dropFirst()).reduce(0) { $0 + hypot($1.1.x - $1.0.x, $1.1.y - $1.0.y) }
    }

    /// Segment of the polyline closest to `position`, with the distance to it in metres.
    func nearestSegment(to position: CGPoint) -> (index: Int, distance: Double) {
        guard points.count > 1 else {
            return (0, points.first.map { hypot($0.x - position.x, $0.y - position.y) } ?? .infinity)
        }
        var best = (index: 0, distance: Double.infinity)
        for index in 0..<(points.count - 1) {
            let a = points[index], b = points[index + 1]
            let dx = b.x - a.x, dy = b.y - a.y
            let lengthSquared = dx * dx + dy * dy
            let t = lengthSquared > 0 ? min(1, max(0, ((position.x - a.x) * dx + (position.y - a.y) * dy) / lengthSquared)) : 0
            let distance = hypot(position.x - (a.x + dx * t), position.y - (a.y + dy * t))
            // Ties at a corner favour the later segment so progress does not lag.
            if distance <= best.distance + 0.25 { best = (index, min(distance, best.distance)) }
        }
        return best
    }
}
