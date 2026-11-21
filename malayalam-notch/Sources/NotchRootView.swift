//
//  NotchRootView.swift — Malayalam Notch
//  The island: closed it is a notch-width pill with a glyph and a count on the wings;
//  open it hosts the Malayalam view. The shape animates; the window does not.
//

import SwiftUI

struct NotchRootView: View {
    @ObservedObject var model = NotchModel.shared
    @ObservedObject private var vm = MalayalamViewModel.shared

    var body: some View {
        ZStack(alignment: .top) {
            island
        }
        .frame(width: model.windowSize.width, height: model.windowSize.height, alignment: .top)
        .environmentObject(model)
        .preferredColorScheme(.dark)
    }

    private var island: some View {
        let w = model.shapeWidth + model.topRadius * 2
        return ZStack(alignment: .top) {
            NotchShape(topRadius: model.topRadius, bottomRadius: model.bottomRadius)
                .fill(Color.black)
                .shadow(color: .black.opacity(model.isOpen ? 0.55 : 0), radius: model.isOpen ? 10 : 0, y: 6)

            closedBar
                .opacity(model.isOpen ? 0 : 1)
                .animation(.easeOut(duration: 0.12), value: model.isOpen)

            MalayalamView()
                .padding(.horizontal, model.topRadius + 14)
                .padding(.top, model.closedHeight + 4)
                .padding(.bottom, 14)
                .opacity(model.isOpen ? 1 : 0)
                .blur(radius: model.isOpen ? 0 : 8)
                .animation(.easeOut(duration: model.isOpen ? 0.22 : 0.1).delay(model.isOpen ? 0.1 : 0), value: model.isOpen)
                .allowsHitTesting(model.isOpen)
        }
        .frame(width: w, height: model.shapeHeight, alignment: .top)
        .clipShape(NotchShape(topRadius: model.topRadius, bottomRadius: model.bottomRadius))
        .overlay(alignment: .top) {
            // soft accent edge while a file is over the drop target
            NotchShape(topRadius: model.topRadius, bottomRadius: model.bottomRadius)
                .stroke(MalayalamTheme.accent.opacity(model.dropHover ? 0.7 : 0), lineWidth: 1.2)
                .frame(width: w, height: model.shapeHeight)
                .animation(.easeOut(duration: 0.15), value: model.dropHover)
        }
    }

    /// Wings left and right of the physical notch: a waveform glyph and today's note count.
    private var closedBar: some View {
        HStack(spacing: 0) {
            Image(systemName: "waveform")
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(vm.phase == .idle ? Color.white.opacity(0.55) : MalayalamTheme.accent)
                .symbolEffect(.variableColor.iterative, isActive: vm.phase != .idle)
                .frame(maxWidth: .infinity)
            Spacer().frame(width: model.notchWidth)
            Text(vm.phase == .idle ? "\(model.notesToday)" : "…")
                .font(.system(size: 12, weight: .semibold).monospacedDigit())
                .foregroundStyle(MalayalamTheme.accent)
                .frame(maxWidth: .infinity)
        }
        .frame(height: model.closedHeight)
        .padding(.horizontal, model.topRadius)
    }
}
