//
//  Assistant.swift — Malayalam Notch
//  The assistant half of the notch: a command bar (typed or spoken, English or Malayalam),
//  reminders and timers that speak aloud, a desktop tidy-up with undo, quick-launch apps
//  and clipboard translate. Everything here runs on this Mac; only speech and translation
//  go to the local server (Sarvam cloud).
//

import AppKit
import AVFoundation
import SwiftUI
import UserNotifications

// MARK: - Reminders

struct Reminder: Codable, Identifiable, Equatable {
    var id = UUID()
    var text: String
    var fire: Date
    var done = false
}

@MainActor
final class AssistantModel: ObservableObject {
    static let shared = AssistantModel()

    @Published var reminders: [Reminder] = []
    @Published var banner = ""                 // "Reminder: drink water"
    @Published var commandText = ""
    @Published var feedback = ""               // result line under the command bar
    @Published var plan: [OrganizePlanItem] = []
    @Published var canUndo = false

    private var timer: Timer?
    private var player: AVAudioPlayer?
    private let key = "assistantReminders"
    private let undoKey = "assistantUndoLog"
    private let server = URL(string: "http://localhost:\(ProcessInfo.processInfo.environment["MALAYALAM_PORT"] ?? "3000")")!

    init() {
        if let d = UserDefaults.standard.data(forKey: key), let r = try? JSONDecoder().decode([Reminder].self, from: d) { reminders = r }
        canUndo = UserDefaults.standard.data(forKey: undoKey) != nil
    }

    func start() {
        guard timer == nil else { return }
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound]) { _, _ in }
        timer = Timer.scheduledTimer(withTimeInterval: 2, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.tick() }
        }
    }

    // MARK: Reminders and timers
    var upcoming: [Reminder] { reminders.filter { !$0.done }.sorted { $0.fire < $1.fire } }

    func addReminder(_ text: String, at date: Date) {
        reminders.append(Reminder(text: text, fire: date)); persist()
        start()
    }
    func remove(_ r: Reminder) { reminders.removeAll { $0.id == r.id }; persist() }

    private func persist() {
        if let d = try? JSONEncoder().encode(reminders) { UserDefaults.standard.set(d, forKey: key) }
    }

    private func tick() {
        let now = Date()
        for i in reminders.indices where !reminders[i].done && reminders[i].fire <= now {
            reminders[i].done = true
            fire(reminders[i])
        }
        reminders.removeAll { $0.done && now.timeIntervalSince($0.fire) > 600 }
        persist()
    }

    private func fire(_ r: Reminder) {
        banner = "Reminder: \(r.text)"
        let c = UNMutableNotificationContent(); c.title = "Reminder"; c.body = r.text; c.sound = .default
        UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: r.id.uuidString, content: c, trigger: nil))
        NotchModel.shared.pinnedUntil = Date().addingTimeInterval(12)
        NotchModel.shared.tab = .assistant
        NotchModel.shared.setOpen(true)
        Task { await speak("Reminder. \(r.text)") }
        DispatchQueue.main.asyncAfter(deadline: .now() + 15) { [weak self] in
            if self?.banner == "Reminder: \(r.text)" { self?.banner = "" }
        }
    }

    /// Speak a line through the local server's TTS (Sarvam), so reminders have a real voice.
    func speak(_ text: String, lang: String = "en-IN") async {
        guard !MalayalamViewModel.shared.muted else { return }
        var req = URLRequest(url: server.appendingPathComponent("api/speak"))
        req.httpMethod = "POST"; req.timeoutInterval = 20
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try? JSONSerialization.data(withJSONObject: ["text": text, "targetLang": lang, "ttsProvider": MalayalamViewModel.shared.ttsProvider])
        guard let (data, _) = try? await URLSession.shared.data(for: req),
              let j = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let b64 = j["ttsAudioBase64"] as? String, let audio = Data(base64Encoded: b64) else {
            NSSound.beep(); return
        }
        player = try? AVAudioPlayer(data: audio); player?.play()
    }

    // MARK: Commands
    /// Run a command typed in the bar. Malayalam script is translated first, then understood.
    func submit(_ raw: String) {
        let text = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        commandText = ""
        if text.unicodeScalars.contains(where: { (0x0D00...0x0D7F).contains($0.value) }) {
            feedback = "Understanding…"
            Task { await translateThenRun(text) }
        } else {
            run(text)
        }
    }

    private func translateThenRun(_ text: String) async {
        var req = URLRequest(url: server.appendingPathComponent("api/shout"))
        req.httpMethod = "POST"; req.timeoutInterval = 30
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try? JSONSerialization.data(withJSONObject: ["text": text, "source": "text", "targetLang": "en-IN"])
        if let (data, _) = try? await URLSession.shared.data(for: req),
           let j = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
           let en = j["translatedText"] as? String, !en.isEmpty {
            run(en, heard: text)
        } else {
            feedback = "Couldn't reach the translator — is the server running?"
        }
    }

    func run(_ english: String, heard: String? = nil) {
        let intent = MalayalamIntentParser.parse(english)
        let line = MalayalamActions.perform(intent)
        feedback = line.isEmpty ? "I didn't catch an action in: \(english)" : line
    }

    // MARK: Clipboard translate
    func translateClipboard() {
        guard let s = NSPasteboard.general.string(forType: .string), !s.isEmpty else { feedback = "The clipboard is empty"; return }
        let vm = MalayalamViewModel.shared
        feedback = "Translating the clipboard…"
        Task { await vm.translateText(String(s.prefix(900))); feedback = "Clipboard translated" }
    }

    // MARK: Desktop tidy-up
    func scanDesktop() {
        let desktop = FileManager.default.urls(for: .desktopDirectory, in: .userDomainMask).first!
        guard let items = try? FileManager.default.contentsOfDirectory(at: desktop, includingPropertiesForKeys: [.isDirectoryKey, .isHiddenKey]) else {
            feedback = "Allow Desktop access in System Settings → Privacy & Security → Files and Folders"; return
        }
        var counts: [String: [URL]] = [:]
        for u in items {
            let v = try? u.resourceValues(forKeys: [.isDirectoryKey, .isHiddenKey])
            if v?.isDirectory == true || v?.isHidden == true || u.lastPathComponent.hasPrefix(".") { continue }
            counts[DesktopOrganizer.category(for: u), default: []].append(u)
        }
        plan = counts.map { OrganizePlanItem(folder: $0.key, files: $0.value) }.sorted { $0.folder < $1.folder }
        feedback = plan.isEmpty ? "The desktop is already tidy" : "Found \(plan.reduce(0) { $0 + $1.files.count }) loose files"
    }

    func tidyDesktop() {
        if plan.isEmpty { scanDesktop() }
        guard !plan.isEmpty else { return }
        let desktop = FileManager.default.urls(for: .desktopDirectory, in: .userDomainMask).first!
        var moves: [[String: String]] = []
        for item in plan {
            let dest = desktop.appendingPathComponent("Organized").appendingPathComponent(item.folder)
            try? FileManager.default.createDirectory(at: dest, withIntermediateDirectories: true)
            for f in item.files {
                var target = dest.appendingPathComponent(f.lastPathComponent)
                var n = 2
                while FileManager.default.fileExists(atPath: target.path) {
                    target = dest.appendingPathComponent("\(f.deletingPathExtension().lastPathComponent) \(n).\(f.pathExtension)"); n += 1
                }
                if (try? FileManager.default.moveItem(at: f, to: target)) != nil { moves.append(["from": f.path, "to": target.path]) }
            }
        }
        if let d = try? JSONSerialization.data(withJSONObject: moves) { UserDefaults.standard.set(d, forKey: undoKey) }
        canUndo = !moves.isEmpty
        feedback = "Moved \(moves.count) files into Desktop/Organized — Undo puts them back"
        plan = []
    }

    func undoTidy() {
        guard let d = UserDefaults.standard.data(forKey: undoKey),
              let moves = try? JSONSerialization.jsonObject(with: d) as? [[String: String]] else { return }
        var restored = 0
        for m in moves.reversed() {
            guard let from = m["from"], let to = m["to"] else { continue }
            if (try? FileManager.default.moveItem(atPath: to, toPath: from)) != nil { restored += 1 }
        }
        UserDefaults.standard.removeObject(forKey: undoKey)
        canUndo = false
        feedback = "Put \(restored) files back on the desktop"
    }
}

struct OrganizePlanItem: Identifiable, Equatable {
    var id: String { folder }
    let folder: String
    let files: [URL]
}

enum DesktopOrganizer {
    static func category(for url: URL) -> String {
        let name = url.lastPathComponent.lowercased()
        if name.hasPrefix("screenshot") || name.hasPrefix("screen shot") || name.hasPrefix("screen recording") { return "Screenshots" }
        switch url.pathExtension.lowercased() {
        case "png", "jpg", "jpeg", "gif", "heic", "webp", "svg", "tiff": return "Images"
        case "pdf", "doc", "docx", "txt", "md", "pages", "key", "numbers", "xls", "xlsx", "csv", "ppt", "pptx", "rtf": return "Documents"
        case "zip", "rar", "7z", "dmg", "pkg", "tar", "gz": return "Archives & installers"
        case "mp3", "m4a", "wav", "opus", "ogg", "aac", "flac": return "Audio"
        case "mp4", "mov", "mkv", "avi", "webm": return "Video"
        case "swift", "js", "ts", "py", "html", "css", "json", "sh", "c", "cpp", "java", "rs", "go": return "Code"
        default: return "Other"
        }
    }
}

// MARK: - View

struct AssistantView: View {
    @ObservedObject private var a = AssistantModel.shared
    @FocusState private var focused: Bool

    private let apps = ["WhatsApp", "Calendar", "Notes", "Reminders", "Safari", "Messages"]

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            card("ASSISTANT") { commandArea }.frame(maxWidth: .infinity)
            card("REMINDERS") { remindersArea }.frame(width: 232)
            card("DESKTOP") { desktopArea }.frame(width: 214)
        }
        .onAppear { a.start() }
    }

    private func card<C: View>(_ title: String, @ViewBuilder _ content: () -> C) -> some View {
        VStack(alignment: .leading, spacing: 7) {
            Text(title).font(.system(size: 8.5, weight: .semibold)).tracking(1.4).foregroundStyle(.secondary)
            content()
        }
        .padding(.horizontal, 11).padding(.vertical, 9)
        .frame(maxHeight: .infinity, alignment: .topLeading)
        .background(RoundedRectangle(cornerRadius: 16, style: .continuous).fill(Color.white.opacity(0.055)))
    }

    // Command bar, quick launch, clipboard
    private var commandArea: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                Image(systemName: "sparkles").font(.system(size: 12, weight: .semibold)).foregroundStyle(MalayalamTheme.accent)
                TextField("Ask me anything — English or Malayalam", text: $a.commandText)
                    .textFieldStyle(.plain).font(.system(size: 12.5))
                    .focused($focused)
                    .onSubmit { a.submit(a.commandText) }
                Button { a.submit(a.commandText) } label: {
                    Image(systemName: "arrow.up.circle.fill").font(.system(size: 18)).foregroundStyle(MalayalamTheme.accent)
                }.buttonStyle(.plain).disabled(a.commandText.trimmingCharacters(in: .whitespaces).isEmpty)
            }
            .padding(.horizontal, 10).frame(height: 34)
            .background(Capsule().fill(Color.white.opacity(0.09)))

            Text(a.feedback.isEmpty ? "Try “remind me to call Amma in 10 minutes”, “open WhatsApp”, “tidy my desktop” or “set a timer for 5 minutes”." : a.feedback)
                .font(.system(size: 10.5, weight: a.feedback.isEmpty ? .regular : .semibold))
                .foregroundStyle(a.feedback.isEmpty ? Color.secondary : MalayalamTheme.accent)
                .lineLimit(3)

            Spacer(minLength: 0)
            HStack(spacing: 8) {
                ForEach(apps, id: \.self) { name in appButton(name) }
                Spacer(minLength: 0)
                pill("doc.on.clipboard", "Translate clipboard") { a.translateClipboard() }
            }
        }
    }

    private func appButton(_ name: String) -> some View {
        let url = MalayalamActions.findApp(named: name)
        return Button {
            if let url { NSWorkspace.shared.openApplication(at: url, configuration: NSWorkspace.OpenConfiguration()) }
        } label: {
            Group {
                if let url { Image(nsImage: NSWorkspace.shared.icon(forFile: url.path)).resizable() }
                else { Image(systemName: "app.dashed").resizable().padding(5).foregroundStyle(.secondary) }
            }
            .frame(width: 28, height: 28)
        }
        .buttonStyle(.plain).help("Open \(name)").disabled(url == nil).opacity(url == nil ? 0.35 : 1)
    }

    // Reminders
    private var remindersArea: some View {
        VStack(alignment: .leading, spacing: 6) {
            if !a.banner.isEmpty {
                Text(a.banner).font(.system(size: 11, weight: .semibold)).foregroundStyle(.black)
                    .padding(.horizontal, 8).padding(.vertical, 4).background(Capsule().fill(MalayalamTheme.accent))
            }
            if a.upcoming.isEmpty {
                Spacer(minLength: 0)
                Text("No reminders").font(.system(size: 12, weight: .medium)).foregroundStyle(.secondary)
                Text("Say “remind me to … in 10 minutes”. I’ll speak it out loud.").font(.system(size: 10.5)).foregroundStyle(.tertiary)
                Spacer(minLength: 0)
            } else {
                ForEach(a.upcoming.prefix(3)) { r in
                    HStack(spacing: 8) {
                        VStack(alignment: .leading, spacing: 1) {
                            Text(r.text).font(.system(size: 11.5, weight: .semibold)).lineLimit(1)
                            Text(r.fire, style: .time).font(.system(size: 10).monospacedDigit()).foregroundStyle(.secondary)
                        }
                        Spacer(minLength: 0)
                        Button { a.remove(r) } label: { Image(systemName: "xmark.circle.fill").foregroundStyle(.secondary) }.buttonStyle(.plain)
                    }
                }
                Spacer(minLength: 0)
            }
        }
    }

    // Desktop tidy-up
    private var desktopArea: some View {
        VStack(alignment: .leading, spacing: 6) {
            if a.plan.isEmpty {
                Text("Tidy the desktop").font(.system(size: 12, weight: .semibold))
                Text("Sorts loose files into folders. You see the plan first, and Undo puts everything back.")
                    .font(.system(size: 10.5)).foregroundStyle(.secondary).lineLimit(3)
            } else {
                ForEach(a.plan.prefix(4)) { p in
                    HStack { Text(p.folder).font(.system(size: 11, weight: .medium)); Spacer(); Text("\(p.files.count)").font(.system(size: 11).monospacedDigit()).foregroundStyle(.secondary) }
                }
            }
            Spacer(minLength: 0)
            HStack(spacing: 6) {
                if a.plan.isEmpty { pill("magnifyingglass", "Scan") { a.scanDesktop() } }
                else { pill("sparkles", "Tidy") { a.tidyDesktop() } }
                if a.canUndo { pill("arrow.uturn.backward", "Undo") { a.undoTidy() } }
            }
        }
    }

    private func pill(_ symbol: String, _ text: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 5) {
                Image(systemName: symbol).font(.system(size: 10.5, weight: .semibold))
                Text(text).font(.system(size: 10.5, weight: .semibold))
            }
            .foregroundStyle(.white).padding(.horizontal, 10).frame(height: 26)
            .background(Capsule().fill(Color.white.opacity(0.12)))
        }.buttonStyle(.plain)
    }
}
