import SwiftUI

/// Pixel character. The palette and the wire format are the website's (landing/js/avatar.js):
/// `skin-hair-shirt-pants-h0|h1`, colours as 6-digit lowercase hex without `#`, only palette values.
struct Avatar: Equatable, Hashable, Sendable {
    struct Swatch: Equatable, Hashable, Sendable {
        let hex: String
        let name: String
    }

    var skin: String
    var hair: String
    var shirt: String
    var pants: String
    var cap: Bool

    // MARK: Palette (identical to PALETTE in landing/js/avatar.js)

    static let skinOptions = [
        Swatch(hex: "f6d2b0", name: "Light"), Swatch(hex: "e3a979", name: "Fair"), Swatch(hex: "c68642", name: "Tan"),
        Swatch(hex: "8d5524", name: "Brown"), Swatch(hex: "5c3a21", name: "Deep")
    ]
    static let hairOptions = [
        Swatch(hex: "1b1410", name: "Black"), Swatch(hex: "4a2f1b", name: "Brown"), Swatch(hex: "8a5a2b", name: "Chestnut"),
        Swatch(hex: "d9b45a", name: "Blond"), Swatch(hex: "a3361f", name: "Red"), Swatch(hex: "b9b9b9", name: "Grey")
    ]
    static let shirtOptions = [
        Swatch(hex: "c6f19d", name: "Lime"), Swatch(hex: "3b82c4", name: "Blue"), Swatch(hex: "e5604d", name: "Coral"),
        Swatch(hex: "f2c14e", name: "Yellow"), Swatch(hex: "2a9d8f", name: "Teal"), Swatch(hex: "f4f7ee", name: "White"),
        Swatch(hex: "3a3f3a", name: "Graphite"), Swatch(hex: "e8833a", name: "Orange")
    ]
    static let pantsSwatches = [
        Swatch(hex: "2f3b52", name: "Navy"), Swatch(hex: "3d3d3d", name: "Charcoal"),
        Swatch(hex: "6b5a3e", name: "Khaki"), Swatch(hex: "4a6a4a", name: "Olive")
    ]

    /// Hex-only views of the palette (the crowd simulation picks from these).
    static let skins = skinOptions.map(\.hex)
    static let hairs = hairOptions.map(\.hex)
    static let shirts = shirtOptions.map(\.hex)
    static let pantsOptions = pantsSwatches.map(\.hex)

    /// The website's `defaultAvatar()`: Fair, Brown, Lime, Navy, no cap.
    static let standard = Avatar(skin: skins[1], hair: hairs[1], shirt: shirts[0], pants: pantsOptions[0], cap: false)

    /// Eyes, shoes and cap brim colour.
    static let darkHex = "1b1410"

    var wire: String { "\(skin)-\(hair)-\(shirt)-\(pants)-h\(cap ? 1 : 0)" }

    init(skin: String, hair: String, shirt: String, pants: String, cap: Bool) {
        self.skin = skin; self.hair = hair; self.shirt = shirt; self.pants = pants; self.cap = cap
    }

    /// Strict parse: exactly four palette colours and `h0` or `h1`; anything else is nil (callers ignore it).
    init?(wire: String?) {
        guard let wire, wire.count == 30 else { return nil }
        let parts = wire.lowercased().split(separator: "-", omittingEmptySubsequences: false).map(String.init)
        guard parts.count == 5, parts[4] == "h0" || parts[4] == "h1",
              Self.skins.contains(parts[0]), Self.hairs.contains(parts[1]),
              Self.shirts.contains(parts[2]), Self.pantsOptions.contains(parts[3])
        else { return nil }
        self.init(skin: parts[0], hair: parts[1], shirt: parts[2], pants: parts[3], cap: parts[4] == "h1")
    }

    /// Like the website's `parseAvatarParam`: malformed gives the default, a non-palette part gives that part's default.
    static func lenient(wire: String?) -> Avatar {
        let parts = (wire ?? "").lowercased().split(separator: "-", omittingEmptySubsequences: false).map(String.init)
        guard parts.count == 5, parts[4] == "h0" || parts[4] == "h1" else { return .standard }
        return Avatar(
            skin: skins.contains(parts[0]) ? parts[0] : standard.skin,
            hair: hairs.contains(parts[1]) ? parts[1] : standard.hair,
            shirt: shirts.contains(parts[2]) ? parts[2] : standard.shirt,
            pants: pantsOptions.contains(parts[3]) ? parts[3] : standard.pants,
            cap: parts[4] == "h1"
        )
    }

    // MARK: Drawing

    static let gridWidth = 16
    static let gridHeight = 24

    struct Block: Equatable {
        let x: Int, y: Int, width: Int, height: Int
        let hex: String
    }

    /// The same rectangles, in the same order, as `drawAvatar` on the website (16 x 24 grid).
    var blocks: [Block] {
        func b(_ hex: String, _ x: Int, _ y: Int, _ w: Int = 1, _ h: Int = 1) -> Block { Block(x: x, y: y, width: w, height: h, hex: hex) }
        let dark = Self.darkHex
        var out = [
            b(skin, 5, 4, 6, 7),              // head
            b(skin, 7, 11, 2, 1),             // neck
            b(hair, 4, 2, 8, 3),              // hair on top
            b(hair, 4, 5, 1, 3), b(hair, 11, 5, 1, 3), // sides
            b(dark, 6, 7), b(dark, 9, 7),     // eyes
            b(shirt, 4, 12, 8, 6),            // shirt
            b(shirt, 2, 12, 2, 3), b(shirt, 12, 12, 2, 3), // sleeves
            b(skin, 2, 15, 2, 3), b(skin, 12, 15, 2, 3),   // hands
            b(pants, 4, 18, 8, 3), b(pants, 4, 21, 3, 1), b(pants, 9, 21, 3, 1), // trousers, legs
            b(dark, 4, 22, 3, 2), b(dark, 9, 22, 3, 2)     // shoes
        ]
        if cap {
            out.append(b(shirt, 4, 1, 8, 3))  // cap: the shirt colour, with a darker brim
            out.append(b(dark, 3, 4, 10, 1))
        }
        return out
    }

    /// Spoken description for VoiceOver.
    var spokenDescription: String {
        func name(_ options: [Swatch], _ hex: String) -> String { options.first { $0.hex == hex }?.name.lowercased() ?? "custom" }
        return "\(name(Self.skinOptions, skin)) skin, \(name(Self.hairOptions, hair)) hair, \(name(Self.shirtOptions, shirt)) shirt, \(name(Self.pantsSwatches, pants)) trousers, \(cap ? "with" : "no") cap"
    }
}

extension Color {
    init(hex: String) {
        let value = UInt32(hex, radix: 16) ?? 0x808080
        self.init(
            red: Double((value >> 16) & 0xFF) / 255,
            green: Double((value >> 8) & 0xFF) / 255,
            blue: Double(value & 0xFF) / 255
        )
    }
}
