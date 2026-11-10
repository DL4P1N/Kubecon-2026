import UIKit

@MainActor
enum ScreenBrightness {
    private static var saved: CGFloat?

    static func raise() {
        let screen = currentScreen
        if saved == nil { saved = screen?.brightness }
        screen?.brightness = 1
    }

    static func restore() {
        if let saved { currentScreen?.brightness = saved }
        saved = nil
    }

    private static var currentScreen: UIScreen? {
        UIApplication.shared.connectedScenes.compactMap { ($0 as? UIWindowScene)?.screen }.first
    }
}
