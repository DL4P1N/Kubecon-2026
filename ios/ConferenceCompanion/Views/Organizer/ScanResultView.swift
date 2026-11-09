import SwiftUI
import RoomPlan

/// Result of a scan (or a saved scan): outline, numbers, name, receiver spots, Save and Share.
struct ScanResultView: View {
    let store: RoomScanStore
    /// The live capture, only present straight after scanning; needed for the USDZ export.
    let captured: CapturedRoom?
    @State private var room: ScannedRoom
    @State private var usdzURL: URL?
    @State private var usdzError: String?
    @State private var exporting = false
    @State private var confirmDelete = false
    @Environment(\.dismiss) private var dismiss

    init(room: ScannedRoom, captured: CapturedRoom? = nil, store: RoomScanStore) {
        _room = State(initialValue: room)
        self.captured = captured
        self.store = store
    }

    private var isSaved: Bool { store.scans.contains { $0.id == room.id } }
    private var trimmedName: String { room.name.trimmingCharacters(in: .whitespacesAndNewlines) }
    private let columns = [GridItem(.adaptive(minimum: 140), spacing: 8)]

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                RoomOutlineView(room: room)

                nameField
                numbers
                receivers
                actions
            }
            .padding(16)
        }
        .background(Theme.background)
        .navigationTitle(trimmedName.isEmpty ? "New scan" : trimmedName)
        .navigationBarTitleDisplayMode(.inline)
        .confirmationDialog("Delete this scan?", isPresented: $confirmDelete, titleVisibility: .visible) {
            Button("Delete scan", role: .destructive) {
                store.delete(room)
                dismiss()
            }
        }
    }

    private var nameField: some View {
        VStack(alignment: .leading, spacing: 8) {
            CCSectionLabel("Room name")
            TextField("Main stage, Room A", text: $room.name)
                .font(.mono(.body))
                .textInputAutocapitalization(.words)
                .padding(10)
                .frame(minHeight: Theme.minTarget)
                .overlay { Rectangle().strokeBorder(Theme.line) }
        }
    }

    private var numbers: some View {
        VStack(alignment: .leading, spacing: 8) {
            CCSectionLabel("Measurements", detail: room.approximate ? "Area approximate" : nil)
            LazyVGrid(columns: columns, spacing: 8) {
                stat("Size", "\(ScannedRoom.fmt(room.width)) × \(ScannedRoom.fmt(room.depth)) m")
                stat(room.approximate ? "Area (box)" : "Area", "\(ScannedRoom.fmt(room.areaM2)) m²")
                stat("Ceiling", "\(ScannedRoom.fmt(room.ceilingHeight)) m")
                stat("Walls", "\(room.wallCount)")
                stat("Doors", "\(room.doorCount)")
                stat("Windows", "\(room.windowCount)")
                stat("Openings", "\(room.openingCount)")
            }
            Text(room.summary).ccCaption()
        }
    }

    private func stat(_ label: String, _ value: String) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(label).ccLabel()
            Text(value).ccData().minimumScaleFactor(0.8)
        }
        .ccCard(padding: 12)
        .accessibilityElement(children: .combine)
    }

    @ViewBuilder private var receivers: some View {
        VStack(alignment: .leading, spacing: 8) {
            CCSectionLabel("Suggested Bluetooth receiver spots")
            if room.receiverSpots.count == 3 {
                VStack(alignment: .leading, spacing: 8) {
                    ForEach(Array(room.receiverSpots.enumerated()), id: \.offset) { i, p in
                        HStack(spacing: 10) {
                            Rectangle().fill(OrganizerStyle.teal).frame(width: 12, height: 12)
                                .accessibilityHidden(true)
                            Text("Receiver \(letter(i))").ccData()
                            Spacer()
                            Text("\(ScannedRoom.fmt(p.x)) m, \(ScannedRoom.fmt(p.y)) m").ccCaption()
                        }
                    }
                    Divider().overlay(Theme.line)
                    ForEach(Array(room.receiverDistances.enumerated()), id: \.offset) { _, d in
                        HStack {
                            Text("\(letter(d.from)) to \(letter(d.to))").ccLabel()
                            Spacer()
                            Text("\(ScannedRoom.fmt(d.metres)) m").ccData()
                        }
                        .accessibilityElement(children: .combine)
                    }
                    Text("A geometric suggestion that spreads three receivers along the walls. It is not a radio survey; check signal on site.")
                        .ccCaption()
                }
                .ccCard()
            } else {
                Text("The outline is too small or irregular to suggest receiver spots.").ccCaption().ccCard()
            }
        }
    }

    private func letter(_ i: Int) -> String {
        String(UnicodeScalar(UInt8(65 + max(0, min(25, i)))))
    }

    private var actions: some View {
        VStack(spacing: 10) {
            Button {
                room.name = trimmedName
                store.save(room)
            } label: {
                Label(isSaved ? "Save changes" : "Save scan", systemImage: "square.and.arrow.down")
            }
            .buttonStyle(.ccPrimary)
            if let error = store.lastError {
                Text(error).font(.mono(.footnote)).foregroundStyle(Theme.error)
            }
            if isSaved {
                Text("Saved on this device").ccLabel()
            }

            ShareLink(item: RoomScanFile(room: room),
                      preview: SharePreview(trimmedName.isEmpty ? "Room scan" : trimmedName)) {
                Label("Share JSON", systemImage: "square.and.arrow.up")
            }
            .buttonStyle(.ccSecondary)

            if captured != nil {
                if let usdzURL {
                    ShareLink(item: usdzURL) { Label("Share 3D model (USDZ)", systemImage: "cube") }
                        .buttonStyle(.ccSecondary)
                } else {
                    Button {
                        exportUSDZ()
                    } label: {
                        Label(exporting ? "Preparing 3D model" : "Export 3D model (USDZ)", systemImage: "cube")
                    }
                    .buttonStyle(.ccSecondary)
                    .disabled(exporting)
                }
                if let usdzError { Text(usdzError).font(.mono(.footnote)).foregroundStyle(Theme.error) }
            }

            if isSaved {
                Button("Delete scan", role: .destructive) { confirmDelete = true }
                    .font(.mono(.body))
                    .foregroundStyle(Theme.error)
                    .frame(minHeight: Theme.minTarget)
            }
        }
    }

    private func exportUSDZ() {
        guard let captured else { return }
        exporting = true
        usdzError = nil
        let name = trimmedName.isEmpty ? "room-scan" : trimmedName
        Task {
            do {
                let url = try await Task.detached(priority: .userInitiated) {
                    let url = FileManager.default.temporaryDirectory.appending(path: "\(name).usdz")
                    try? FileManager.default.removeItem(at: url)
                    try captured.export(to: url)
                    return url
                }.value
                usdzURL = url
            } catch {
                usdzError = "Could not export the 3D model: \(error.localizedDescription)"
            }
            exporting = false
        }
    }
}

#if DEBUG
#Preview {
    NavigationStack {
        ScanResultView(room: .sample, store: RoomScanStore(directory: FileManager.default.temporaryDirectory.appending(path: "RoomScansPreview")))
    }
    .preferredColorScheme(.dark)
}
#endif
