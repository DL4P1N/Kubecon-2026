import SwiftUI

extension GraphicsContext {
    /// The website's 16 x 24 pixel person (`drawAvatar` in landing/js/avatar.js), drawn with sharp rectangles.
    /// `cell` keeps its earlier meaning: the figure occupies 8 x 12 cells, so one avatar pixel is `cell / 2`.
    func drawPixelPerson(_ avatar: Avatar, bottomCenter: CGPoint, cell: CGFloat) {
        let pixel = cell / 2
        let originX = bottomCenter.x - CGFloat(Avatar.gridWidth) / 2 * pixel
        let originY = bottomCenter.y - CGFloat(Avatar.gridHeight) * pixel
        for block in avatar.blocks {
            let rect = CGRect(
                x: originX + CGFloat(block.x) * pixel, y: originY + CGFloat(block.y) * pixel,
                width: CGFloat(block.width) * pixel, height: CGFloat(block.height) * pixel
            )
            fill(Path(rect), with: .color(Color(hex: block.hex)))
        }
    }
}

struct PixelPersonView: View {
    let avatar: Avatar
    @ScaledMetric(relativeTo: .body) private var pixel: CGFloat = 5

    /// `pixel` is the point size of one avatar pixel (the figure is 16 x 24 pixels) before Dynamic Type scaling.
    init(avatar: Avatar, pixel: CGFloat = 5) {
        self.avatar = avatar
        _pixel = ScaledMetric(wrappedValue: pixel, relativeTo: .body)
    }

    var body: some View {
        Canvas { context, size in
            // Whole points per avatar pixel keep every edge sharp: no interpolation, no half-covered pixels.
            let unit = max(1, min(size.width / CGFloat(Avatar.gridWidth), size.height / CGFloat(Avatar.gridHeight)).rounded(.down))
            context.drawPixelPerson(avatar, bottomCenter: CGPoint(x: size.width / 2, y: size.height / 2 + CGFloat(Avatar.gridHeight) / 2 * unit), cell: unit * 2)
        }
        .frame(width: pixel * CGFloat(Avatar.gridWidth), height: pixel * CGFloat(Avatar.gridHeight))
        .accessibilityElement()
        .accessibilityLabel("Your pixel character")
        .accessibilityValue(avatar.spokenDescription)
    }
}
