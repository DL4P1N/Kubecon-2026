import SwiftUI

/// Text styles from the website: system font for titles with tight display tracking, monospaced
/// for labels and data. All sizes come from Dynamic Type text styles and tracking scales with them.
enum CCTextStyle {
    /// Large screen title (site h1: weight 600, tracking -0.035em).
    case display
    /// Section/card title (site h2: weight 600, tracking -0.025em).
    case title
    /// Row title, names.
    case headline
    /// Reading text.
    case body
    /// Small uppercase tracked monospaced label (site .t-label).
    case label
    /// Monospaced data: codes, times, IDs, counts.
    case data
    /// Secondary caption.
    case caption
}

private struct CCTextStyleModifier: ViewModifier {
    let style: CCTextStyle
    @ScaledMetric(relativeTo: .largeTitle) private var displayPt: CGFloat = 1
    @ScaledMetric(relativeTo: .caption) private var labelPt: CGFloat = 1

    func body(content: Content) -> some View {
        switch style {
        case .display:
            content
                .font(.system(.largeTitle, weight: .semibold))
                .tracking(-0.035 * 34 * displayPt)
                .foregroundStyle(Theme.ink)
                .accessibilityAddTraits(.isHeader)
        case .title:
            content
                .font(.system(.title2, weight: .semibold))
                .tracking(-0.025 * 22 * displayPt)
                .foregroundStyle(Theme.ink)
                .accessibilityAddTraits(.isHeader)
        case .headline:
            content
                .font(.system(.headline, weight: .semibold))
                .foregroundStyle(Theme.ink)
        case .body:
            content
                .font(.body)
                .foregroundStyle(Theme.ink)
        case .label:
            content
                .font(.mono(.caption, weight: .medium))
                .textCase(.uppercase)
                .tracking(0.08 * 12 * labelPt)
                .foregroundStyle(Theme.muted)
        case .data:
            content
                .font(.mono(.subheadline, weight: .medium))
                .foregroundStyle(Theme.ink)
        case .caption:
            content
                .font(.footnote)
                .foregroundStyle(Theme.muted)
        }
    }
}

extension View {
    /// Apply a website-matched text style. Scales with Dynamic Type.
    func ccText(_ style: CCTextStyle) -> some View { modifier(CCTextStyleModifier(style: style)) }

    func ccDisplay() -> some View { ccText(.display) }
    func ccTitle() -> some View { ccText(.title) }
    func ccHeadline() -> some View { ccText(.headline) }
    func ccBody() -> some View { ccText(.body) }
    func ccLabel() -> some View { ccText(.label) }
    func ccData() -> some View { ccText(.data) }
    func ccCaption() -> some View { ccText(.caption) }
}
