//
//  NotchModel.swift — Malayalam Notch
//  State, geometry and the open/close rules for the island that lives in the MacBook notch.
//
//  Design rules (from docs/NOTCH-REFERENCE.md, written as our own code):
//   - The window is created once at the largest size and never resized or animated; only the
//     shape inside it morphs. That is what keeps the motion free of flicker.
//   - Open uses a slightly bouncy spring, close a critically damped one.
//   - A file drag opens the island while it is still approaching, never at the screen edge.
//

import AppKit
import SwiftUI

@MainActor
final class NotchModel: ObservableObject {
    static let shared = NotchModel()

    // MARK: Geometry (points)
    let openSize = CGSize(width: 880, height: 300)
    let earInset: CGFloat = 20               // room either side for the concave ears
    var closedWidth: CGFloat = 288           // real notch width + wings, set from the screen
    var closedHeight: CGFloat = 32           // real notch height, set from the screen
    var notchWidth: CGFloat = 0              // 0 on a Mac without a notch

    // MARK: State
    enum Tab: CaseIterable { case voice, assistant, me, now, tools, shelf, activity }
    @Published var tab: Tab = .voice
    @Published private(set) var isOpen = false
    @Published var isDragging = false        // an audio file drag is in flight near the notch
    @Published var peek = false              // the cursor is close to the notch (not on it): a small hint
    @Published var extended = false          // live activity: the closed pill grows sideways
    @Published var dropHover = false         // the file is over our drop target
    @Published var recording = false
    @Published var notesToday = 0
    @Published var pinnedUntil = Date.distantPast   // keep open while a note is processed

    var topRadius: CGFloat { isOpen ? 19 : 6 }
    var bottomRadius: CGFloat { isOpen ? 24 : 14 }
    /// Extra width while a live activity shows: the same rule the best notch apps use, 2*(notch height - 12) + 20.
    var wingExtra: CGFloat { 2 * max(0, closedHeight - 12) + 20 }
    var shapeWidth: CGFloat { isOpen ? openSize.width : closedWidth + (extended ? wingExtra : 0) + (peek ? 12 : 0) }
    var shapeHeight: CGFloat { isOpen ? openSize.height : closedHeight + (peek ? 5 : 0) }

    /// Window size: the open island plus ears and a little room for its shadow.
    var windowSize: CGSize { CGSize(width: openSize.width + earInset * 2, height: openSize.height + 24) }

    var onOpenChanged: ((Bool) -> Void)?

    // MARK: Open / close
    func setOpen(_ open: Bool) {
        guard open != isOpen else { return }
        let spring: Animation = open
            ? .spring(response: 0.42, dampingFraction: 0.8)
            : .spring(response: 0.45, dampingFraction: 1.0)
        onOpenChanged?(open)   // the panel starts accepting the mouse before the morph begins
        withAnimation(spring) { isOpen = open }
    }

    var shouldStayOpen: Bool {
        dropHover || recording || isDragging || Date() < pinnedUntil || AssistantModel.shared.pending != nil || DropModel.shared.showing || MalayalamViewModel.shared.phase != .idle
    }
}

/// The notch silhouette: flat against the top edge, with small concave "ears" flaring into the
/// screen edge and rounded bottom corners. Both radii animate together with the size.
struct NotchShape: Shape {
    var topRadius: CGFloat
    var bottomRadius: CGFloat

    var animatableData: AnimatablePair<CGFloat, CGFloat> {
        get { AnimatablePair(topRadius, bottomRadius) }
        set { topRadius = newValue.first; bottomRadius = newValue.second }
    }

    func path(in r: CGRect) -> Path {
        let t = min(topRadius, r.width / 4), b = min(bottomRadius, r.height / 2)
        var p = Path()
        p.move(to: CGPoint(x: r.minX, y: r.minY))
        p.addQuadCurve(to: CGPoint(x: r.minX + t, y: r.minY + t), control: CGPoint(x: r.minX + t, y: r.minY))
        p.addLine(to: CGPoint(x: r.minX + t, y: r.maxY - b))
        p.addQuadCurve(to: CGPoint(x: r.minX + t + b, y: r.maxY), control: CGPoint(x: r.minX + t, y: r.maxY))
        p.addLine(to: CGPoint(x: r.maxX - t - b, y: r.maxY))
        p.addQuadCurve(to: CGPoint(x: r.maxX - t, y: r.maxY - b), control: CGPoint(x: r.maxX - t, y: r.maxY))
        p.addLine(to: CGPoint(x: r.maxX - t, y: r.minY + t))
        p.addQuadCurve(to: CGPoint(x: r.maxX, y: r.minY), control: CGPoint(x: r.maxX - t, y: r.minY))
        p.closeSubpath()
        return p
    }
}
