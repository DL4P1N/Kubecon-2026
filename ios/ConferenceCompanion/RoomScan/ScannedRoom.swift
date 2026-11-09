import Foundation

/// A scanned room reduced to a 2D floor plan in metres. Pure value type: no RoomPlan dependency.
struct ScannedRoom: Codable, Identifiable, Hashable, Sendable {
    var id: UUID
    var name: String
    var createdAt: Date
    /// Walls in the room frame, rotated so the longest wall is horizontal, min corner at (0, 0).
    var walls: [WallSegment]
    /// Floor outline: ordered corners when the walls close into a loop, otherwise the bounding box.
    var outline: [Point2D]
    var openings: [OpeningMark]
    var width: Double
    var depth: Double
    var areaM2: Double
    /// True when the walls did not form a closed loop and the area is the bounding box.
    var approximate: Bool
    var ceilingHeight: Double
    var wallCount: Int
    var doorCount: Int
    var windowCount: Int
    var openingCount: Int
    var receiverSpots: [Point2D]

    var doors: [OpeningMark] { openings.filter { $0.kind == .door } }

    /// Pairwise distances between suggested receivers, in metres: (0-1, 1-2, 0-2).
    var receiverDistances: [(from: Int, to: Int, metres: Double)] {
        guard receiverSpots.count == 3 else { return [] }
        return [(0, 1), (1, 2), (0, 2)].map { ($0.0, $0.1, receiverSpots[$0.0].distance(to: receiverSpots[$0.1])) }
    }

    /// Plain-language description for VoiceOver and the detail text.
    var summary: String {
        let area = approximate ? "about \(Self.fmt(areaM2)) square metres (bounding box)" : "\(Self.fmt(areaM2)) square metres"
        return "\(Self.fmt(width)) by \(Self.fmt(depth)) metres, \(area), ceiling \(Self.fmt(ceilingHeight)) metres. "
            + "\(wallCount) walls, \(doorCount) doors, \(windowCount) windows, \(openingCount) openings."
    }

    static func fmt(_ v: Double) -> String {
        (v.isFinite ? v : 0).formatted(.number.precision(.fractionLength(1)))
    }

    // MARK: Building from raw surfaces

    /// Returns nil when there are no usable walls.
    static func make(
        name: String = "",
        date: Date = Date(),
        walls: [SurfaceInput],
        doors: [SurfaceInput] = [],
        windows: [SurfaceInput] = [],
        openings: [SurfaceInput] = []
    ) -> ScannedRoom? {
        let goodWalls = walls.filter(\.isValid)
        guard let longest = goodWalls.max(by: { $0.width < $1.width }) else { return nil }

        // Rotate so the longest wall runs along +x.
        let lu = longest.unitDirection
        let theta = atan2(lu.z, lu.x)
        let c = cos(theta), s = sin(theta)
        func rot(_ x: Double, _ z: Double) -> Point2D { Point2D(x: x * c + z * s, y: -x * s + z * c) }

        var segments: [WallSegment] = goodWalls.map { w in
            let u = w.unitDirection
            let ax = w.centerX - u.x * w.width / 2, az = w.centerZ - u.z * w.width / 2
            let bx = w.centerX + u.x * w.width / 2, bz = w.centerZ + u.z * w.width / 2
            return WallSegment(a: rot(ax, az), b: rot(bx, bz), height: max(0, w.height))
        }
        let points = segments.flatMap { [$0.a, $0.b] }
        let minX = points.map(\.x).min() ?? 0, maxX = points.map(\.x).max() ?? 0
        let minY = points.map(\.y).min() ?? 0, maxY = points.map(\.y).max() ?? 0
        func shift(_ p: Point2D) -> Point2D { Point2D(x: p.x - minX, y: p.y - minY) }
        segments = segments.map { WallSegment(a: shift($0.a), b: shift($0.b), height: $0.height) }

        let width = maxX - minX, depth = maxY - minY
        guard width.isFinite, depth.isFinite else { return nil }

        func marks(_ list: [SurfaceInput], _ kind: OpeningMark.Kind) -> [OpeningMark] {
            list.filter(\.isValid).map { o in
                let u = o.unitDirection
                let d = rot(u.x, u.z)   // rotation of a direction vector
                return OpeningMark(kind: kind, position: shift(rot(o.centerX, o.centerZ)), dx: d.x, dy: d.y, width: o.width)
            }
        }
        let doorMarks = marks(doors, .door), windowMarks = marks(windows, .window), openingMarks = marks(openings, .opening)

        let loop = orderedLoop(segments)
        let outline: [Point2D]
        let area: Double
        let approximate: Bool
        if let loop, abs(shoelace(loop)) > 0.5 {
            outline = loop
            area = abs(shoelace(loop))
            approximate = false
        } else {
            outline = [Point2D(x: 0, y: 0), Point2D(x: width, y: 0), Point2D(x: width, y: depth), Point2D(x: 0, y: depth)]
            area = width * depth
            approximate = true
        }

        var room = ScannedRoom(
            id: UUID(), name: name, createdAt: date,
            walls: segments, outline: outline,
            openings: doorMarks + windowMarks + openingMarks,
            width: width, depth: depth,
            areaM2: area.isFinite ? area : 0, approximate: approximate,
            ceilingHeight: segments.map(\.height).max() ?? 0,
            wallCount: goodWalls.count,
            doorCount: doorMarks.count, windowCount: windowMarks.count, openingCount: openingMarks.count,
            receiverSpots: []
        )
        room.receiverSpots = ReceiverPlanner.suggest(outline: outline, in: room)
        return room
    }

    /// Area by the shoelace formula (signed).
    static func shoelace(_ pts: [Point2D]) -> Double {
        guard pts.count >= 3 else { return 0 }
        var sum = 0.0
        for i in pts.indices {
            let p = pts[i], q = pts[(i + 1) % pts.count]
            sum += p.x * q.y - q.x * p.y
        }
        let v = sum / 2
        return v.isFinite ? v : 0
    }

    /// Chains wall segments end to start, nearest first. Returns the corner list only when every wall
    /// is used and the chain closes within `tolerance` metres; otherwise nil.
    static func orderedLoop(_ segments: [WallSegment], tolerance: Double = 0.6) -> [Point2D]? {
        guard segments.count >= 3 else { return nil }
        var remaining = segments
        var first = remaining.removeFirst()
        // Orient the first wall so that its end is nearer to some other wall.
        var corners = [first.a]
        var end = first.b
        let start = first.a
        first = WallSegment(a: first.a, b: first.b, height: first.height)
        while !remaining.isEmpty {
            var bestIndex = -1, bestFlip = false, bestDist = Double.infinity
            for (i, w) in remaining.enumerated() {
                let da = end.distance(to: w.a), db = end.distance(to: w.b)
                if da < bestDist { bestDist = da; bestIndex = i; bestFlip = false }
                if db < bestDist { bestDist = db; bestIndex = i; bestFlip = true }
            }
            guard bestIndex >= 0, bestDist <= tolerance else { return nil }
            let w = remaining.remove(at: bestIndex)
            corners.append(bestFlip ? w.b : w.a)
            end = bestFlip ? w.a : w.b
        }
        guard end.distance(to: start) <= tolerance else { return nil }
        return corners
    }
}
