import Foundation

/// A simulated phone: wanders a loop through the venue, or walks the route to the chosen room.
@MainActor
final class SimulatedWalk: PositionSource {
    let tag = "Simulated signals"
    static let start = CGPoint(x: 5, y: 18)

    private(set) var position = SimulatedWalk.start
    /// Walking speed in metres per second (brisk, so a demo route takes about 15 seconds).
    private let speed = 2.0

    private let loop: [CGPoint] = [
        CGPoint(x: 7, y: 12), CGPoint(x: 19.5, y: 12), CGPoint(x: 19.5, y: 6), CGPoint(x: 19.5, y: 12),
        CGPoint(x: 25, y: 12), CGPoint(x: 25, y: 18), CGPoint(x: 25, y: 12), CGPoint(x: 30.5, y: 12),
        CGPoint(x: 30.5, y: 6), CGPoint(x: 30.5, y: 12), CGPoint(x: 7, y: 12), CGPoint(x: 7, y: 6),
        CGPoint(x: 7, y: 12), CGPoint(x: 5, y: 18)
    ]
    private var loopIndex = 0
    /// Points still to walk when heading for a destination; nil means wander the loop.
    private var legs: [CGPoint]?

    func reset() {
        position = SimulatedWalk.start
        loopIndex = 0
        legs = nil
    }

    /// Head for these points in order (the first one the walker is already past is dropped by the caller).
    func follow(_ points: [CGPoint]?) { legs = points }

    func advance(by seconds: Double) {
        guard seconds > 0, seconds.isFinite else { return }
        var budget = speed * seconds
        var guardCount = 0
        while budget > 0, guardCount < 64 {
            guardCount += 1
            let target: CGPoint
            if let current = legs {
                guard let next = current.first else { return } // arrived; stand still
                target = next
            } else {
                target = loop[loopIndex % loop.count]
            }
            let dx = target.x - position.x, dy = target.y - position.y
            let distance = hypot(dx, dy)
            if distance <= budget {
                position = target
                budget -= distance
                if legs != nil { legs?.removeFirst() } else { loopIndex += 1 }
            } else {
                position = CGPoint(x: position.x + dx / distance * budget, y: position.y + dy / distance * budget)
                budget = 0
            }
        }
    }

    func fix(at date: Date) -> PositionFix? {
        PositionFix(x: position.x, y: position.y, accuracy: 2.5)
    }
}
