import SwiftUI
import RoomPlan

/// Wraps `RoomCaptureView`. The coaching overlay is on; calling `ScanController.stop()` ends the scan
/// and the view then processes the result and calls `onResult` once, on the main queue.
struct RoomCaptureRepresentable: UIViewRepresentable {
    let controller: ScanController
    let onResult: (Result<CapturedRoom, Error>) -> Void

    func makeCoordinator() -> Coordinator { Coordinator(onResult: onResult) }

    func makeUIView(context: Context) -> RoomCaptureView {
        let view = RoomCaptureView(frame: .zero)
        view.delegate = context.coordinator
        view.captureSession.delegate = context.coordinator
        controller.captureView = view
        var configuration = RoomCaptureSession.Configuration()
        configuration.isCoachingEnabled = true
        view.captureSession.run(configuration: configuration)
        return view
    }

    func updateUIView(_ uiView: RoomCaptureView, context: Context) {}

    static func dismantleUIView(_ uiView: RoomCaptureView, coordinator: Coordinator) {
        uiView.captureSession.stop()
    }

    /// `RoomCaptureViewDelegate` requires `NSCoding`, hence the NSObject subclass.
    @objc(CCRoomCaptureCoordinator)
    final class Coordinator: NSObject, RoomCaptureViewDelegate, RoomCaptureSessionDelegate {
        private let onResult: (Result<CapturedRoom, Error>) -> Void
        private var reported = false

        init(onResult: @escaping (Result<CapturedRoom, Error>) -> Void) {
            self.onResult = onResult
            super.init()
        }

        required init?(coder: NSCoder) { nil }
        func encode(with coder: NSCoder) {}

        private func report(_ result: Result<CapturedRoom, Error>) {
            DispatchQueue.main.async { [weak self] in
                guard let self, !self.reported else { return }
                self.reported = true
                self.onResult(result)
            }
        }

        // MARK: RoomCaptureViewDelegate

        func captureView(shouldPresent roomDataForProcessing: CapturedRoomData, error: (any Error)?) -> Bool {
            if let error {
                report(.failure(error))
                return false
            }
            return true
        }

        func captureView(didPresent processedResult: CapturedRoom, error: (any Error)?) {
            if let error {
                report(.failure(error))
            } else {
                report(.success(processedResult))
            }
        }

        // MARK: RoomCaptureSessionDelegate

        func captureSession(_ session: RoomCaptureSession, didEndWith data: CapturedRoomData, error: (any Error)?) {
            if let error { report(.failure(error)) }
        }
    }
}
