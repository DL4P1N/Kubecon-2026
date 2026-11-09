import SwiftUI
import AVFoundation
import RoomPlan

/// Full-screen scan screen. Handles unsupported devices, camera permission and session errors.
struct RoomScanView: View {
    /// Called once with the finished capture.
    let onFinished: (CapturedRoom) -> Void
    @Environment(\.dismiss) private var dismiss
    @Environment(\.openURL) private var openURL

    private enum Phase: Equatable {
        case checking, unsupported, denied, scanning
        case failed(String)
    }

    @State private var phase: Phase = .checking
    @State private var controller = ScanController()
    @State private var finishing = false
    @State private var attempt = 0

    var body: some View {
        NavigationStack {
            ZStack {
                Theme.background.ignoresSafeArea()
                content
            }
            .navigationTitle("Scan a room")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                if phase == .scanning {
                    ToolbarItem(placement: .confirmationAction) {
                        Button("Done") {
                            finishing = true
                            controller.stop()
                        }
                        .disabled(finishing)
                    }
                }
            }
        }
        .task { await checkAccess() }
    }

    @ViewBuilder private var content: some View {
        switch phase {
        case .checking:
            ProgressView().tint(Theme.accent)
        case .unsupported:
            message("Room scanning needs an iPhone or iPad with LiDAR",
                    detail: "This device cannot run RoomPlan. Open Organiser tools on a LiDAR iPhone or iPad Pro to scan.")
        case .denied:
            message("Camera access is off",
                    detail: "The camera and LiDAR scan a room's walls. Turn on Camera for this app in Settings.",
                    action: ("Open Settings", {
                        if let url = URL(string: UIApplication.openSettingsURLString) { openURL(url) }
                    }))
        case .failed(let text):
            message("The scan did not finish", detail: text, action: ("Try again", {
                finishing = false
                attempt += 1
                phase = .scanning
            }))
        case .scanning:
            ZStack {
                RoomCaptureRepresentable(controller: controller) { result in
                    switch result {
                    case .success(let room):
                        onFinished(room)
                    case .failure(let error):
                        finishing = false
                        phase = .failed(error.localizedDescription)
                    }
                }
                .id(attempt)
                .ignoresSafeArea()
                if finishing {
                    VStack(spacing: 12) {
                        ProgressView().tint(Theme.accent)
                        Text("Building the floor plan").ccLabel()
                    }
                    .padding(20)
                    .background(Theme.background.opacity(0.9))
                    .overlay { Rectangle().strokeBorder(Theme.line) }
                }
            }
        }
    }

    private func message(_ title: String, detail: String, action: (String, () -> Void)? = nil) -> some View {
        VStack(alignment: .leading, spacing: 14) {
            Image(systemName: "viewfinder")
                .font(.largeTitle)
                .foregroundStyle(Theme.accent)
                .accessibilityHidden(true)
            Text(title).ccTitle()
            Text(detail).ccBody().foregroundStyle(Theme.muted)
            if let action {
                Button(action.0, action: action.1).buttonStyle(.ccPrimary)
            }
        }
        .ccCard(padding: 20)
        .padding(16)
        .frame(maxWidth: 520)
    }

    private func checkAccess() async {
        guard RoomCaptureSession.isSupported else { phase = .unsupported; return }
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .authorized:
            phase = .scanning
        case .notDetermined:
            let granted = await AVCaptureDevice.requestAccess(for: .video)
            phase = granted ? .scanning : .denied
        default:
            phase = .denied
        }
    }
}
