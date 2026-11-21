//
//  Design.swift — Malayalam Notch
//  The few numbers every screen shares: spacing, type, text opacity, one accent. Calm and consistent
//  beats clever. Malayalam script is set larger with extra line spacing so it stays legible.
//

import SwiftUI

enum Design {
    enum Space { static let xs: CGFloat = 4, s: CGFloat = 8, m: CGFloat = 12, l: CGFloat = 16 }
    enum Radius { static let chip: CGFloat = 10, card: CGFloat = 16 }
    enum Font {
        static let title = SwiftUI.Font.system(size: 15, weight: .semibold)
        static let body = SwiftUI.Font.system(size: 13)
        static let caption = SwiftUI.Font.system(size: 11)
        static let ml = SwiftUI.Font.system(size: 16, weight: .medium)       // Malayalam: pair with .lineSpacing(5)
        static let hero = SwiftUI.Font.system(size: 30, weight: .semibold)
    }
    enum Text { static let primary = 0.92, secondary = 0.62, tertiary = 0.38 }
    static let fill = Color.white.opacity(0.05)

    /// "COPY → TRANSLATE" -> "Copy → translate"
    static func sentence(_ s: String) -> String { s.prefix(1).uppercased() + s.dropFirst().lowercased() }
}

/// The one card every tab uses.
struct Card<C: View>: View {
    let title: String?
    @ViewBuilder let content: C
    var body: some View {
        VStack(alignment: .leading, spacing: Design.Space.s) {
            if let t = title {
                SwiftUI.Text(Design.sentence(t)).font(Design.Font.caption).foregroundStyle(.white.opacity(Design.Text.tertiary))
            }
            content
        }
        .padding(Design.Space.m)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background(RoundedRectangle(cornerRadius: Design.Radius.card, style: .continuous).fill(Design.fill))
    }
}

/// One button style: a quiet 32 pt chip. `primary` is the single accent-filled action on a screen.
struct Chip: View {
    let symbol: String?
    let text: String
    var primary = false
    let action: () -> Void
    var body: some View {
        Button(action: action) {
            HStack(spacing: 5) {
                if let symbol { Image(systemName: symbol).font(.system(size: 11, weight: .semibold)) }
                SwiftUI.Text(text).font(.system(size: 12, weight: .medium))
            }
            .foregroundStyle(primary ? Color.black : .white.opacity(Design.Text.primary))
            .padding(.horizontal, 12).frame(height: 32)
            .background(Capsule().fill(primary ? MalayalamTheme.accent : Color.white.opacity(0.1)))
            .contentShape(Capsule())
        }.buttonStyle(.plain)
    }
}
