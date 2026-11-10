import SwiftUI

struct CalibrateView: View {
    @Environment(PositionEngine.self) private var engine

    var body: some View {
        let devices = Array(engine.scanner.visible().prefix(40))
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                Text("This venue has no installed receivers. Pick any three visible Bluetooth devices and the receiver position each one stands in for. Place the devices around the room to match the plan.")
                    .font(.mono(.footnote))
                    .foregroundStyle(Theme.muted)
                BluetoothStatusBanner(state: engine.scanner.state, authorization: engine.scanner.authorization)
                HStack {
                    Tag(text: "\(engine.assignments.map.count) of 3 assigned", tone: engine.assignments.map.count >= 3 ? .accent : .warn)
                    Text(engine.isLive ? "Live Bluetooth" : "Needs 3 in range for live positioning")
                        .font(.mono(.caption))
                        .foregroundStyle(Theme.muted)
                }

                VStack(alignment: .leading, spacing: 8) {
                    SectionTitle("Assigned receivers")
                    ForEach(engine.receivers) { receiver in
                        let deviceID = engine.assignments.map[receiver.id]
                        let device = deviceID.flatMap { engine.scanner.devices[$0] }
                        HStack {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(receiver.name).font(.mono(.subheadline, weight: .semibold))
                                Text("x \(receiver.x, format: .number.precision(.fractionLength(0...1))) m, y \(receiver.y, format: .number.precision(.fractionLength(0...1))) m")
                                    .font(.mono(.caption)).foregroundStyle(Theme.muted)
                            }
                            Spacer()
                            if deviceID != nil {
                                Text(device?.displayName ?? "Not in range")
                                    .font(.mono(.caption))
                                    .foregroundStyle(device == nil ? Theme.warn : Theme.accent)
                                Button("Clear", systemImage: "xmark.circle") { engine.assignments.clear(receiverID: receiver.id) }
                                    .labelStyle(.iconOnly)
                                    .frame(minWidth: 44, minHeight: 44)
                                    .accessibilityLabel("Clear \(receiver.name)")
                            } else {
                                Text("Unassigned").font(.mono(.caption)).foregroundStyle(Theme.muted)
                            }
                        }
                        .frame(minHeight: 44)
                        Divider().overlay(Theme.line)
                    }
                    Button("Clear all assignments") { engine.assignments.clearAll() }
                        .buttonStyle(.ccQuiet)
                }
                .panel()

                VStack(alignment: .leading, spacing: 8) {
                    SectionTitle("Nearby Bluetooth devices")
                    if devices.isEmpty {
                        Text("Nothing seen yet. Scanning continues while this screen is open.")
                            .font(.mono(.footnote)).foregroundStyle(Theme.muted)
                    }
                    ForEach(devices) { device in
                        HStack {
                            Text(device.displayName).font(.mono(.subheadline)).lineLimit(2)
                            Spacer()
                            Text("\(Int(device.rssi.rounded())) dBm")
                                .font(.mono(.footnote))
                                .foregroundStyle(Theme.accent)
                            Menu("Assign") {
                                Text("Stands in for")
                                ForEach(engine.receivers) { receiver in
                                    Button(receiver.name) { engine.assignments.assign(receiverID: receiver.id, deviceID: device.id) }
                                }
                            }
                            .font(.mono(.footnote, weight: .semibold))
                            .frame(minWidth: 60, minHeight: 44)
                            .accessibilityLabel("Assign \(device.displayName) to a receiver")
                        }
                        .frame(minHeight: 44)
                        .accessibilityElement(children: .combine)
                        Divider().overlay(Theme.line)
                    }
                }
                .panel()
            }
            .padding(16)
        }
        .screenBackground()
        .navigationTitle("Calibrate")
        .navigationBarTitleDisplayMode(.inline)
        .onAppear { engine.scanner.start() }
    }
}
