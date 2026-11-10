import Foundation

struct CrowdPerson: Identifiable, Equatable {
    let id: Int
    var point: CGPoint
    let avatar: Avatar
}

/// Deterministic simulated attendees walking between rooms along the same route graph.
struct CrowdSimulation {
    private struct Walker {
        let avatar: Avatar
        let path: [CGPoint]
        let cumulative: [Double]
        let total: Double
        let speed: Double
        let offset: Double
        let jitter: CGPoint
    }

    private let walkers: [Walker]

    init(count: Int = 16) {
        var state: UInt64 = 0x9E3779B97F4A7C15
        func next() -> Double {
            state = state &* 6364136223846793005 &+ 1442695040888963407
            return Double(state >> 33) / Double(1 << 31)
        }
        func pick<T>(_ items: [T]) -> T { items[min(items.count - 1, Int(next() * Double(items.count)))] }

        let roomNodes = ["n-stage", "n-a", "n-b", "n-lobby", "n-lounge"]
        var built: [Walker] = []
        for _ in 0..<count {
            var stops = [pick(roomNodes)]
            while stops.count < 4 {
                let candidate = pick(roomNodes)
                if candidate != stops.last { stops.append(candidate) }
            }
            if stops.last == stops.first { stops.removeLast() }
            var ids: [String] = []
            let loop = stops + [stops[0]]
            for (from, to) in zip(loop, loop.dropFirst()) {
                guard let leg = Router.shortestPath(from: from, to: to) else { continue }
                ids.append(contentsOf: ids.isEmpty ? leg : Array(leg.dropFirst()))
            }
            let points = ids.compactMap { FloorPlan.node($0)?.point }
            var cumulative: [Double] = [0]
            for (a, b) in zip(points, points.dropFirst()) { cumulative.append(cumulative.last! + hypot(b.x - a.x, b.y - a.y)) }
            let total = cumulative.last ?? 0
            let avatar = Avatar(
                skin: pick(Avatar.skins), hair: pick(Avatar.hairs), shirt: pick(Avatar.shirts),
                pants: pick(Avatar.pantsOptions), cap: next() < 0.3
            )
            let speed = 0.9 + next() * 0.6
            let offset = next() * max(total, 1)
            let jitter = CGPoint(x: (next() - 0.5) * 1.2, y: (next() - 0.5) * 1.2)
            if points.count > 1, total > 0 {
                built.append(Walker(avatar: avatar, path: points, cumulative: cumulative, total: total, speed: speed, offset: offset, jitter: jitter))
            }
        }
        walkers = built
    }

    func people(clock: Double, reduceMotion: Bool) -> [CrowdPerson] {
        let time = reduceMotion ? (clock / 4).rounded(.down) * 4 : clock
        return walkers.enumerated().map { index, walker in
            let distance = (walker.offset + walker.speed * time).truncatingRemainder(dividingBy: walker.total)
            var segment = 0
            while segment < walker.cumulative.count - 2, walker.cumulative[segment + 1] < distance { segment += 1 }
            let start = walker.path[segment], end = walker.path[segment + 1]
            let length = walker.cumulative[segment + 1] - walker.cumulative[segment]
            let t = length > 0 ? (distance - walker.cumulative[segment]) / length : 0
            let point = CGPoint(x: start.x + (end.x - start.x) * t + walker.jitter.x, y: start.y + (end.y - start.y) * t + walker.jitter.y)
            return CrowdPerson(id: index, point: point, avatar: walker.avatar)
        }
    }
}
