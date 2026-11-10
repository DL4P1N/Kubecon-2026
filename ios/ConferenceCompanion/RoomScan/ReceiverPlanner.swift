import Foundation

/// Suggests three receiver spots on the walls: a deterministic geometric heuristic, not a radio survey.
/// Candidates are points along the walls, nudged slightly inside; the triple with the largest triangle
/// whose edges stay inside the outline wins.
enum ReceiverPlanner {
    static func suggest(outline: [Point2D], in room: ScannedRoom) -> [Point2D] {
        guard outline.count >= 3 else { return [] }
        let candidates = candidatePoints(outline: outline)
        guard candidates.count >= 3 else { return [] }

        var best: (area: Double, ids: [Int])?
        for i in 0..<candidates.count {
            for j in (i + 1)..<candidates.count {
                for k in (j + 1)..<candidates.count {
                    let area = triangleArea(candidates[i], candidates[j], candidates[k])
                    guard area.isFinite, area > (best?.area ?? 0) else { continue }
                    guard insideAll(outline, candidates[i], candidates[j], candidates[k]) else { continue }
                    best = (area, [i, j, k])
                }
            }
        }
        guard let ids = best?.ids else { return [] }
        // Stable order: left to right, then top to bottom.
        return ids.map { candidates[$0] }.sorted { ($0.x, $0.y) < ($1.x, $1.y) }
    }

    static func triangleArea(_ a: Point2D, _ b: Point2D, _ c: Point2D) -> Double {
        abs((b.x - a.x) * (c.y - a.y) - (c.x - a.x) * (b.y - a.y)) / 2
    }

    private static func candidatePoints(outline: [Point2D]) -> [Point2D] {
        let cx = outline.map(\.x).reduce(0, +) / Double(outline.count)
        let cy = outline.map(\.y).reduce(0, +) / Double(outline.count)
        let centroid = Point2D(x: cx, y: cy)
        var pts: [Point2D] = []
        let perimeter = outline.indices.map { outline[$0].distance(to: outline[($0 + 1) % outline.count]) }.reduce(0, +)
        guard perimeter > 0.1 else { return [] }
        let step = max(0.5, perimeter / 100)   // at most ~100 candidates
        for i in outline.indices {
            let p = outline[i], q = outline[(i + 1) % outline.count]
            let len = p.distance(to: q)
            guard len > 0.05 else { continue }
            let n = max(1, Int((len / step).rounded()))
            for s in 0...n {
                let t = Double(s) / Double(n)
                let on = Point2D(x: p.x + (q.x - p.x) * t, y: p.y + (q.y - p.y) * t)
                // Nudge 0.15 m toward the centroid so the point sits just inside the wall.
                let d = on.distance(to: centroid)
                let nudge = d > 0.3 ? 0.15 / d : 0
                pts.append(Point2D(x: on.x + (centroid.x - on.x) * nudge, y: on.y + (centroid.y - on.y) * nudge))
            }
        }
        return pts
    }

    private static func insideAll(_ outline: [Point2D], _ a: Point2D, _ b: Point2D, _ c: Point2D) -> Bool {
        func mid(_ p: Point2D, _ q: Point2D) -> Point2D { Point2D(x: (p.x + q.x) / 2, y: (p.y + q.y) / 2) }
        let centroid = Point2D(x: (a.x + b.x + c.x) / 3, y: (a.y + b.y + c.y) / 3)
        return [mid(a, b), mid(b, c), mid(a, c), centroid].allSatisfy { contains(outline, $0) }
    }

    /// Ray-casting point-in-polygon.
    static func contains(_ poly: [Point2D], _ p: Point2D) -> Bool {
        var inside = false
        var j = poly.count - 1
        for i in poly.indices {
            let a = poly[i], b = poly[j]
            if (a.y > p.y) != (b.y > p.y), p.x < (b.x - a.x) * (p.y - a.y) / (b.y - a.y) + a.x { inside.toggle() }
            j = i
        }
        return inside
    }
}
