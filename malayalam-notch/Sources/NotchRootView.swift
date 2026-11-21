//
//  NotchRootView.swift — Malayalam Notch
//  The island: closed it is a notch-width pill with a glyph and a count on the wings;
//  open it hosts the Malayalam view. The shape animates; the window does not.
//

import SwiftUI

struct NotchRootView: View {
    @ObservedObject var model = NotchModel.shared
    @ObservedObject private var vm = MalayalamViewModel.shared
    @ObservedObject private var np = NowPlayingModel.shared
    @ObservedObject private var asst = AssistantModel.shared

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

            tabHeader
                .opacity(model.isOpen ? 1 : 0)
                .animation(.easeOut(duration: 0.18).delay(model.isOpen ? 0.12 : 0), value: model.isOpen)
                .allowsHitTesting(model.isOpen)

            closedBar
                .opacity(model.isOpen ? 0 : 1)
                .animation(.easeOut(duration: 0.12), value: model.isOpen)

            Group {
                switch model.tab {
                case .voice: MalayalamView()
                case .assistant: AssistantView()
                case .me: MeView()
                case .now: NowView()
                case .tools: ToolsView()
                case .activity: ActivityView()
                }
            }
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
            // a 1 pt black line along the top hides any hairline against the screen edge
            Rectangle().fill(Color.black).frame(height: 1).padding(.horizontal, model.topRadius)
        }
        .overlay(alignment: .top) {
            // soft accent edge while a file is over the drop target
            NotchShape(topRadius: model.topRadius, bottomRadius: model.bottomRadius)
                .stroke(MalayalamTheme.accent.opacity(model.dropHover ? 0.7 : 0), lineWidth: 1.2)
                .frame(width: w, height: model.shapeHeight)
                .animation(.easeOut(duration: 0.15), value: model.dropHover)
        }
        .overlay(alignment: .top) { listeningGlow(width: w) }
    }

    /// Tabs on the left of the notch gap, status on the right.
    private var tabHeader: some View {
        HStack(spacing: 6) {
            tabButton(.voice, "waveform", "Voice")
            tabButton(.assistant, "sparkles", "Assistant")
            tabButton(.me, "person.crop.circle", "Me")
            tabButton(.now, "music.note.house", "Now")
            tabButton(.tools, "wand.and.stars", "Tools")
            tabButton(.activity, "checkmark.shield", "Activity")
            Spacer()
            Spacer().frame(width: model.notchWidth)
            Spacer()
            Text("\(model.notesToday) notes today").font(.system(size: 10.5, weight: .medium).monospacedDigit()).foregroundStyle(.secondary)
        }
        .padding(.horizontal, model.topRadius + 16)
        .frame(height: model.closedHeight)
    }

    @Namespace private var tabNS

    private func tabButton(_ tab: NotchModel.Tab, _ symbol: String, _ label: String) -> some View {
        let on = model.tab == tab
        return Button {
            withAnimation(.spring(response: 0.35, dampingFraction: 0.72)) { model.tab = tab }
            NSHapticFeedbackManager.defaultPerformer.perform(.alignment, performanceTime: .now)
        } label: {
            HStack(spacing: 5) {
                Image(systemName: symbol).font(.system(size: 11, weight: .semibold)).symbolEffect(.bounce, value: on)
                if on { Text(label).font(.system(size: 11, weight: .semibold)) }
            }
            .foregroundStyle(on ? Color.white : Color.white.opacity(Design.Text.secondary))
            .padding(.horizontal, 10).frame(height: 28)
            .contentShape(Capsule())
            .background { if on { Capsule().fill(Color.white.opacity(0.14)).matchedGeometryEffect(id: "tabpill", in: tabNS) } }
        }
        .buttonStyle(.plain)
    }

    /// Closed state. Idle: nothing but the notch itself. Live activity (music playing, a note being
    /// processed): the pill widens by `wingExtra`, with a 20x20 artwork on the left wing and an
    /// equaliser on the right, exactly as wide as the reference apps do it.
    private var closedBar: some View {
        let wing = model.wingExtra / 2
        return HStack(spacing: 0) {
            leftWing.frame(width: wing)
            Spacer().frame(width: model.closedWidth)
            rightWing.frame(width: wing)
        }
        .frame(height: model.closedHeight)
        .opacity(model.extended ? 1 : 0)
        .animation(.easeOut(duration: 0.18), value: model.extended)
    }

    @ViewBuilder private var leftWing: some View {
        if asst.soon != nil {
            Image(systemName: "timer").font(.system(size: 12, weight: .semibold)).foregroundStyle(MalayalamTheme.accent)
        } else if let art = np.artwork, np.isPlaying {
            Image(nsImage: art).resizable().aspectRatio(contentMode: .fill)
                .frame(width: 20, height: 20).clipShape(RoundedRectangle(cornerRadius: 4, style: .continuous))
        } else {
            Image(systemName: "waveform")
                .font(.system(size: 11, weight: .semibold))
                .foregroundStyle(MalayalamTheme.accent)
                .symbolEffect(.variableColor.iterative, isActive: vm.phase != .idle)
        }
    }

    @ViewBuilder private var rightWing: some View {
        if let t = asst.countdown {
            Text(t).font(.system(size: 11, weight: .semibold).monospacedDigit()).foregroundStyle(MalayalamTheme.accent)
        } else {
            EqualizerBars(active: true)
        }
    }
}

/// Four bars that dance while something is active.
struct EqualizerBars: View {
    var active: Bool
    var body: some View {
        TimelineView(.animation(minimumInterval: 1.0 / 24.0)) { ctx in
            let t = ctx.date.timeIntervalSinceReferenceDate
            HStack(alignment: .center, spacing: 2.5) {
                ForEach(0..<4, id: \.self) { i in
                    let h = active ? 5 + 10 * abs(sin(t * (3.1 + Double(i) * 0.9) + Double(i))) : 4
                    Capsule().fill(MalayalamTheme.accent).frame(width: 2.6, height: h)
                }
            }
            .frame(height: 16)
        }
    }
}

extension NotchRootView {
    /// A slowly turning olive halo along the island edge while the mic is open.
    @ViewBuilder func listeningGlow(width w: CGFloat) -> some View {
        if MalayalamViewModel.shared.phase == .recording {
            TimelineView(.animation(minimumInterval: 1.0 / 30.0)) { ctx in
                let a = ctx.date.timeIntervalSinceReferenceDate.truncatingRemainder(dividingBy: 3) / 3 * 360
                NotchShape(topRadius: model.topRadius, bottomRadius: model.bottomRadius)
                    .stroke(AngularGradient(colors: [MalayalamTheme.accent, .clear, MalayalamTheme.accent.opacity(0.6), .clear, MalayalamTheme.accent],
                                            center: .center, angle: .degrees(a)), lineWidth: 2.2)
                    .blur(radius: 1.5)
                    .frame(width: w, height: model.shapeHeight)
            }
            .allowsHitTesting(false)
        }
    }
}
