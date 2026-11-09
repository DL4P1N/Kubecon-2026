import Foundation

struct Anchor: Equatable, Sendable {
    var x: Double
    var y: Double
    var distance: Double
}

struct PositionFix: Equatable, Sendable {
    var x: Double
    var y: Double
    /// Radius in metres of the accuracy ring.
    var accuracy: Double

    var point: CGPoint { CGPoint(x: x, y: y) }
}

/// Pure positioning maths: log-distance path loss plus weighted least squares.
enum Trilateration {
    static let txPowerAtOneMetre = -59.0
    static let pathLossExponent = 2.2

    static func distance(rssi: Double, txPower: Double = txPowerAtOneMetre, exponent: Double = pathLossExponent) -> Double {
        guard rssi.isFinite, exponent > 0 else { return 1 }
        return min(max(pow(10, (txPower - rssi) / (10 * exponent)), 0.1), 60)
    }

    /// Weighted (1/d^2) Gauss-Newton fit. Needs at least three non-collinear anchors.
    static func locate(anchors rawAnchors: [Anchor]) -> PositionFix? {
        // Drop anything non-finite or nonsensical, then require three distinct, non-collinear receivers.
        let anchors = rawAnchors.filter { $0.x.isFinite && $0.y.isFinite && $0.distance.isFinite && $0.distance >= 0 }
        guard anchors.count >= 3, !areCollinear(anchors) else { return nil }
        let weights = anchors.map { 1 / pow(max($0.distance, 0.5), 2) }
        let totalWeight = weights.reduce(0, +)
        guard totalWeight > 0 else { return nil }
        var px = zip(anchors, weights).reduce(0) { $0 + $1.0.x * $1.1 } / totalWeight
        var py = zip(anchors, weights).reduce(0) { $0 + $1.0.y * $1.1 } / totalWeight

        for _ in 0..<30 {
            var a = 0.0, b = 0.0, d = 0.0, gx = 0.0, gy = 0.0
            for (anchor, weight) in zip(anchors, weights) {
                let dx = px - anchor.x, dy = py - anchor.y
                let range = max(hypot(dx, dy), 1e-6)
                let residual = range - anchor.distance
                let jx = dx / range, jy = dy / range
                a += weight * jx * jx
                b += weight * jx * jy
                d += weight * jy * jy
                gx += weight * jx * residual
                gy += weight * jy * residual
            }
            let determinant = a * d - b * b
            guard abs(determinant) > 1e-9 * max(1, a * d) else { return nil }
            var stepX = -(d * gx - b * gy) / determinant
            var stepY = -(-b * gx + a * gy) / determinant
            let length = hypot(stepX, stepY)
            if length > 5 { stepX *= 5 / length; stepY *= 5 / length }
            px += stepX
            py += stepY
            if length < 1e-4 { break }
        }
        guard px.isFinite, py.isFinite else { return nil }
        // Keep the fix on the plan (a little slack outside the walls).
        px = min(max(px, -2), FloorPlan.size.width + 2)
        py = min(max(py, -2), FloorPlan.size.height + 2)
        let meanSquare = anchors.reduce(0) { sum, anchor in
            let error = hypot(px - anchor.x, py - anchor.y) - anchor.distance
            return sum + error * error
        } / Double(anchors.count)
        let accuracy = meanSquare.squareRoot()
        guard accuracy.isFinite else { return nil }
        return PositionFix(x: px, y: py, accuracy: min(max(1, accuracy), 12))
    }

    /// True when no three anchors span a meaningful triangle (area under 1 m squared), e.g. all in a line.
    static func areCollinear(_ anchors: [Anchor]) -> Bool {
        guard anchors.count >= 3 else { return true }
        for i in 0..<anchors.count {
            for j in (i + 1)..<anchors.count {
                for k in (j + 1)..<anchors.count {
                    let a = anchors[i], b = anchors[j], c = anchors[k]
                    let twiceArea = abs((b.x - a.x) * (c.y - a.y) - (c.x - a.x) * (b.y - a.y))
                    if twiceArea >= 2 { return false }
                }
            }
        }
        return true
    }
}

/// Exponential smoothing for fixes and RSSI.
struct PositionSmoother {
    var alpha = 0.35
    private(set) var state: PositionFix?

    mutating func update(_ fix: PositionFix?) -> PositionFix? {
        guard let fix else { return state }
        guard let previous = state else { state = fix; return fix }
        let next = PositionFix(
            x: previous.x + alpha * (fix.x - previous.x),
            y: previous.y + alpha * (fix.y - previous.y),
            accuracy: previous.accuracy + alpha * (fix.accuracy - previous.accuracy)
        )
        state = next
        return next
    }

    mutating func reset() { state = nil }
}

enum ExponentialSmoothing {
    static func next(previous: Double?, sample: Double, alpha: Double = 0.25) -> Double {
        guard let previous else { return sample }
        return previous + alpha * (sample - previous)
    }
}
