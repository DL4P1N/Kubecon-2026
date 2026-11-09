import SwiftUI

struct Panel: ViewModifier {
    func body(content: Content) -> some View {
        content
            .padding(14)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Theme.surface)
            .overlay { Rectangle().strokeBorder(Theme.line, lineWidth: 1) }
    }
}

extension View {
    func panel() -> some View { modifier(Panel()) }

    func screenBackground() -> some View {
        background(Theme.background.ignoresSafeArea())
    }
}

struct Tag: View {
    enum Tone { case accent, muted, warn }
    let text: String
    var tone: Tone = .accent

    private var color: Color {
        switch tone {
        case .accent: Theme.accent
        case .muted: Theme.muted
        case .warn: Theme.warn
        }
    }

    var body: some View {
        Text(text.uppercased())
            .font(.mono(.caption2, weight: .semibold))
            .foregroundStyle(color)
            .padding(.horizontal, 8)
            .padding(.vertical, 4)
            .overlay { Rectangle().strokeBorder(color, lineWidth: 1) }
    }
}

struct SectionTitle: View {
    let text: String
    init(_ text: String) { self.text = text }
    var body: some View {
        Text(text.uppercased())
            .font(.mono(.footnote, weight: .semibold))
            .foregroundStyle(Theme.muted)
            .accessibilityAddTraits(.isHeader)
    }
}

struct CCButtonStyle: ButtonStyle {
    var prominent = true

    func makeBody(configuration: Configuration) -> some View {
        Label(configuration: configuration, prominent: prominent)
    }

    private struct Label: View {
        let configuration: Configuration
        let prominent: Bool
        @Environment(\.isEnabled) private var isEnabled

        var body: some View {
            configuration.label
                .font(.mono(.body, weight: .semibold))
                .foregroundStyle(prominent ? Theme.background : Theme.accent)
                .multilineTextAlignment(.center)
                .frame(maxWidth: .infinity, minHeight: 44)
                .padding(.horizontal, 12)
                .background(prominent ? Theme.accent : Theme.surface)
                .overlay { Rectangle().strokeBorder(Theme.accent, lineWidth: prominent ? 0 : 1) }
                .opacity(isEnabled ? (configuration.isPressed ? 0.7 : 1) : 0.4)
        }
    }
}

extension ButtonStyle where Self == CCButtonStyle {
    static var cc: CCButtonStyle { CCButtonStyle() }
    static var ccQuiet: CCButtonStyle { CCButtonStyle(prominent: false) }
}

struct FlowLayout: Layout {
    var spacing: CGFloat = 8

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let maxWidth = proposal.width ?? .infinity
        var x: CGFloat = 0, y: CGFloat = 0, rowHeight: CGFloat = 0, width: CGFloat = 0
        for subview in subviews {
            let size = subview.sizeThatFits(.unspecified)
            if x > 0, x + size.width > maxWidth {
                y += rowHeight + spacing
                x = 0
                rowHeight = 0
            }
            x += size.width + spacing
            rowHeight = max(rowHeight, size.height)
            width = max(width, x - spacing)
        }
        return CGSize(width: width, height: y + rowHeight)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var x = bounds.minX, y = bounds.minY, rowHeight: CGFloat = 0
        for subview in subviews {
            let size = subview.sizeThatFits(.unspecified)
            if x > bounds.minX, x + size.width > bounds.maxX {
                y += rowHeight + spacing
                x = bounds.minX
                rowHeight = 0
            }
            subview.place(at: CGPoint(x: x, y: y), proposal: .unspecified)
            x += size.width + spacing
            rowHeight = max(rowHeight, size.height)
        }
    }
}
