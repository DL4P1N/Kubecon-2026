import RoomPlan

/// Lets the SwiftUI cover stop the RoomPlan session that lives inside the UIKit view.
@MainActor
final class ScanController {
    weak var captureView: RoomCaptureView?

    func stop() {
        captureView?.captureSession.stop()
    }
}
