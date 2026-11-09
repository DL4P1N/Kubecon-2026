import Foundation
import Observation

/// Saved scans as one JSON file each in Application Support/RoomScans.
@MainActor
@Observable
final class RoomScanStore {
    private(set) var scans: [ScannedRoom] = []
    var lastError: String?

    private let directory: URL

    init(directory: URL? = nil) {
        let base = directory ?? (FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? FileManager.default.temporaryDirectory).appending(path: "RoomScans", directoryHint: .isDirectory)
        self.directory = base
        load()
    }

    func load() {
        let fm = FileManager.default
        try? fm.createDirectory(at: directory, withIntermediateDirectories: true)
        let files = (try? fm.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil)) ?? []
        let decoder = Self.decoder
        scans = files.filter { $0.pathExtension == "json" }
            .compactMap { try? decoder.decode(ScannedRoom.self, from: Data(contentsOf: $0)) }
            .sorted { $0.createdAt > $1.createdAt }
    }

    func save(_ room: ScannedRoom) {
        do {
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            let data = try Self.encoder.encode(room)
            try data.write(to: url(for: room), options: .atomic)
            if let i = scans.firstIndex(where: { $0.id == room.id }) { scans[i] = room } else { scans.insert(room, at: 0) }
            lastError = nil
        } catch {
            lastError = "Could not save the scan: \(error.localizedDescription)"
        }
    }

    func delete(_ room: ScannedRoom) {
        try? FileManager.default.removeItem(at: url(for: room))
        scans.removeAll { $0.id == room.id }
    }

    private func url(for room: ScannedRoom) -> URL {
        directory.appending(path: "\(room.id.uuidString).json")
    }

    nonisolated static var encoder: JSONEncoder {
        let e = JSONEncoder()
        e.outputFormatting = [.prettyPrinted, .sortedKeys]
        e.dateEncodingStrategy = .iso8601
        return e
    }

    nonisolated static var decoder: JSONDecoder {
        let d = JSONDecoder()
        d.dateDecodingStrategy = .iso8601
        return d
    }

    /// JSON for sharing.
    static func json(for room: ScannedRoom) -> String {
        (try? String(data: encoder.encode(room), encoding: .utf8)) ?? "{}"
    }
}
