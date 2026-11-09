import SwiftUI
import UIKit

/// Content layer for the venue network: the network row, join result and the QR/password fallback.
/// The "Join venue Wi-Fi" action itself lives in the floating glass cluster on the ticket.
struct WiFiSection: View {
    let network: WiFiNetwork
    let message: String?
    @Binding var showFallback: Bool
    @State private var copied = false

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            SectionTitle("Venue Wi-Fi")
            VStack(alignment: .leading, spacing: 4) {
                Text(network.assumed == false ? "Venue network" : "Demo network")
                    .font(.mono(.caption, weight: .semibold))
                    .foregroundStyle(network.assumed == false ? Theme.accent : Theme.warn)
                Text(network.ssid).font(.mono(.headline)).monospacedDigit()
            }
            .panel()
            .accessibilityElement(children: .combine)

            if let message {
                Text(message).font(.footnote).foregroundStyle(Theme.muted)
            }

            DisclosureGroup("Other ways to connect", isExpanded: $showFallback) {
                VStack(alignment: .leading, spacing: 12) {
                    Text("Scan with the Camera app on another device, or copy the password.")
                        .font(.footnote)
                        .foregroundStyle(Theme.muted)
                    QRView(text: WiFiPayload.string(for: network), label: "Wi-Fi QR code for \(network.ssid)")
                        .frame(maxWidth: 240)
                    Button(copied ? "Password copied" : "Copy password", systemImage: "doc.on.doc") {
                        UIPasteboard.general.string = network.password
                        copied = true
                    }
                    .buttonStyle(.ccQuiet)
                }
                .padding(.top, 8)
            }
            .font(.subheadline)
            .tint(Theme.accent)
        }
    }
}

extension WiFiJoinResult {
    /// Message shown under the network row after a join attempt.
    func message(for network: WiFiNetwork) -> String {
        switch self {
        case .joined: "Joined \(network.ssid)."
        case .cancelled: "Cancelled. Nothing was changed."
        case .failed(let reason): "Could not join automatically (\(reason)). Use the QR code or password below."
        }
    }

    var isFailure: Bool {
        if case .failed = self { true } else { false }
    }
}
