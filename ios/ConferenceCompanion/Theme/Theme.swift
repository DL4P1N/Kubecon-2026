import SwiftUI

/// Design tokens, mirrored from landing/css/site.css.
///
/// THE RULES (read before adding UI)
/// 1. Two layers. CONTENT (cards, lists, forms, tickets, the floor plan) is flat, sharp-cornered
///    (0-2 pt), surface + 1 px line, system type for titles and monospaced type for labels/data.
///    CONTROLS (floating buttons over content, bars, sheets' chrome) may use Liquid Glass.
/// 2. Glass only on floating controls and system bars. Never on content. Never glass on glass:
///    group sibling glass controls in one `glassControlGroup` container.
/// 3. One prominent, tinted action per screen (`.ccGlassButton(prominent: true)` or `.cc`).
/// 4. One accent: lime. Coral is for errors only, amber for warnings only.
/// 5. Corners: content is `Theme.radius` (2 pt) or square. Glass controls keep the system capsule.
enum Theme {
    // Surfaces
    static let background = Color(red: 15 / 255, green: 31 / 255, blue: 16 / 255)   // #0f1f10
    static let surface = Color(red: 22 / 255, green: 42 / 255, blue: 23 / 255)      // #162a17
    static let surface2 = Color(red: 29 / 255, green: 53 / 255, blue: 30 / 255)     // #1d351e, one step up
    static let line = Color(red: 42 / 255, green: 61 / 255, blue: 43 / 255)         // #2a3d2b
    static let lineStrong = Color(red: 61 / 255, green: 82 / 255, blue: 62 / 255)   // #3d523e
    static let wall = Color(red: 45 / 255, green: 90 / 255, blue: 49 / 255)
    static let floor = Color(red: 27 / 255, green: 58 / 255, blue: 30 / 255)        // venue floor #1b3a1e

    // Ink
    static let ink = Color.white
    static let muted = Color(red: 170 / 255, green: 179 / 255, blue: 170 / 255)     // #aab3aa

    // Accent and state
    static let accent = Color(red: 198 / 255, green: 241 / 255, blue: 157 / 255)    // lime #c6f19d
    static let accentInk = background                                               // text on lime
    static let warn = Color(red: 240 / 255, green: 194 / 255, blue: 75 / 255)       // amber #f0c24b
    static let down = Color(red: 255 / 255, green: 122 / 255, blue: 89 / 255)       // coral #ff7a59
    static let error = down
    static let warning = warn

    // Metrics
    static let radius: CGFloat = 2
    static let hairline: CGFloat = 1
    static let spacing: CGFloat = 16
    static let minTarget: CGFloat = 44
}

extension Font {
    static func mono(_ style: Font.TextStyle, weight: Font.Weight = .regular) -> Font {
        .system(style, design: .monospaced, weight: weight)
    }
}
