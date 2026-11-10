import SwiftUI
import RoomPlan

/// Organiser tools: scan a room with RoomPlan and keep the saved scans.
/// Push it inside an existing NavigationStack, or pass `standalone: true` to present it in a sheet.
struct OrganizerToolsView: View {
    var standalone = false
    @State private var store = RoomScanStore()
    @State private var showScan = false
    @State private var pending: PendingScan?

    var body: some View {
        if standalone {
            NavigationStack { content }
        } else {
            content
        }
    }

    private var content: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                VStack(alignment: .leading, spacing: 10) {
                    Text("Walk the room with your phone. The scan gives its real outline and size for the venue floor plan, and true distances for placing the Bluetooth receivers.")
                        .ccCaption()
                    Button { showScan = true } label: { Label("Scan a room", systemImage: "viewfinder") }
                        .buttonStyle(.ccPrimary)
                    if !RoomCaptureSession.isSupported {
                        Text("This device has no LiDAR. Scanning needs an iPhone or iPad Pro.").font(.mono(.footnote)).foregroundStyle(Theme.warn)
                    }
                }

                VStack(alignment: .leading, spacing: 8) {
                    CCSectionLabel("Saved scans", detail: "\(store.scans.count)")
                    if store.scans.isEmpty {
                        Text("No scans yet.").ccCaption().ccCard()
                    }
                    ForEach(store.scans) { scan in
                        NavigationLink(value: scan) { row(scan) }
                            .buttonStyle(.plain)
                            .contextMenu {
                                Button("Delete scan", systemImage: "trash", role: .destructive) { store.delete(scan) }
                            }
                    }
                }
            }
            .padding(16)
        }
        .background(Theme.background)
        .navigationTitle("Organiser tools")
        .navigationDestination(for: ScannedRoom.self) { scan in
            ScanResultView(room: scan, store: store)
        }
        .navigationDestination(item: $pending) { item in
            ScanResultView(room: item.scanned, captured: item.captured, store: store)
        }
        .fullScreenCover(isPresented: $showScan) {
            RoomScanView { captured in
                if let scanned = ScannedRoom.from(captured) {
                    pending = PendingScan(scanned: scanned, captured: captured)
                    showScan = false
                } else {
                    showScan = false
                }
            }
        }
    }

    private func row(_ scan: ScannedRoom) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text(scan.name.isEmpty ? "Untitled room" : scan.name).ccHeadline()
                Spacer()
                Image(systemName: "chevron.right").foregroundStyle(Theme.muted).accessibilityHidden(true)
            }
            Text("\(ScannedRoom.fmt(scan.width)) × \(ScannedRoom.fmt(scan.depth)) m · \(ScannedRoom.fmt(scan.areaM2)) m²\(scan.approximate ? " approx" : "")")
                .ccData()
            Text("\(scan.wallCount) walls · \(scan.doorCount) doors · \(scan.windowCount) windows")
                .ccLabel()
            Text(scan.createdAt.formatted(date: .abbreviated, time: .shortened)).ccCaption()
        }
        .ccCard()
        .frame(minHeight: Theme.minTarget)
        .accessibilityElement(children: .combine)
    }
}

/// A fresh scan waiting to be named and saved.
struct PendingScan: Identifiable, Hashable {
    let id = UUID()
    let scanned: ScannedRoom
    let captured: CapturedRoom?

    static func == (lhs: PendingScan, rhs: PendingScan) -> Bool { lhs.id == rhs.id }
    func hash(into hasher: inout Hasher) { hasher.combine(id) }
}
