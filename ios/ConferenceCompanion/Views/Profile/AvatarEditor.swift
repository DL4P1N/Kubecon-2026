import SwiftUI

struct AvatarEditor: View {
    @Binding var avatar: Avatar

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            SectionTitle("Your character")
            HStack(alignment: .top, spacing: 16) {
                PixelPersonView(avatar: avatar, pixel: 8)
                    .padding(12)
                    .background(Theme.background)
                    .overlay { Rectangle().strokeBorder(Theme.line) }
                VStack(alignment: .leading, spacing: 12) {
                    Toggle("Cap", isOn: $avatar.cap)
                        .ccBody()
                        .tint(Theme.accent)
                        .frame(minHeight: 44)
                    Text("Shown on your ticket, the venue map and the website.")
                        .ccCaption()
                    Button("Reset") { avatar = .standard }
                        .accessibilityLabel("Reset character")
                        .buttonStyle(.ccQuiet)
                        .disabled(avatar == .standard)
                }
            }
            Swatches(title: "Skin", options: Avatar.skinOptions, selection: $avatar.skin)
            Swatches(title: "Hair", options: Avatar.hairOptions, selection: $avatar.hair)
            Swatches(title: "Shirt", options: Avatar.shirtOptions, selection: $avatar.shirt)
            Swatches(title: "Trousers", options: Avatar.pantsSwatches, selection: $avatar.pants)
        }
        .panel()
    }
}

private struct Swatches: View {
    let title: String
    let options: [Avatar.Swatch]
    @Binding var selection: String

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title).font(.mono(.footnote)).foregroundStyle(Theme.muted)
            FlowLayout(spacing: 6) {
                ForEach(options, id: \.hex) { option in
                    let isOn = selection == option.hex
                    Button { selection = option.hex } label: {
                        Rectangle()
                            .fill(Color(hex: option.hex))
                            .frame(width: 44, height: 44)
                            .overlay { Rectangle().strokeBorder(isOn ? Theme.accent : Theme.line, lineWidth: isOn ? 3 : 1) }
                            .overlay {
                                if isOn {
                                    Image(systemName: "checkmark")
                                        .font(.caption.weight(.bold))
                                        .foregroundStyle(Theme.accentInk)
                                        .padding(2)
                                        .background(Theme.accent)
                                }
                            }
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("\(title): \(option.name.lowercased())")
                    .accessibilityAddTraits(isOn ? .isSelected : [])
                }
            }
        }
    }
}
