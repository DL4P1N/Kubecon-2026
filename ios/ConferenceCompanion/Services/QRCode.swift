import CoreImage
import CoreImage.CIFilterBuiltins
import SwiftUI

enum QRCode {
    private static let context = CIContext()

    static func image(for text: String) -> CGImage? {
        let filter = CIFilter.qrCodeGenerator()
        filter.message = Data(text.utf8)
        filter.correctionLevel = "M"
        guard let output = filter.outputImage else { return nil }
        return context.createCGImage(output, from: output.extent)
    }
}

/// QR on a light plate for scanner contrast, scaled with nearest-neighbour.
struct QRView: View {
    let text: String
    var label = "Door ticket QR code"

    var body: some View {
        Group {
            if let cgImage = QRCode.image(for: text) {
                Image(cgImage, scale: 1, label: Text(label))
                    .interpolation(.none)
                    .resizable()
                    .scaledToFit()
            } else {
                Text("QR code unavailable")
                    .font(.mono(.body))
                    .foregroundStyle(.black)
            }
        }
        .padding(16)
        .background(Color.white)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(label)
        .accessibilityAddTraits(.isImage)
    }
}
