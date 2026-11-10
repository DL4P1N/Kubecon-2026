import CoreBluetooth
import SwiftUI

struct BluetoothStatusBanner: View {
    let state: CBManagerState
    let authorization: CBManagerAuthorization
    @Environment(\.openURL) private var openURL

    private var message: String? {
        if authorization == .denied || authorization == .restricted || state == .unauthorized {
            return "Bluetooth access is off for this app, so only simulated signals are shown."
        }
        switch state {
        case .poweredOff: return "Bluetooth is turned off. Turn it on to see real nearby devices."
        case .unsupported: return "This device does not support Bluetooth scanning."
        default: return nil
        }
    }

    var body: some View {
        if let message {
            VStack(alignment: .leading, spacing: 10) {
                Text(message).font(.mono(.footnote))
                if state != .unsupported {
                    Button("Open Settings") {
                        if let url = URL(string: UIApplication.openSettingsURLString) { openURL(url) }
                    }
                    .buttonStyle(.ccQuiet)
                }
            }
            .panel()
        }
    }
}
