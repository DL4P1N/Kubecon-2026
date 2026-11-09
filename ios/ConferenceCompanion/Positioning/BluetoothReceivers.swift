import Foundation

/// Real scan: trilaterates from devices assigned to receivers (or advertising a receiver's name).
@MainActor
final class BluetoothReceivers: PositionSource {
    let tag = "Live Bluetooth"
    private let scanner: BluetoothScanner
    private let receivers: [VenueReceiver]
    private let assignments: ReceiverAssignments
    private var smoother = PositionSmoother()

    init(scanner: BluetoothScanner, receivers: [VenueReceiver], assignments: ReceiverAssignments) {
        self.scanner = scanner
        self.receivers = receivers
        self.assignments = assignments
    }

    func anchors(at date: Date) -> [Anchor] {
        receivers.compactMap { receiver in
            let device: NearbyDevice?
            if let id = assignments.map[receiver.id] {
                device = scanner.devices[id]
            } else {
                device = scanner.devices.values.first { $0.name == receiver.name }
            }
            guard let device, date.timeIntervalSince(device.lastSeen) < 8 else { return nil }
            return Anchor(x: receiver.x, y: receiver.y, distance: Trilateration.distance(rssi: device.rssi))
        }
    }

    func fix(at date: Date) -> PositionFix? {
        let found = anchors(at: date)
        guard found.count >= 3, let raw = Trilateration.locate(anchors: found) else {
            smoother.reset()
            return nil
        }
        return smoother.update(raw)
    }
}
