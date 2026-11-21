//
//  MalayalamView.swift
//  boringNotch (Malayalam fork)
//
//  The Malayalam tab: drop a voice note (WhatsApp .opus/.ogg/.m4a/...) or hold the mic,
//  see the Malayalam, the romanised line and the English, hear it in another language,
//  and say commands ("open Calendar", "message Amma on WhatsApp saying I am late").
//  Speech and translation go through the local Node server (Sarvam cloud); command
//  understanding and acting run on this Mac.
//

import AVFoundation
import AppKit
import SwiftUI
import UniformTypeIdentifiers

/// Our accent: the olive-green "live" colour from docs/DESIGN.md.
enum MalayalamTheme {
    static let accent = Color(red: 0.718, green: 0.769, blue: 0.561)
}

// MARK: - Model

struct MalayalamNote: Equatable {
    var sourceText = ""
    var romanText = ""
    var english = ""
    var language = ""
    var ttsAudio: Data?
    var origin = ""
    var voice = ""          // "sarvam · 699 ms" — which engine spoke the translation
}

@MainActor
final class MalayalamViewModel: NSObject, ObservableObject {
    static let shared = MalayalamViewModel()

    enum Phase: Equatable { case idle, recording, translating }

    @Published var phase: Phase = .idle
    @Published var note: MalayalamNote?
    @Published var status = ""          // "Received PTT-….opus", errors
    @Published var actionLine = ""      // "Opened Calendar"
    @Published var targetLang = UserDefaults.standard.string(forKey: "malayalamTargetLang") ?? "hi-IN" {
        didSet { UserDefaults.standard.set(targetLang, forKey: "malayalamTargetLang") }
    }
    @Published var muted = false
    var profileCapture = false          // the next recording is "tell me about yourself", not a command
    @Published var ttsProvider = UserDefaults.standard.string(forKey: "malayalamTtsProvider") ?? "sarvam" {
        didSet { UserDefaults.standard.set(ttsProvider, forKey: "malayalamTtsProvider") }
    }

    static let languages: [(code: String, name: String)] = [
        ("hi-IN", "Hindi"), ("en-IN", "English"), ("bn-IN", "Bengali"), ("od-IN", "Odia"), ("ta-IN", "Tamil"),
    ]

    private let base = URL(string: "http://localhost:\(ProcessInfo.processInfo.environment["MALAYALAM_PORT"] ?? "3000")")!
    private var recorder: AVAudioRecorder?
    private var player: AVAudioPlayer?
    private var recordURL: URL?

    // MARK: Drop

    func handleDrop(url: URL) {
        let ext = url.pathExtension.lowercased()
        guard ["opus", "ogg", "m4a", "mp3", "wav", "aac", "amr", "webm", "mp4", "flac"].contains(ext) else {
            status = "That isn't an audio file — use .opus, .ogg, .m4a, .mp3 or .wav"
            return
        }
        guard let data = try? Data(contentsOf: url, options: .mappedIfSafe) else {
            status = "Couldn't read \(url.lastPathComponent)"
            return
        }
        guard data.count <= 5_000_000 else { status = "File is over 5 MB"; return }
        status = "Received \(url.lastPathComponent)"
        actionLine = ""
        Task { await translate(data: data, mime: Self.mime(forExtension: ext), filename: url.lastPathComponent, origin: "drop", runCommands: false) }
    }

    static func mime(forExtension ext: String) -> String {
        switch ext {
        case "opus": return "audio/ogg;codecs=opus"
        case "ogg": return "audio/ogg"
        case "m4a", "mp4": return "audio/mp4"
        case "mp3": return "audio/mpeg"
        case "wav": return "audio/wav"
        case "aac": return "audio/aac"
        case "amr": return "audio/amr"
        case "webm": return "audio/webm"
        default: return "audio/flac"
        }
    }

    // MARK: Hold to talk (voice commands)

    func startRecording() {
        guard phase == .idle else { return }
        AVCaptureDevice.requestAccess(for: .audio) { granted in
            Task { @MainActor in
                guard granted else { self.status = "Microphone is off — allow it in System Settings → Privacy"; return }
                self.beginRecorder()
            }
        }
    }

    private func beginRecorder() {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("notch-\(UUID().uuidString).m4a")
        let settings: [String: Any] = [
            AVFormatIDKey: kAudioFormatMPEG4AAC, AVSampleRateKey: 16000,
            AVNumberOfChannelsKey: 1, AVEncoderBitRateKey: 32000,
        ]
        do {
            let r = try AVAudioRecorder(url: url, settings: settings)
            r.record(forDuration: 25)
            recorder = r; recordURL = url
            phase = .recording; status = "Listening…"; actionLine = ""
        } catch {
            status = "Couldn't start recording"
        }
    }

    func stopRecording() {
        guard phase == .recording, let r = recorder, let url = recordURL else { return }
        r.stop(); recorder = nil
        guard let data = try? Data(contentsOf: url), data.count > 2000 else {
            phase = .idle; status = "Too short — hold the mic while you speak"; return
        }
        try? FileManager.default.removeItem(at: url)
        phase = .translating; status = "Understanding…"
        Task { await translate(data: data, mime: "audio/mp4", filename: "command.m4a", origin: "mic", runCommands: true) }
    }

    // MARK: Server

    private func translate(data: Data, mime: String, filename: String, origin: String, runCommands: Bool) async {
        let body: [String: Any] = [
            "audioBase64": data.base64EncodedString(), "mime": mime, "filename": filename,
            "source": origin == "mic" ? "mic" : "notch_drop", "targetLang": targetLang, "ttsProvider": ttsProvider,
        ]
        await send(body: body, origin: origin, runCommands: runCommands)
    }

    /// Translate typed or copied text (Malayalam) and show it as a note.
    func translateText(_ text: String) async {
        let body: [String: Any] = ["text": text, "source": "text", "targetLang": targetLang, "ttsProvider": ttsProvider]
        await send(body: body, origin: "text", runCommands: false)
    }

    private func send(body: [String: Any], origin: String, runCommands: Bool) async {
        phase = .translating
        var req = URLRequest(url: base.appendingPathComponent("api/shout"))
        req.httpMethod = "POST"
        req.timeoutInterval = 40
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try? JSONSerialization.data(withJSONObject: body)
        do {
            let (respData, resp) = try await URLSession.shared.data(for: req)
            guard (resp as? HTTPURLResponse)?.statusCode == 200,
                  let json = try JSONSerialization.jsonObject(with: respData) as? [String: Any] else {
                throw URLError(.badServerResponse)
            }
            var n = MalayalamNote()
            n.english = (json["translatedText"] as? String) ?? ""
            n.sourceText = (json["sourceText"] as? String) ?? ""
            n.romanText = (json["romanText"] as? String) ?? ""
            n.language = (json["detectedLanguage"] as? String) ?? ""
            n.origin = origin
            if let b64 = json["ttsAudioBase64"] as? String { n.ttsAudio = Data(base64Encoded: b64) }
            if let t = json["tts"] as? [String: Any], let p = t["provider"] as? String {
                n.voice = p == "smallest" ? "Voice 2" : "Voice 1"
                if let ms = t["latencyMs"] as? Int { n.voice += " · \(ms) ms" }
            }
            note = n
            FirstSteps.shared.mark(.read)
            status = ""
            phase = .idle
            if runCommands && profileCapture {
                profileCapture = false
                let fact = n.sourceText.isEmpty ? n.english : (n.english.isEmpty ? n.sourceText : "\(n.sourceText) (\(n.english))")
                ProfileModel.shared.add(fact, source: "spoken")
                actionLine = "Saved to Me: \(fact)"
            } else if runCommands {
                // Voice command: let the assistant understand and act (local rules first, then the agent).
                AssistantModel.shared.run(n.english, heard: n.sourceText)
                actionLine = AssistantModel.shared.feedback
            } else {
                play(n)
            }
        } catch {
            phase = .idle
            status = "The translator isn't running yet. Start it, then try again."
        }
    }

    // MARK: Audio out

    func play(_ n: MalayalamNote? = nil) {
        guard !muted, let data = (n ?? note)?.ttsAudio else { return }
        player = try? AVAudioPlayer(data: data)
        player?.play()
    }

    func copyEnglish() {
        guard let e = note?.english, !e.isEmpty else { return }
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(e, forType: .string)
        actionLine = "Copied"
    }
}

// MARK: - View

/// The expanded island: three areas side by side, one per feature.
struct MalayalamView: View {
    @ObservedObject private var vm = MalayalamViewModel.shared
    @EnvironmentObject private var notch: NotchModel
    @State private var targeted = false

    var body: some View {
        HStack(alignment: .top, spacing: 16) {
            area("VOICE") { voiceArea }.frame(width: 230)
            area("TRANSLATION", trailing: { badges }) { resultArea }.frame(maxWidth: .infinity)
        }
        .animation(.smooth(duration: 0.3), value: vm.phase)
        .animation(.smooth(duration: 0.3), value: vm.note)
        .onChange(of: targeted) { _, isTargeted in notch.dropHover = isTargeted }
        .onDrop(of: [.fileURL], isTargeted: $targeted) { providers in
            DropModel.load(providers)
            return true
        }
    }

    // One rounded card per feature, with a small caption.
    private func area<C: View, T: View>(_ title: String, @ViewBuilder trailing: () -> T = { EmptyView() },
                                        @ViewBuilder _ content: () -> C) -> some View {
        VStack(alignment: .leading, spacing: 7) {
            HStack(spacing: 6) {
                if !(["VOICE", "TRANSLATION"].contains(title)) { Text(Design.sentence(title)).font(Design.Font.caption).foregroundStyle(.white.opacity(Design.Text.tertiary)) }
                Spacer(minLength: 0)
                trailing()
            }
            content()
        }
        .padding(.horizontal, 11).padding(.vertical, 9)
        .frame(maxHeight: .infinity, alignment: .topLeading)
        .background(Color.clear)
    }

    // MARK: Voice area — drop a note, hold to speak
    private var voiceArea: some View {
        VStack(spacing: 8) {
            ZStack {
                RoundedRectangle(cornerRadius: 13, style: .continuous)
                    .fill(targeted ? MalayalamTheme.accent.opacity(0.18) : Color.white.opacity(0.06))
                    .overlay(RoundedRectangle(cornerRadius: 13, style: .continuous)
                        .strokeBorder(MalayalamTheme.accent.opacity(targeted ? 0.8 : 0), lineWidth: 1.2))
                VStack(spacing: 8) {
                    Image(systemName: targeted ? "arrow.down.circle.fill" : "waveform")
                        .font(.system(size: 40, weight: .light))
                        .symbolEffect(.bounce, value: targeted)
                    Text(targeted ? "Release" : "Drop a voice note")
                        .font(.system(size: 15, weight: .semibold))
                }
                .foregroundStyle(targeted ? MalayalamTheme.accent : .white)
            }
            .frame(height: 138)
            .scaleEffect(targeted ? 1.03 : 1)
            .animation(.spring(response: 0.36, dampingFraction: 0.7), value: targeted)
            micButton
        }
    }

    private var micButton: some View {
        let recording = vm.phase == .recording
        return HStack(spacing: 7) {
            Image(systemName: recording ? "waveform" : "mic.fill")
                .font(.system(size: 20, weight: .semibold))
                .symbolEffect(.variableColor.iterative, isActive: recording)
            Text(recording ? "Listening…" : "Hold to speak")
                .font(.system(size: 15, weight: .semibold))
        }
        .foregroundStyle(recording ? Color.black : .white)
        .frame(maxWidth: .infinity, minHeight: 52)
        .background(RoundedRectangle(cornerRadius: 16, style: .continuous).fill(recording ? MalayalamTheme.accent : Color.white.opacity(0.12)))
        .scaleEffect(recording ? 1.04 : 1)
        .animation(.spring(response: 0.35, dampingFraction: 0.7), value: recording)
        .contentShape(Capsule())
        .onLongPressGesture(minimumDuration: 0, maximumDistance: .infinity, pressing: { pressing in
            if pressing { vm.startRecording() } else { vm.stopRecording() }
            notch.recording = pressing
        }, perform: {})
        .help("Hold and say a command, e.g. “open Calendar” or “message Amma on WhatsApp saying I’m late”")
    }

    // MARK: Translation area — Malayalam, romanised, English, actions
    @ViewBuilder private var badges: some View {
        if let n = vm.note {
            HStack(spacing: 5) {
                if !n.language.isEmpty { badge(n.language.hasPrefix("ml") ? "Malayalam" : n.language) }
            }
        }
    }

    private var resultArea: some View {
        VStack(alignment: .leading, spacing: 4) {
            if vm.phase == .translating {
                shimmer
            } else if let n = vm.note {
                if !n.sourceText.isEmpty {
                    Text(n.sourceText).font(.system(size: 18, weight: .semibold)).lineLimit(2).minimumScaleFactor(0.7)
                }
                if !n.romanText.isEmpty {
                    Text(n.romanText).font(.system(size: 13)).italic().foregroundStyle(.secondary).lineLimit(1)
                }
                Text(n.english).font(.system(size: 16, weight: .medium)).foregroundStyle(.white.opacity(0.92)).lineLimit(2)
            } else {
                WaveMotif().frame(maxWidth: .infinity).frame(height: 70)
                Text("Malayalam, in your notch").font(.system(size: 22, weight: .semibold)).frame(maxWidth: .infinity)
                Text("Drop a voice note or hold to speak.").font(Design.Font.body).foregroundStyle(.white.opacity(Design.Text.secondary)).frame(maxWidth: .infinity)
            }
            Spacer(minLength: 0)
            if !vm.status.isEmpty {
                Text(vm.status).font(.system(size: 12.5)).foregroundStyle(.orange).lineLimit(2)
            } else if !vm.actionLine.isEmpty {
                Text(vm.actionLine).font(.system(size: 12.5, weight: .semibold)).foregroundStyle(MalayalamTheme.accent).lineLimit(2)
            }
            controls
        }
    }

    private var controls: some View {
        HStack(spacing: 7) {
            iconButton("speaker.wave.2.fill", help: "Speak the translation") { vm.play() }
                .disabled(vm.note?.ttsAudio == nil)
            iconButton("doc.on.doc", help: "Copy the English") { vm.copyEnglish() }
                .disabled(vm.note == nil)
            iconButton(vm.muted ? "speaker.slash.fill" : "speaker.fill", help: vm.muted ? "Unmute" : "Mute") { vm.muted.toggle() }
            Menu {
                Button("Voice: Sarvam Bulbul") { vm.ttsProvider = "sarvam" }
                Button("Voice: smallest.ai Lightning") { vm.ttsProvider = "smallest" }
            } label: {
                HStack(spacing: 4) {
                    Image(systemName: "person.wave.2").font(.system(size: 13))
                    Text(vm.ttsProvider == "smallest" ? "Voice 2" : "Voice 1").font(.system(size: 12.5, weight: .semibold))
                }
                .foregroundStyle(.white).padding(.horizontal, 9).frame(height: 26)
                .background(Capsule().fill(Color.white.opacity(0.12)))
            }
            .menuStyle(.button).buttonStyle(.plain).fixedSize()
            Menu {
                ForEach(MalayalamViewModel.languages, id: \.code) { l in
                    Button(l.name) { vm.targetLang = l.code }
                }
            } label: {
                HStack(spacing: 4) {
                    Image(systemName: "globe").font(.system(size: 13))
                    Text(MalayalamViewModel.languages.first(where: { $0.code == vm.targetLang })?.name ?? "Hindi")
                        .font(.system(size: 12.5, weight: .semibold))
                }
                .foregroundStyle(.white)
                .padding(.horizontal, 9).frame(height: 26)
                .background(Capsule().fill(Color.white.opacity(0.12)))
            }
            .menuStyle(.button).buttonStyle(.plain).fixedSize()
            Spacer(minLength: 0)
            CopyWatchChip()
        }
    }

    private func iconButton(_ symbol: String, help: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: symbol)
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(.white)
                .frame(width: 26, height: 26)
                .background(Circle().fill(Color.white.opacity(0.12)))
        }
        .buttonStyle(.plain)
        .help(help)
    }

    private func badge(_ text: String) -> some View {
        Text(text)
            .font(.system(size: 12, weight: .semibold)).tracking(1.1)
            .foregroundStyle(MalayalamTheme.accent)
            .padding(.horizontal, 6).padding(.vertical, 1.5)
            .overlay(Capsule().strokeBorder(MalayalamTheme.accent.opacity(0.5), lineWidth: 1))
    }

    private var shimmer: some View {
        VStack(alignment: .leading, spacing: 8) {
            ForEach([0.9, 0.55, 0.75], id: \.self) { f in
                RoundedRectangle(cornerRadius: 6).fill(Color.white.opacity(0.10)).frame(height: 13)
                    .frame(maxWidth: .infinity, alignment: .leading).scaleEffect(x: f, anchor: .leading)
            }
        }
        .phaseAnimator([0.45, 1.0]) { v, o in v.opacity(o) } animation: { _ in .easeInOut(duration: 0.8) }
    }
}
