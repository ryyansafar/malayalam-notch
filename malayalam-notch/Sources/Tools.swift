//
//  Tools.swift — Malayalam Notch
//  The Tools tab: translate-on-copy (opt-in), a Malayalam word of the day, and a focus timer with a ring.
//

import AppKit
import SwiftUI

struct MalayalamWord { let ml: String; let roman: String; let en: String }

enum WordBank {
    static let words: [MalayalamWord] = [
        .init(ml: "നന്ദി", roman: "nanni", en: "thank you"), .init(ml: "സ്വാഗതം", roman: "swagatham", en: "welcome"),
        .init(ml: "വെള്ളം", roman: "vellam", en: "water"), .init(ml: "അമ്മ", roman: "amma", en: "mother"),
        .init(ml: "അച്ഛൻ", roman: "achan", en: "father"), .init(ml: "സ്നേഹം", roman: "sneham", en: "love"),
        .init(ml: "ചായ", roman: "chaya", en: "tea"), .init(ml: "വീട്", roman: "veedu", en: "home"),
        .init(ml: "പുസ്തകം", roman: "pusthakam", en: "book"), .init(ml: "കടൽ", roman: "kadal", en: "sea"),
        .init(ml: "മഴ", roman: "mazha", en: "rain"), .init(ml: "പൂവ്", roman: "poovu", en: "flower"),
        .init(ml: "സന്തോഷം", roman: "santhosham", en: "happiness"), .init(ml: "ചോറ്", roman: "choru", en: "cooked rice"),
        .init(ml: "സുഹൃത്ത്", roman: "suhruthu", en: "friend"),
    ]
    /// One word per calendar day, stable through the day.
    static func today(_ date: Date = Date(), offset: Int = 0) -> MalayalamWord {
        let day = Calendar.current.ordinality(of: .day, in: .era, for: date) ?? 0
        return words[((day + offset) % words.count + words.count) % words.count]
    }
}

@MainActor
final class ToolsModel: ObservableObject {
    static let shared = ToolsModel()

    // Translate on copy (off by default: it sends copied Malayalam text to Sarvam)
    @Published var copyWatch = UserDefaults.standard.bool(forKey: "copyWatch") { didSet { UserDefaults.standard.set(copyWatch, forKey: "copyWatch") } }
    @Published var copied: (ml: String, roman: String, en: String)?
    @Published var copyBusy = false
    private var lastCount = NSPasteboard.general.changeCount
    private var watcher: Timer?

    // Word of the day
    @Published var wordOffset = 0
    var word: MalayalamWord { WordBank.today(offset: wordOffset) }

    // Focus timer
    enum Focus { case idle, work, rest }
    @Published var focus: Focus = .idle
    @Published var focusLeft = 0
    @Published var focusTotal = 1
    private var focusTimer: Timer?

    func start() {
        guard watcher == nil else { return }
        watcher = Timer.scheduledTimer(withTimeInterval: 0.6, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.pollPasteboard() }
        }
    }

    // MARK: translate on copy
    private func pollPasteboard() {
        let pb = NSPasteboard.general
        guard pb.changeCount != lastCount else { return }
        lastCount = pb.changeCount
        guard copyWatch, !AssistantModel.shared.paused else { return }
        // never read what a password manager marked as secret
        let secret = pb.types?.contains { $0.rawValue == "org.nspasteboard.ConcealedType" || $0.rawValue == "org.nspasteboard.TransientType" } ?? false
        guard !secret, let s = pb.string(forType: .string)?.trimmingCharacters(in: .whitespacesAndNewlines), !s.isEmpty, s.count <= 600,
              s.unicodeScalars.contains(where: { (0x0D00...0x0D7F).contains($0.value) }) else { return }
        copyBusy = true
        Task { await translateCopied(s) }
    }

    func translateCopied(_ text: String) async {
        defer { copyBusy = false }
        let base = URL(string: "http://localhost:\(ProcessInfo.processInfo.environment["MALAYALAM_PORT"] ?? "3000")")!
        var req = URLRequest(url: base.appendingPathComponent("api/shout"))
        req.httpMethod = "POST"; req.timeoutInterval = 30
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try? JSONSerialization.data(withJSONObject: ["text": text, "source": "text", "targetLang": "en-IN", "ttsProvider": MalayalamViewModel.shared.ttsProvider])
        guard let (d, r) = try? await URLSession.shared.data(for: req), (r as? HTTPURLResponse)?.statusCode == 200,
              let j = try? JSONSerialization.jsonObject(with: d) as? [String: Any] else { return }
        copied = (text, (j["romanText"] as? String) ?? "", (j["translatedText"] as? String) ?? "")
        Audit.record(AuditEntry(tool: "translate_on_copy", tier: Tier.read.rawValue, source: "rule", result: "translated \(text.count) characters"))
        NotchModel.shared.tab = .tools
        NotchModel.shared.pinnedUntil = Date().addingTimeInterval(10)
        NotchModel.shared.setOpen(true)
    }

    // MARK: focus timer
    func startFocus(_ kind: Focus, minutes: Int) {
        focusTimer?.invalidate()
        focus = kind; focusTotal = minutes * 60; focusLeft = focusTotal
        focusTimer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.focusTick() }
        }
    }
    func stopFocus() { focusTimer?.invalidate(); focus = .idle; focusLeft = 0 }
    private func focusTick() {
        guard focus != .idle else { return }
        focusLeft -= 1
        if focusLeft <= 0 {
            let finishedWork = focus == .work
            focusTimer?.invalidate()
            let cue = finishedWork ? "ഇടവേള എടുക്കാം" : "ജോലി തുടങ്ങാം"
            if !AssistantModel.shared.paused { Task { await AssistantModel.shared.speak(cue, lang: "ml-IN") } }
            if finishedWork { startFocus(.rest, minutes: 5) } else { stopFocus() }
        }
    }
    var focusText: String { String(format: "%d:%02d", max(0, focusLeft) / 60, max(0, focusLeft) % 60) }
}

struct ToolsView: View {
    @ObservedObject private var t = ToolsModel.shared

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            card("COPY → TRANSLATE") { copyArea }.frame(maxWidth: .infinity)
            card("WORD OF THE DAY") { wordArea }.frame(width: 250)
            card("FOCUS") { focusArea }.frame(width: 230)
        }
        .frame(maxWidth: .infinity, alignment: .topLeading)
    }

    private func card<C: View>(_ title: String, @ViewBuilder _ content: () -> C) -> some View {
        VStack(alignment: .leading, spacing: 7) {
            Text(Design.sentence(title)).font(Design.Font.caption).foregroundStyle(.white.opacity(Design.Text.tertiary))
            content()
        }
        .padding(.horizontal, 11).padding(.vertical, 9)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background(RoundedRectangle(cornerRadius: 16, style: .continuous).fill(Color.white.opacity(0.055)))
    }

    private var copyArea: some View {
        VStack(alignment: .leading, spacing: 7) {
            Toggle(isOn: $t.copyWatch) { Text("Translate Malayalam when I copy it").font(.system(size: 11.5, weight: .semibold)) }
                .toggleStyle(.switch).tint(MalayalamTheme.accent)
            if t.copyBusy {
                HStack(spacing: 6) { ProgressView().controlSize(.small); Text("Translating…").font(.system(size: 11)).foregroundStyle(.secondary) }
            } else if let c = t.copied {
                Text(c.ml).font(Design.Font.ml).lineSpacing(5).lineLimit(3)
                if !c.roman.isEmpty { Text(c.roman).font(.system(size: 11)).foregroundStyle(.secondary).lineLimit(2) }
                Text(c.en).font(Design.Font.body).foregroundStyle(.white.opacity(Design.Text.primary)).lineLimit(3)
            } else {
                Text(t.copyWatch ? "Copy Malayalam text anywhere." : "Off. When on, copied Malayalam text goes to Sarvam. Passwords are never read.")
                    .font(Design.Font.caption).foregroundStyle(.white.opacity(Design.Text.secondary)).lineLimit(3)
            }
            Spacer(minLength: 0)
        }
    }

    private var wordArea: some View {
        let w = t.word
        return VStack(alignment: .leading, spacing: 4) {
            Text(w.ml).font(Design.Font.hero).lineSpacing(5)
            Text(w.roman).font(.system(size: 13)).foregroundStyle(.secondary)
            Text(w.en).font(.system(size: 14, weight: .semibold)).foregroundStyle(.white.opacity(Design.Text.primary))
            Spacer(minLength: 0)
            HStack(spacing: 8) {
                smallPill("speaker.wave.2.fill", "Hear it") { Task { await AssistantModel.shared.speak(w.ml, lang: "ml-IN") } }
                smallPill("arrow.right", "Next") { withAnimation(.snappy) { t.wordOffset += 1 } }
            }
        }
    }

    private var focusArea: some View {
        let on = t.focus != .idle
        let p = on ? Double(t.focusTotal - t.focusLeft) / Double(max(1, t.focusTotal)) : 0
        return VStack(spacing: 8) {
            ZStack {
                Circle().stroke(Color.white.opacity(0.1), lineWidth: 6)
                Circle().trim(from: 0, to: p)
                    .stroke(t.focus == .rest ? Color.white.opacity(0.6) : MalayalamTheme.accent, style: StrokeStyle(lineWidth: 6, lineCap: .round))
                    .rotationEffect(.degrees(-90)).animation(.linear(duration: 1), value: p)
                VStack(spacing: 0) {
                    Text(on ? t.focusText : "25:00").font(.system(size: 17, weight: .semibold).monospacedDigit())
                    Text(t.focus == .rest ? "break" : (on ? "focus" : "ready")).font(.system(size: 9)).foregroundStyle(.secondary)
                }
            }
            .frame(width: 92, height: 92).frame(maxWidth: .infinity)
            Spacer(minLength: 0)
            if on { smallPill("stop.fill", "Stop") { t.stopFocus() } }
            else { smallPill("play.fill", "Start 25 min") { t.startFocus(.work, minutes: 25) } }
        }
    }

    private func smallPill(_ symbol: String, _ text: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 5) {
                Image(systemName: symbol).font(.system(size: 10, weight: .semibold))
                Text(text).font(.system(size: 10.5, weight: .semibold))
            }
            .foregroundStyle(.white).padding(.horizontal, 10).frame(height: 26)
            .background(Capsule().fill(Color.white.opacity(0.12)))
        }.buttonStyle(.plain)
    }
}

/// Types text out one character (grapheme cluster) at a time, so Malayalam conjuncts stay intact.
struct TypewriterText: View {
    let text: String
    @State private var shown = 0
    var body: some View {
        Text(String(text.prefix(shown)))
            .task(id: text) {
                shown = 0
                let n = text.count
                while shown < n {
                    try? await Task.sleep(nanoseconds: 16_000_000)
                    if Task.isCancelled { return }
                    shown = min(n, shown + 2)
                }
            }
    }
}
