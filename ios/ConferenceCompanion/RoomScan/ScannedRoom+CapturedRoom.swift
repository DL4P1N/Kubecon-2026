import Foundation
import RoomPlan

extension SurfaceInput {
    init(_ surface: CapturedRoom.Surface) {
        let t = surface.transform
        self.init(
            centerX: Double(t.columns.3.x), centerZ: Double(t.columns.3.z),
            dirX: Double(t.columns.0.x), dirZ: Double(t.columns.0.z),
            width: Double(surface.dimensions.x), height: Double(surface.dimensions.y)
        )
    }
}

extension ScannedRoom {
    /// Builds a floor plan from a finished RoomPlan capture. Nil when no walls were found.
    static func from(_ room: CapturedRoom, name: String = "") -> ScannedRoom? {
        make(
            name: name,
            walls: room.walls.map(SurfaceInput.init),
            doors: room.doors.map(SurfaceInput.init),
            windows: room.windows.map(SurfaceInput.init),
            openings: room.openings.map(SurfaceInput.init)
        )
    }
}
