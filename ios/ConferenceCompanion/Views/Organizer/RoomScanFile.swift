import SwiftUI
import UniformTypeIdentifiers

/// The JSON for a scan, shared as a .json file.
struct RoomScanFile: Transferable {
    let room: ScannedRoom

    static var transferRepresentation: some TransferRepresentation {
        DataRepresentation(exportedContentType: .json) { file in
            try RoomScanStore.encoder.encode(file.room)
        }
        .suggestedFileName { file in
            let base = file.room.name.trimmingCharacters(in: .whitespacesAndNewlines)
            return (base.isEmpty ? "room-scan" : base) + ".json"
        }
    }
}
