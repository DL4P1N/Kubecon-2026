import Foundation

/// A RoomPlan surface reduced to plain numbers so the geometry is testable without RoomPlan.
/// Wall and door transforms: column 3 is the centre, column 0 runs along the width.
struct SurfaceInput: Sendable, Equatable {
    var centerX: Double
    var centerZ: Double
    /// Direction of the surface's width axis projected onto the floor (x, z). Need not be normalised.
    var dirX: Double
    var dirZ: Double
    var width: Double
    var height: Double

    /// Finite numbers, positive width and a usable direction.
    var isValid: Bool {
        let nums = [centerX, centerZ, dirX, dirZ, width, height]
        guard nums.allSatisfy(\.isFinite), width > 0.05 else { return false }
        return (dirX * dirX + dirZ * dirZ) > 1e-9
    }

    var unitDirection: (x: Double, z: Double) {
        let len = (dirX * dirX + dirZ * dirZ).squareRoot()
        guard len > 1e-9 else { return (1, 0) }
        return (dirX / len, dirZ / len)
    }
}
