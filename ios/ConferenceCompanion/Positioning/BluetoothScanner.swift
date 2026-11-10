import CoreBluetooth
import Foundation
import Observation

struct NearbyDevice: Identifiable, Equatable {
    let id: UUID
    var name: String?
    /// Exponentially smoothed RSSI in dBm.
    var rssi: Double
    var lastSeen: Date

    var displayName: String { name ?? "Unnamed \(id.uuidString.suffix(4))" }
}

@MainActor @Observable
final class BluetoothScanner: NSObject, CBCentralManagerDelegate {
    private(set) var devices: [UUID: NearbyDevice] = [:]
    private(set) var state: CBManagerState = .unknown
    private(set) var authorization: CBManagerAuthorization = CBCentralManager.authorization

    @ObservationIgnored private var central: CBCentralManager?
    @ObservationIgnored private var table: [UUID: NearbyDevice] = [:]
    @ObservationIgnored private var publishTask: Task<Void, Never>?
    @ObservationIgnored private var wantsScan = false

    var isReady: Bool { state == .poweredOn }

    /// Nearby, freshest first by signal.
    func visible(at date: Date = .now) -> [NearbyDevice] {
        devices.values.filter { date.timeIntervalSince($0.lastSeen) < 10 }.sorted { $0.rssi > $1.rssi }
    }

    func start() {
        wantsScan = true
        if central == nil {
            central = CBCentralManager(delegate: self, queue: nil, options: [CBCentralManagerOptionShowPowerAlertKey: false])
        } else {
            beginScanIfReady()
        }
        if publishTask == nil {
            publishTask = Task { [weak self] in
                while !Task.isCancelled {
                    self?.publish()
                    try? await Task.sleep(for: .milliseconds(500))
                }
            }
        }
    }

    func stop() {
        wantsScan = false
        central?.stopScan()
        publishTask?.cancel()
        publishTask = nil
    }

    private func beginScanIfReady() {
        guard wantsScan, let central, central.state == .poweredOn, !central.isScanning else { return }
        central.scanForPeripherals(withServices: nil, options: [CBCentralManagerScanOptionAllowDuplicatesKey: true])
    }

    private func publish() {
        let cutoff = Date.now.addingTimeInterval(-30)
        table = table.filter { $0.value.lastSeen > cutoff }
        devices = table
    }

    private func record(id: UUID, name: String?, rssi: Double) {
        var device = table[id] ?? NearbyDevice(id: id, name: name, rssi: rssi, lastSeen: .now)
        device.rssi = ExponentialSmoothing.next(previous: table[id]?.rssi, sample: rssi)
        device.lastSeen = .now
        if let name, !name.isEmpty { device.name = name }
        table[id] = device
    }

    nonisolated func centralManagerDidUpdateState(_ central: CBCentralManager) {
        let newState = central.state
        let auth = CBCentralManager.authorization
        MainActor.assumeIsolated {
            state = newState
            authorization = auth
            beginScanIfReady()
        }
    }

    nonisolated func centralManager(_ central: CBCentralManager, didDiscover peripheral: CBPeripheral, advertisementData: [String: Any], rssi RSSI: NSNumber) {
        let value = RSSI.doubleValue
        guard value < 0, value > -120 else { return } // 127 means "unavailable"
        let id = peripheral.identifier
        let name = (advertisementData[CBAdvertisementDataLocalNameKey] as? String) ?? peripheral.name
        MainActor.assumeIsolated { record(id: id, name: name, rssi: value) }
    }
}
