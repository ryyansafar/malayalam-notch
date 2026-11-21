//
//  MalayalamActions.swift
//  boringNotch (Malayalam fork)
//
//  Performs a parsed intent on this Mac: launches an app, or opens WhatsApp
//  (optionally to a saved contact with the message pre-filled). Nothing is sent
//  without the user pressing Send in WhatsApp.
//

import AppKit
import Foundation

enum MalayalamActions {

    /// Contacts the user has saved: name -> international phone number (digits only).
    /// Stored in UserDefaults under "malayalamContacts" as [String: String].
    static var contacts: [String: String] {
        get { (UserDefaults.standard.dictionary(forKey: "malayalamContacts") as? [String: String]) ?? [:] }
        set { UserDefaults.standard.set(newValue, forKey: "malayalamContacts") }
    }

    /// Returns a short human line describing what happened ("Opened Calendar").
    /// The single gate every action passes through: kill switch, risk tier, confirmation, audit log.
    @MainActor @discardableResult
    static func perform(_ intent: MalayalamIntent, confirmed: Bool = false, source: String = "rule") -> String {
        if case .none = intent { return "" }
        let a = AssistantModel.shared
        let tier = Safety.tier(of: intent)
        if a.paused {
            Audit.record(AuditEntry(tool: Safety.name(of: intent), tier: tier.rawValue, source: source, result: "blocked: assistant paused"))
            return "The assistant is paused — turn it back on in Activity."
        }
        if tier == .outbound && !confirmed {
            a.requestConfirm(intent, source: source)
            return "Waiting for your OK…"
        }
        let result = execute(intent)
        Audit.record(AuditEntry(tool: Safety.name(of: intent), tier: tier.rawValue, source: source, result: result))
        return result
    }

    @MainActor
    private static func execute(_ intent: MalayalamIntent) -> String {
        switch intent {
        case .none:
            return ""
        case .callMe(let text):
            AssistantModel.shared.callPhone(text, fallbackSpeak: true)
            return "Calling your phone…"
        case .remindCall(let text, let date):
            AssistantModel.shared.addReminder(text, at: date, ring: true)
            let f = DateFormatter(); f.timeStyle = .short; f.dateStyle = Calendar.current.isDateInToday(date) ? .none : .short
            return "I'll ring your phone at \(f.string(from: date)): \(text)"
        case .quitApp(let name):
            guard let app = NSWorkspace.shared.runningApplications.first(where: { ($0.localizedName ?? "").lowercased() == name.lowercased() && $0.activationPolicy == .regular }) else { return "\(name) isn't running" }
            return app.terminate() ? "Asked \(name) to quit" : "\(name) didn't quit"
        case .findFiles(let query):
            return AssistantModel.shared.findFiles(query)
        case .battery:
            return SystemInfo.batteryLine()
        case .whatsappVoice(let name):
            return WhatsAppVoice.shared.start(contact: name)
        case .whatsappReply(let name, let text, let voice):
            Task { @MainActor in
                let line = await WhatsAppVoice.shared.prepare(contact: name, text: text, voice: voice)
                AssistantModel.shared.feedback = line
                Audit.record(AuditEntry(tool: "whatsapp_reply", tier: Tier.outbound.rawValue, source: "rule", result: line))
            }
            return "Preparing your \(voice ? "voice" : "text") message to \(name)…"
        case .lookAtScreen(let question):
            ScreenLook.shared.run(question: question)
            return "Looking at your screen…"
        case .openURL(let raw):
            guard let u = URL(string: raw), u.scheme == "https",
                  let host = u.host?.lowercased(), host == "youtube.com" || host == "www.youtube.com" || host == "youtu.be" else {
                return "I only open YouTube links"
            }
            NSWorkspace.shared.open(u)
            return "Opened the video"
        case .tidyApply:
            AssistantModel.shared.tidyDesktop()
            return AssistantModel.shared.feedback
        case .briefing:
            AssistantModel.shared.briefing()
            return "Reading your day…"
        case .remember(let text):
            ProfileModel.shared.add(text, source: "typed")
            return "I'll remember that: \(text)"
        case .remind(let text, let date):
            AssistantModel.shared.addReminder(text, at: date)
            FirstSteps.shared.mark(.remind)
            let f = DateFormatter(); f.timeStyle = .short; f.dateStyle = Calendar.current.isDateInToday(date) ? .none : .short
            return "Reminder set for \(f.string(from: date)): \(text)"
        case .timer(let seconds):
            AssistantModel.shared.addReminder("Your \(seconds >= 60 ? "\(seconds / 60)-minute" : "\(seconds)-second") timer is up", at: Date().addingTimeInterval(TimeInterval(seconds)))
            return "Timer set for \(seconds >= 60 ? "\(seconds / 60) min" : "\(seconds) s")"
        case .tidyDesktop:
            AssistantModel.shared.scanDesktop()
            NotchModel.shared.tab = .assistant
            return "Here's the plan — press Tidy to apply it"
        case .translateClipboard:
            AssistantModel.shared.translateClipboard()
            return "Translating the clipboard…"
        case .media(let command):
            NowPlayingModel.shared.sendCommand(command)
            return "Done"
        case .brightness(let target, let delta):
            guard let cur = SystemControls.brightness() else { return "I can't change this display's brightness" }
            let new = target.map { Float($0) / 100 } ?? min(max(cur + Float(delta) / 100, 0), 1)
            return SystemControls.setBrightness(new) ? "Brightness \(Int((new * 100).rounded()))%" : "I can't change this display's brightness"
        case .volume(let target, let delta):
            let cur = SystemControls.volume() ?? 50
            let new = min(max(target ?? (cur + delta), 0), 100)
            SystemControls.setVolume(new)
            return new == 0 ? "Muted" : "Volume \(new)%"
        case .appearance(let mode):
            return SystemControls.setAppearance(mode) ? "Switched to \(mode == "toggle" ? "the other" : mode) mode" : "Couldn't change the appearance (allow Automation for System Events)"
        case .openApp(let name):
            if let url = findApp(named: name) {
                NSWorkspace.shared.openApplication(at: url, configuration: NSWorkspace.OpenConfiguration())
                return "Opened \(url.deletingPathExtension().lastPathComponent)"
            }
            return "Couldn't find an app called \(name)"
        case .whatsApp(let contact, let text):
            var comps = URLComponents()
            comps.scheme = "whatsapp"
            comps.host = "send"
            var items: [URLQueryItem] = []
            var line = "Opened WhatsApp"
            if let contact, let number = number(for: contact) {
                items.append(URLQueryItem(name: "phone", value: number))
                line = "WhatsApp to \(contact)"
            } else if let contact {
                line = "WhatsApp — pick \(contact)"
            }
            if let text, !text.isEmpty { items.append(URLQueryItem(name: "text", value: text)) }
            comps.queryItems = items.isEmpty ? nil : items
            if let url = comps.url, NSWorkspace.shared.open(url) {
                return text == nil ? line : line + " (message ready, press Send)"
            }
            if let app = findApp(named: "whatsapp") {
                NSWorkspace.shared.openApplication(at: app, configuration: NSWorkspace.OpenConfiguration())
                return "Opened WhatsApp"
            }
            return "WhatsApp is not installed"
        }
    }

    static func number(for contact: String) -> String? {
        let key = contact.lowercased()
        return contacts.first(where: { $0.key.lowercased() == key })?.value
    }

    /// Case-insensitive search of the usual application folders.
    static func findApp(named name: String) -> URL? {
        let wanted = name.lowercased().replacingOccurrences(of: " ", with: "")
        let dirs = ["/Applications", "/System/Applications", "/System/Applications/Utilities",
                    NSHomeDirectory() + "/Applications", "/Applications/Utilities"]
        let fm = FileManager.default
        var best: URL?
        for d in dirs {
            guard let items = try? fm.contentsOfDirectory(atPath: d) else { continue }
            for item in items where item.hasSuffix(".app") {
                let base = String(item.dropLast(4)).lowercased().replacingOccurrences(of: " ", with: "")
                if base == wanted { return URL(fileURLWithPath: d + "/" + item) }
                if best == nil, base.contains(wanted) || wanted.contains(base) { best = URL(fileURLWithPath: d + "/" + item) }
            }
        }
        return best
    }
}

/// Brightness, volume and appearance. Brightness uses the system DisplayServices framework (the same call the
/// keyboard keys use); it works on the built-in display and may not on every external one.
enum SystemControls {
    private typealias GetB = @convention(c) (UInt32, UnsafeMutablePointer<Float>) -> Int32
    private typealias SetB = @convention(c) (UInt32, Float) -> Int32
    private static let lib = dlopen("/System/Library/PrivateFrameworks/DisplayServices.framework/DisplayServices", RTLD_NOW)

    static func brightness() -> Float? {
        guard let lib, let sym = dlsym(lib, "DisplayServicesGetBrightness") else { return nil }
        var v: Float = 0
        return unsafeBitCast(sym, to: GetB.self)(CGMainDisplayID(), &v) == 0 ? v : nil
    }
    static func setBrightness(_ v: Float) -> Bool {
        guard let lib, let sym = dlsym(lib, "DisplayServicesSetBrightness") else { return false }
        return unsafeBitCast(sym, to: SetB.self)(CGMainDisplayID(), v) == 0
    }
    static func volume() -> Int? {
        var err: NSDictionary?
        let r = NSAppleScript(source: "output volume of (get volume settings)")?.executeAndReturnError(&err)
        return err == nil ? Int(r?.int32Value ?? 50) : nil
    }
    static func setVolume(_ n: Int) {
        var err: NSDictionary?
        _ = NSAppleScript(source: "set volume output volume \(n)")?.executeAndReturnError(&err)
    }
    static func setAppearance(_ mode: String) -> Bool {
        let value = mode == "dark" ? "true" : mode == "light" ? "false" : "not dark mode"
        var err: NSDictionary?
        _ = NSAppleScript(source: "tell application \"System Events\" to tell appearance preferences to set dark mode to \(value)")?.executeAndReturnError(&err)
        return err == nil
    }
}
