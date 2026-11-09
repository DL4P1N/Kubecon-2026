import SwiftUI

/// Content card: surface fill + 1 px line, sharp. Never glass.
struct CCCardModifier: ViewModifier {
    var padding: CGFloat = 16
    var raised = false

    func body(content: Content) -> some View {
        content
            .padding(padding)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(raised ? Theme.surface2 : Theme.surface)
            .overlay { Rectangle().strokeBorder(Theme.line, lineWidth: Theme.hairline) }
    }
}

/// Selectable chip (filter, tag choice): outlined, lime when selected.
struct CCChipStyle: ViewModifier {
    var selected = false

    func body(content: Content) -> some View {
        content
            .font(.mono(.footnote, weight: .medium))
            .foregroundStyle(selected ? Theme.accentInk : Theme.ink)
            .padding(.horizontal, 12)
            .frame(minHeight: Theme.minTarget - 8)
            .background(selected ? Theme.accent : Color.clear)
            .overlay { Rectangle().strokeBorder(selected ? Theme.accent : Theme.lineStrong, lineWidth: Theme.hairline) }
            .contentShape(Rectangle())
    }
}

/// Uppercase tracked monospaced section label, with optional trailing detail.
struct CCSectionLabel: View {
    let title: String
    var detail: String?

    init(_ title: String, detail: String? = nil) {
        self.title = title
        self.detail = detail
    }

    var body: some View {
        HStack(alignment: .firstTextBaseline) {
            Text(title).ccLabel()
            Spacer(minLength: 8)
            if let detail { Text(detail).ccLabel() }
        }
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isHeader)
    }
}

extension View {
    /// Flat content card. Use instead of glass for anything that is content.
    func ccCard(padding: CGFloat = 16, raised: Bool = false) -> some View {
        modifier(CCCardModifier(padding: padding, raised: raised))
    }

    func ccChip(selected: Bool = false) -> some View { modifier(CCChipStyle(selected: selected)) }
}

/// Content-layer secondary alias (outlined lime). `.cc` is the primary (solid lime, dark ink).
extension ButtonStyle where Self == CCButtonStyle {
    static var ccPrimary: CCButtonStyle { CCButtonStyle() }
    static var ccSecondary: CCButtonStyle { CCButtonStyle(prominent: false) }
}
