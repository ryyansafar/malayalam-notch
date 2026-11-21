//
//  Onboarding.swift — Malayalam Notch
//  First-run help that earns its place: one outcome sentence, a "Try a sample" button, and a three-step
//  checklist that only ticks for things the user really did. It disappears once all three are done.
//

import SwiftUI

@MainActor
final class FirstSteps: ObservableObject {
    static let shared = FirstSteps()
    enum Step: String, CaseIterable { case read, remind, word
        var label: String {
            switch self {
            case .read: return "Read a voice note"
            case .remind: return "Set a spoken reminder"
            case .word: return "Hear today's word"
            }
        }
    }
    @Published private(set) var done: Set<String> = Set(UserDefaults.standard.stringArray(forKey: "firstSteps") ?? [])
    var finished: Bool { Step.allCases.allSatisfy { done.contains($0.rawValue) } }
    func mark(_ s: Step) {
        guard !done.contains(s.rawValue) else { return }
        done.insert(s.rawValue)
        UserDefaults.standard.set(Array(done), forKey: "firstSteps")
    }
}

struct FirstStepsView: View {
    @ObservedObject private var steps = FirstSteps.shared
    var body: some View {
        if !steps.finished {
            VStack(alignment: .leading, spacing: 5) {
                ForEach(FirstSteps.Step.allCases, id: \.rawValue) { s in
                    let on = steps.done.contains(s.rawValue)
                    HStack(spacing: 7) {
                        Image(systemName: on ? "checkmark.circle.fill" : "circle").font(.system(size: 14))
                            .foregroundStyle(on ? MalayalamTheme.accent : .white.opacity(Design.Text.tertiary))
                        Text(s.label).font(Design.Font.caption)
                            .foregroundStyle(.white.opacity(on ? Design.Text.tertiary : Design.Text.secondary))
                    }
                }
            }
        }
    }
}

enum SampleNote {
    /// A short Malayalam voice note shipped inside the app, so a new user sees the result before dropping their own.
    static var url: URL? { Bundle.main.url(forResource: "sample", withExtension: "opus") }
}

/// A calm olive waveform that breathes. Decorative; it only runs while the island is open.
struct WaveMotif: View {
    @EnvironmentObject private var notch: NotchModel
    var body: some View {
        if notch.isOpen {
            TimelineView(.animation(minimumInterval: 1.0 / 24.0)) { ctx in
                let t = ctx.date.timeIntervalSinceReferenceDate
                HStack(spacing: 5) {
                    ForEach(0..<21, id: \.self) { i in
                        let x = Double(i)
                        let h = 10 + 46 * abs(sin(t * 1.4 + x * 0.55)) * (0.35 + 0.65 * abs(sin(x * 0.31 + 1)))
                        Capsule().fill(MalayalamTheme.accent.opacity(0.35 + 0.5 * abs(sin(x * 0.31 + 1)))).frame(width: 5, height: h)
                    }
                }.frame(maxHeight: .infinity)
            }
        }
    }
}
