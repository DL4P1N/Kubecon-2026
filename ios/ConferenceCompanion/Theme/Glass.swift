import SwiftUI

// LIQUID GLASS HELPERS - CONTROL LAYER ONLY
//
// Rule: glass is for floating controls and system bars. It is never used on content (cards, rows,
// tickets, the floor plan). One prominent tinted action per screen. Sibling glass controls go in a
// single `glassControlGroup` so they share one sampling region and can morph. Never nest glass.
//
// APIs (verified against iPhoneOS27.2.sdk SwiftUICore/SwiftUI swiftinterface):
//   GlassEffectContainer(spacing:content:)   View.glassEffect(_ Glass = .regular, in: some Shape)
//   Glass.regular/.clear/.tint(_:)/.interactive(_:)   .buttonStyle(.glass)  .buttonStyle(.glassProminent)
// With Reduce Transparency on, or before iOS 26, controls fall back to a solid surface
// (Reduce Transparency) or `.ultraThinMaterial` (pre-26), with a 1 px line.

private struct CCGlassGroup<Content: View>: View {
    var spacing: CGFloat?
    let content: Content
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency

    var body: some View {
        if #available(iOS 26.0, *), !reduceTransparency {
            GlassEffectContainer(spacing: spacing) { content }
        } else {
            content
        }
    }
}

/// Container for sibling floating glass controls (one prominent action at most).
func glassControlGroup<Content: View>(
    spacing: CGFloat? = nil,
    @ViewBuilder content: () -> Content
) -> some View {
    CCGlassGroup(spacing: spacing, content: content())
}

private struct CCGlassSurface<S: InsettableShape>: ViewModifier {
    let shape: S
    var tint: Color?
    var interactive: Bool
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency

    func body(content: Content) -> some View {
        if #available(iOS 26.0, *), !reduceTransparency {
            content.glassEffect(.regular.tint(tint).interactive(interactive), in: shape)
        } else if reduceTransparency {
            content
                .background(Theme.surface2, in: shape)
                .overlay { shape.strokeBorder(Theme.lineStrong, lineWidth: Theme.hairline) }
        } else {
            content
                .background(.ultraThinMaterial, in: shape)
                .overlay { shape.strokeBorder(Theme.lineStrong, lineWidth: Theme.hairline) }
        }
    }
}

private struct CCGlassButton: ViewModifier {
    var prominent: Bool
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency

    func body(content: Content) -> some View {
        if #available(iOS 26.0, *), !reduceTransparency {
            if prominent {
                content.buttonStyle(.glassProminent).tint(Theme.accent).foregroundStyle(Theme.accentInk)
            } else {
                content.buttonStyle(.glass)
            }
        } else {
            content.buttonStyle(CCFallbackGlassButtonStyle(prominent: prominent))
        }
    }
}

/// Fallback for Reduce Transparency / pre-iOS 26: solid surface (or lime), 1 px line, capsule.
struct CCFallbackGlassButtonStyle: ButtonStyle {
    var prominent = false

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.body.weight(.semibold))
            .foregroundStyle(prominent ? Theme.accentInk : Theme.ink)
            .padding(.horizontal, 16)
            .frame(minHeight: Theme.minTarget)
            .background(prominent ? Theme.accent : Theme.surface2, in: Capsule())
            .overlay { Capsule().strokeBorder(prominent ? Color.clear : Theme.lineStrong, lineWidth: Theme.hairline) }
            .opacity(configuration.isPressed ? 0.75 : 1)
    }
}

extension View {
    /// Floating glass behind a control (a button, a small HUD pill). Not for content.
    func ccGlassSurface(tint: Color? = nil, interactive: Bool = false) -> some View {
        modifier(CCGlassSurface(shape: Capsule(), tint: tint, interactive: interactive))
    }

    /// Same, with a custom shape (e.g. `RoundedRectangle(cornerRadius: 22)` for a floating bar).
    func ccGlassSurface<S: InsettableShape>(in shape: S, tint: Color? = nil, interactive: Bool = false) -> some View {
        modifier(CCGlassSurface(shape: shape, tint: tint, interactive: interactive))
    }

    /// Glass button for floating controls. `prominent: true` is the screen's one tinted action.
    func ccGlassButton(prominent: Bool = false) -> some View {
        modifier(CCGlassButton(prominent: prominent))
    }
}
