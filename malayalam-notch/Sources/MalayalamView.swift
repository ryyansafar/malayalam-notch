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
        phase = .translating
        var req = URLRequest(url: base.appendingPathComponent("api/shout"))
        req.httpMethod = "POST"
        req.timeoutInterval = 40
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        let body: [String: Any] = [
            "audioBase64": data.base64EncodedString(), "mime": mime, "filename": filename,
            "source": origin == "mic" ? "mic" : "notch_drop", "targetLang": targetLang,
        ]
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
            note = n
            status = ""
            phase = .idle
            if runCommands {
                let intent = MalayalamIntentParser.parse(n.english)
                let line = MalayalamActions.perform(intent)
                actionLine = line.isEmpty ? "I heard: \(n.english)" : line
                if line.isEmpty { play(n) }
            } else {
                play(n)
            }
        } catch {
            phase = .idle
            status = "Couldn't reach the translator — is the server running on port 3000?"
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

struct MalayalamView: View {
    @ObservedObject private var vm = MalayalamViewModel.shared
    @EnvironmentObject private var notch: NotchModel
    @State private var targeted = false

    var body: some View {
        HStack(alignment: .top, spacing: 14) {
            leftColumn
                .frame(width: 168)
            resultColumn
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(.horizontal, 6)
        .animation(.smooth(duration: 0.3), value: vm.phase)
        .animation(.smooth(duration: 0.3), value: vm.note)
        .onChange(of: targeted) { _, isTargeted in notch.dropHover = isTargeted }
        .onDrop(of: [.fileURL], isTargeted: $targeted) { providers in
            guard let p = providers.first else { return false }
            notch.pinnedUntil = Date().addingTimeInterval(8) // stay open while the note is processed
            _ = p.loadObject(ofClass: URL.self) { url, _ in
                guard let url else { return }
                Task { @MainActor in vm.handleDrop(url: url) }
            }
            return true
        }
    }

    // Left: drop target + hold-to-talk mic
    private var leftColumn: some View {
        VStack(spacing: 10) {
            ZStack {
                RoundedRectangle(cornerRadius: 16, style: .continuous)
                    .strokeBorder(style: StrokeStyle(lineWidth: 1.5, dash: [6, 5]))
                    .foregroundStyle(targeted ? MalayalamTheme.accent : Color.white.opacity(0.22))
                    .background(
                        RoundedRectangle(cornerRadius: 16, style: .continuous)
                            .fill(targeted ? MalayalamTheme.accent.opacity(0.14) : Color.white.opacity(0.04))
                    )
                VStack(spacing: 6) {
                    Image(systemName: targeted ? "arrow.down.circle.fill" : "waveform")
                        .font(.system(size: 22, weight: .semibold))
                        .symbolEffect(.bounce, value: targeted)
                    Text(targeted ? "Release to translate" : "Drop a voice note")
                        .font(.system(size: 12, weight: .semibold))
                    Text("WhatsApp .opus · .m4a · .mp3")
                        .font(.system(size: 9.5))
                        .foregroundStyle(.secondary)
                }
                .foregroundStyle(targeted ? MalayalamTheme.accent : .white)
            }
            .frame(height: 84)
            .scaleEffect(targeted ? 1.03 : 1)
            .animation(.spring(response: 0.36, dampingFraction: 0.7), value: targeted)

            micButton
        }
    }

    private var micButton: some View {
        let recording = vm.phase == .recording
        return HStack(spacing: 8) {
            Image(systemName: recording ? "waveform" : "mic.fill")
                .font(.system(size: 13, weight: .bold))
                .symbolEffect(.variableColor.iterative, isActive: recording)
            Text(recording ? "Listening…" : "Hold to speak")
                .font(.system(size: 12, weight: .semibold))
        }
        .foregroundStyle(recording ? Color.black : .white)
        .frame(maxWidth: .infinity, minHeight: 34)
        .background(Capsule().fill(recording ? MalayalamTheme.accent : Color.white.opacity(0.12)))
        .scaleEffect(recording ? 1.04 : 1)
        .animation(.spring(response: 0.35, dampingFraction: 0.7), value: recording)
        .contentShape(Capsule())
        .onLongPressGesture(minimumDuration: 0, maximumDistance: .infinity, pressing: { pressing in
            if pressing { vm.startRecording() } else { vm.stopRecording() }
        }, perform: {})
        .help("Hold and say a command, e.g. “open Calendar” or “message Amma on WhatsApp saying I’m late”")
    }

    // Right: the result
    private var resultColumn: some View {
        VStack(alignment: .leading, spacing: 5) {
            if vm.phase == .translating {
                shimmer
            } else if let n = vm.note {
                HStack(spacing: 6) {
                    badge(n.origin == "mic" ? "VOICE" : "VOICE NOTE")
                    if !n.language.isEmpty { badge(n.language.uppercased()) }
                    Spacer(minLength: 0)
                }
                if !n.sourceText.isEmpty {
                    Text(n.sourceText)
                        .font(.system(size: 21, weight: .semibold))
                        .lineLimit(2).minimumScaleFactor(0.7)
                }
                if !n.romanText.isEmpty {
                    Text(n.romanText)
                        .font(.system(size: 12)).italic().foregroundStyle(.secondary).lineLimit(1)
                }
                Text(n.english)
                    .font(.system(size: 15, weight: .medium)).foregroundStyle(.white.opacity(0.92)).lineLimit(2)
                Spacer(minLength: 2)
                controls
            } else {
                VStack(alignment: .leading, spacing: 6) {
                    Text("Malayalam, in your notch")
                        .font(.system(size: 17, weight: .semibold))
                    Text("Drop a WhatsApp voice note to read it in Malayalam, romanised and English. Or hold the mic and say “open Calendar” or “message Amma on WhatsApp saying I’m late”.")
                        .font(.system(size: 12)).foregroundStyle(.secondary)
                    Spacer(minLength: 0)
                    controls
                }
            }
            if !vm.status.isEmpty {
                Text(vm.status).font(.system(size: 11)).foregroundStyle(.orange).lineLimit(2)
            } else if !vm.actionLine.isEmpty {
                Text(vm.actionLine).font(.system(size: 11, weight: .semibold)).foregroundStyle(MalayalamTheme.accent).lineLimit(2)
            }
        }
    }

    private var controls: some View {
        HStack(spacing: 8) {
            iconButton("speaker.wave.2.fill", help: "Speak the translation") { vm.play() }
                .disabled(vm.note?.ttsAudio == nil)
            iconButton("doc.on.doc", help: "Copy the English") { vm.copyEnglish() }
                .disabled(vm.note == nil)
            iconButton(vm.muted ? "speaker.slash.fill" : "speaker.fill", help: vm.muted ? "Unmute" : "Mute") { vm.muted.toggle() }
            Menu {
                ForEach(MalayalamViewModel.languages, id: \.code) { l in
                    Button(l.name) { vm.targetLang = l.code }
                }
            } label: {
                HStack(spacing: 4) {
                    Image(systemName: "globe")
                    Text(MalayalamViewModel.languages.first(where: { $0.code == vm.targetLang })?.name ?? "Hindi")
                        .font(.system(size: 11, weight: .semibold))
                }
                .foregroundStyle(.white)
                .padding(.horizontal, 10).frame(height: 28)
                .background(Capsule().fill(Color.white.opacity(0.12)))
            }
            .menuStyle(.button).buttonStyle(.plain).fixedSize()
            Spacer(minLength: 0)
        }
    }

    private func iconButton(_ symbol: String, help: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: symbol)
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(.white)
                .frame(width: 28, height: 28)
                .background(Circle().fill(Color.white.opacity(0.12)))
        }
        .buttonStyle(.plain)
        .help(help)
    }

    private func badge(_ text: String) -> some View {
        Text(text)
            .font(.system(size: 9, weight: .semibold)).tracking(1.2)
            .foregroundStyle(MalayalamTheme.accent)
            .padding(.horizontal, 7).padding(.vertical, 2)
            .overlay(Capsule().strokeBorder(MalayalamTheme.accent.opacity(0.5), lineWidth: 1))
    }

    private var shimmer: some View {
        VStack(alignment: .leading, spacing: 8) {
            ForEach([0.9, 0.55, 0.75], id: \.self) { f in
                RoundedRectangle(cornerRadius: 6).fill(Color.white.opacity(0.10)).frame(height: 14)
                    .frame(maxWidth: .infinity, alignment: .leading).scaleEffect(x: f, anchor: .leading)
            }
        }
        .phaseAnimator([0.45, 1.0]) { v, o in v.opacity(o) } animation: { _ in .easeInOut(duration: 0.8) }
    }
}
