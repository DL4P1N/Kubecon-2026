import SwiftUI

/// Signal-source tag and the nearby-device count, kept apart so Bluetooth updates refresh only this row.
struct SourceHeader: View {
    @Environment(PositionEngine.self) private var engine

    var body: some View {
        HStack {
            Tag(text: engine.tag, tone: engine.isLive ? .accent : .warn)
            Spacer()
            Text("\(engine.scanner.visible().count) devices nearby")
                .font(.mono(.caption))
                .foregroundStyle(Theme.muted)
        }
    }
}
