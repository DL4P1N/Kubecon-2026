import Foundation

/// A point on the floor plan, in metres. x runs along the room's longest wall, y across it.
struct Point2D: Codable, Hashable, Sendable {
    var x: Double
    var y: Double

    func distance(to other: Point2D) -> Double {
        let d = ((x - other.x) * (x - other.x) + (y - other.y) * (y - other.y)).squareRoot()
        return d.isFinite ? d : 0
    }
}

/// One wall as a segment in the room's local frame, plus its height.
struct WallSegment: Codable, Hashable, Sendable {
    var a: Point2D
    var b: Point2D
    var height: Double
}

/// A door, window or opening placed along a wall. `direction` is the unit vector along the wall.
struct OpeningMark: Codable, Hashable, Sendable {
    enum Kind: String, Codable, Sendable { case door, window, opening }
    var kind: Kind
    var position: Point2D
    var dx: Double
    var dy: Double
    var width: Double
}
