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
    var ring = false          // also ring the user's phone (Sarvam Voice Agents); confirmed when it was created
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
    @Published var audit: [AuditEntry] = []
    @Published var foundFiles: [String] = []
    @Published var briefingText = ""
    @Published var pending: PendingAction?
    @Published var paused = UserDefaults.standard.bool(forKey: "assistantPaused") {
        didSet { UserDefaults.standard.set(paused, forKey: "assistantPaused"); if paused { pending = nil } }
    }
    @Published var phone = UserDefaults.standard.string(forKey: "assistantPhone") ?? "" {
        didSet { UserDefaults.standard.set(phone, forKey: "assistantPhone") }
    }
    @Published var userName = UserDefaults.standard.string(forKey: "assistantName") ?? "" {
        didSet { UserDefaults.standard.set(userName, forKey: "assistantName") }
    }
    @Published var now = Date()                // ticks every second while a reminder is near, for the live countdown

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
        timer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.tick(); if let p = self?.pending, Date() > p.expires { self?.cancelPending(reason: "timed out") } }
        }
    }

    // MARK: Reminders and timers
    var upcoming: [Reminder] { reminders.filter { !$0.done }.sorted { $0.fire < $1.fire } }

    func addReminder(_ text: String, at date: Date, ring: Bool = false) {
        reminders.append(Reminder(text: text, fire: date, ring: ring)); persist()
        start()
    }
    func remove(_ r: Reminder) { reminders.removeAll { $0.id == r.id }; persist() }

    private func persist() {
        if let d = try? JSONEncoder().encode(reminders) { UserDefaults.standard.set(d, forKey: key) }
    }

    /// The soonest reminder due within 10 minutes: shown live in the closed notch.
    var soon: Reminder? { upcoming.first(where: { $0.fire.timeIntervalSince(now) <= 600 && $0.fire > now }) }

    /// mm:ss until the soonest near reminder, or nil.
    var countdown: String? {
        guard let r = soon else { return nil }
        let s = max(0, Int(r.fire.timeIntervalSince(now).rounded(.up)))
        return String(format: "%d:%02d", s / 60, s % 60)
    }

    private func tick() {
        let now = Date()
        if self.now.timeIntervalSince(now) != 0 { self.now = now }
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
        if r.ring { callPhone(r.text, fallbackSpeak: true) } else { Task { await speak("Reminder. \(r.text)") } }
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
    /// Run a command typed in the bar. Malayalam goes straight to the agent (it understands it
    /// natively); English tries the local rules first and falls back to the agent.
    func submit(_ raw: String) {
        let text = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        commandText = ""
        if text.unicodeScalars.contains(where: { (0x0D00...0x0D7F).contains($0.value) }) {
            feedback = "Understanding…"
            Task { await askAgent(text) }
        } else {
            run(text)
        }
    }

    /// English text (or a spoken command's transcript). Local rules first; anything they miss goes to the agent.
    func run(_ english: String, heard: String? = nil) {
        let intent = MalayalamIntentParser.parse(english)
        if intent != .none {
            let line = MalayalamActions.perform(intent)
            feedback = line.isEmpty ? "Done" : line
            return
        }
        feedback = "Thinking…"
        let original = (heard?.isEmpty == false) ? heard! : english
        Task { await askAgent(original) }
    }

    // MARK: Agent (Sarvam chat model via the local server)
    func askAgent(_ text: String) async {
        var req = URLRequest(url: server.appendingPathComponent("api/agent"))
        req.httpMethod = "POST"; req.timeoutInterval = 35
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        var body: [String: Any] = ["text": text, "speak": true, "ttsProvider": MalayalamViewModel.shared.ttsProvider]
        if let ctx = ProfileModel.shared.cloudString(), !ctx.isEmpty { body["profile"] = ctx }
        req.httpBody = try? JSONSerialization.data(withJSONObject: body)
        guard let (data, resp) = try? await URLSession.shared.data(for: req), (resp as? HTTPURLResponse)?.statusCode == 200,
              let j = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            feedback = "I couldn't reach the assistant — is the server running?"
            return
        }
        let reply = (j["reply"] as? String) ?? ""
        var lines: [String] = []
        for a in (j["actions"] as? [[String: Any]]) ?? [] {
            guard let tool = a["tool"] as? String, let intent = Self.intent(tool: tool, args: (a["args"] as? [String: Any]) ?? [:]) else { continue }
            let line = MalayalamActions.perform(intent, source: "agent")
            if !line.isEmpty { lines.append(line) }
        }
        feedback = [reply, lines.joined(separator: " · ")].filter { !$0.isEmpty }.joined(separator: "\n")
        if feedback.isEmpty { feedback = "I didn't get that — try rephrasing." }
        if let sp = j["speech"] as? [String: Any], let b64 = sp["ttsAudioBase64"] as? String, let audio = Data(base64Encoded: b64), !MalayalamViewModel.shared.muted {
            player = try? AVAudioPlayer(data: audio); player?.play()
        }
    }

    /// Map one validated tool call from the agent to a local intent.
    static func intent(tool: String, args: [String: Any]) -> MalayalamIntent? {
        func num(_ k: String) -> Int? { (args[k] as? Int) ?? (args[k] as? Double).map(Int.init) }
        switch tool {
        case "open_app": return (args["name"] as? String).map { .openApp(name: $0) }
        case "whatsapp": return .whatsApp(contact: args["contact"] as? String, text: args["text"] as? String)
        case "remind":
            guard let t = args["text"] as? String, let m = num("minutes") else { return nil }
            return .remind(text: t, at: Date().addingTimeInterval(TimeInterval(m * 60)))
        case "timer": return num("seconds").map { .timer(seconds: $0) }
        case "tidy_desktop": return .tidyDesktop
        case "translate_clipboard": return .translateClipboard
        case "media":
            switch args["command"] as? String { case "next": return .media(command: "next track"); case "previous": return .media(command: "previous track"); default: return .media(command: "playpause") }
        case "set_brightness": return num("percent").map { .brightness(target: $0, delta: 0) }
        case "set_volume": return num("percent").map { .volume(target: $0, delta: 0) }
        case "appearance": return (args["mode"] as? String).map { .appearance(mode: $0) }
        case "call_me": return (args["text"] as? String).map { .callMe(text: $0) }
        case "quit_app": return (args["name"] as? String).map { .quitApp(name: $0) }
        case "find_files": return (args["query"] as? String).map { .findFiles(query: $0) }
        case "battery_status": return .battery
        case "briefing": return .briefing
        case "remember": return (args["text"] as? String).map { .remember(text: $0) }
        default: return nil
        }
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

            if let p = a.pending {
                confirmCard(p)
            } else {
                Text(a.feedback.isEmpty ? "Try “remind me to call Amma in 10 minutes”, “ring my phone in 2 minutes to take my tablet”, “open WhatsApp”, “find my resume” or “tidy my desktop”." : a.feedback)
                    .font(.system(size: 10.5, weight: a.feedback.isEmpty ? .regular : .semibold))
                    .foregroundStyle(a.feedback.isEmpty ? Color.secondary : MalayalamTheme.accent)
                    .lineLimit(4)
                if !a.foundFiles.isEmpty {
                    VStack(alignment: .leading, spacing: 2) {
                        ForEach(a.foundFiles.prefix(4), id: \.self) { path in
                            Button { NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: path)]) } label: {
                                Text((path as NSString).lastPathComponent).font(.system(size: 10.5)).foregroundStyle(.white.opacity(0.85)).lineLimit(1)
                            }.buttonStyle(.plain)
                        }
                    }
                }
            }

            Spacer(minLength: 0)
            HStack(spacing: 8) {
                ForEach(apps, id: \.self) { name in appButton(name) }
                Spacer(minLength: 0)
                pill("doc.on.clipboard", "Translate clipboard") { a.translateClipboard() }
            }
        }
    }

    /// A tier-T2 action waits here: it shows exactly what will happen and only runs on OK.
    private func confirmCard(_ p: PendingAction) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 6) {
                Image(systemName: "exclamationmark.shield.fill").foregroundStyle(.orange)
                Text("Confirm").font(.system(size: 11, weight: .bold)).foregroundStyle(.orange)
                Spacer(minLength: 0)
                Text("asks \(p.source == "agent" ? "— chosen by the assistant" : "— your command")").font(.system(size: 9.5)).foregroundStyle(.tertiary)
            }
            Text(Safety.describe(p.intent)).font(.system(size: 12, weight: .medium)).lineLimit(3)
            HStack(spacing: 8) {
                Button { a.confirmPending() } label: {
                    Text("Do it").font(.system(size: 11.5, weight: .bold)).foregroundStyle(.black).padding(.horizontal, 16).frame(height: 28)
                        .background(Capsule().fill(MalayalamTheme.accent))
                }.buttonStyle(.plain).keyboardShortcut(.defaultAction)
                Button { a.cancelPending() } label: {
                    Text("Cancel").font(.system(size: 11.5, weight: .semibold)).foregroundStyle(.white).padding(.horizontal, 14).frame(height: 28)
                        .background(Capsule().fill(Color.white.opacity(0.14)))
                }.buttonStyle(.plain).keyboardShortcut(.cancelAction)
            }
        }
        .padding(10)
        .background(RoundedRectangle(cornerRadius: 12, style: .continuous).fill(Color.orange.opacity(0.12)))
        .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(Color.orange.opacity(0.4), lineWidth: 1))
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
                else { pill("sparkles", "Tidy…") { _ = MalayalamActions.perform(.tidyApply, source: "rule") } }
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
