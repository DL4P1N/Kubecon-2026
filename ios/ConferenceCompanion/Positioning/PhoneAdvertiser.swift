import CoreBluetooth
import Foundation
import Observation

/// Advertises only a random per-ticket service UUID, never a name or attendee ID.
@MainActor @Observable
final class PhoneAdvertiser: NSObject, CBPeripheralManagerDelegate {
    private(set) var isAdvertising = false
    private(set) var state: CBManagerState = .unknown

    @ObservationIgnored private var manager: CBPeripheralManager?
    @ObservationIgnored private var uuid: UUID?

    func enable(uuid: UUID) {
        self.uuid = uuid
        if manager == nil {
            manager = CBPeripheralManager(delegate: self, queue: nil, options: [CBPeripheralManagerOptionShowPowerAlertKey: false])
        } else {
            startIfReady()
        }
    }

    func disable() {
        uuid = nil
        manager?.stopAdvertising()
        isAdvertising = false
    }

    private func startIfReady() {
        guard let manager, manager.state == .poweredOn, let uuid else { return }
        manager.stopAdvertising()
        manager.startAdvertising([CBAdvertisementDataServiceUUIDsKey: [CBUUID(nsuuid: uuid)]])
    }

    nonisolated func peripheralManagerDidUpdateState(_ peripheral: CBPeripheralManager) {
        let newState = peripheral.state
        MainActor.assumeIsolated {
            state = newState
            startIfReady()
        }
    }

    nonisolated func peripheralManagerDidStartAdvertising(_ peripheral: CBPeripheralManager, error: Error?) {
        let ok = error == nil
        MainActor.assumeIsolated { isAdvertising = ok }
    }
}
