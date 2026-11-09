import SwiftUI

/// Signal-source tag and the nearby-device count, kept apart so Bluetooth updates refresh only this row.
struct SourceHeader: View {
    @Environment(PositionEngine.self) private var engine

    var body: some View {
        HStack {
            Text(engine.tag.uppercased())
                .font(.mono(.caption2, weight: .semibold))
                .foregroundStyle(engine.isLive ? Theme.accent : Theme.muted)
                .padding(.horizontal, 8)
                .padding(.vertical, 4)
                .overlay { Rectangle().strokeBorder(engine.isLive ? Theme.accent : Theme.lineStrong, lineWidth: 1) }
            Spacer()
            Text("\(engine.scanner.visible().count) devices nearby")
                .font(.mono(.caption))
                .foregroundStyle(Theme.muted)
        }
    }
}
