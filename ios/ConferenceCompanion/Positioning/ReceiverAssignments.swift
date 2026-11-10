import Foundation
import Observation

/// Which visible Bluetooth device stands in for which venue receiver (set on the Calibrate screen).
@MainActor @Observable
final class ReceiverAssignments {
    private(set) var map: [String: UUID] = [:]
    @ObservationIgnored private let key = "receiverAssignments"

    init() {
        if let stored = UserDefaults.standard.dictionary(forKey: key) as? [String: String] {
            map = stored.compactMapValues { UUID(uuidString: $0) }
        }
    }

    func assign(receiverID: String, deviceID: UUID) {
        map = map.filter { $0.value != deviceID && $0.key != receiverID }
        map[receiverID] = deviceID
        persist()
    }

    func clear(receiverID: String) {
        map[receiverID] = nil
        persist()
    }

    func clearAll() {
        map = [:]
        persist()
    }

    private func persist() {
        UserDefaults.standard.set(map.mapValues(\.uuidString), forKey: key)
    }
}
