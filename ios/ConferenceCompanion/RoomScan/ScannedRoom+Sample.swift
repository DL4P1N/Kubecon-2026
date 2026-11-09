import Foundation

extension ScannedRoom {
    /// A 9 x 7 m room with two doors and a window, for previews and the simulator.
    static var sample: ScannedRoom {
        func wall(_ cx: Double, _ cz: Double, _ dx: Double, _ dz: Double, _ w: Double) -> SurfaceInput {
            SurfaceInput(centerX: cx, centerZ: cz, dirX: dx, dirZ: dz, width: w, height: 3.2)
        }
        let walls = [
            wall(4.5, 0, 1, 0, 9), wall(9, 3.5, 0, 1, 7),
            wall(4.5, 7, 1, 0, 9), wall(0, 3.5, 0, 1, 7),
        ]
        let doors = [
            SurfaceInput(centerX: 2, centerZ: 7, dirX: 1, dirZ: 0, width: 1.0, height: 2.1),
            SurfaceInput(centerX: 9, centerZ: 2, dirX: 0, dirZ: 1, width: 1.0, height: 2.1),
        ]
        let windows = [SurfaceInput(centerX: 6, centerZ: 0, dirX: 1, dirZ: 0, width: 1.8, height: 1.2)]
        return make(name: "Sample hall", walls: walls, doors: doors, windows: windows)
            ?? ScannedRoom(id: UUID(), name: "Sample", createdAt: Date(), walls: [], outline: [], openings: [],
                           width: 9, depth: 7, areaM2: 63, approximate: true, ceilingHeight: 3.2,
                           wallCount: 4, doorCount: 2, windowCount: 1, openingCount: 0, receiverSpots: [])
    }
}
