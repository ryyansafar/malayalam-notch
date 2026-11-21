//
//  AssistantExtras.swift — Malayalam Notch
//  Confirm cards, phone calls (Sarvam Voice Agents) with a local fallback, file search, the daily
//  briefing and system info.
//

import AppKit
import Foundation
import IOKit.ps

extension AssistantModel {

    // MARK: Confirmation (tier T2)
    func requestConfirm(_ intent: MalayalamIntent, source: String) {
        pending = PendingAction(intent: intent, source: source)
        NotchModel.shared.tab = .assistant
        NotchModel.shared.pinnedUntil = Date().addingTimeInterval(22)
        NotchModel.shared.setOpen(true)
    }

    func confirmPending() {
        guard let p = pending else { return }
        pending = nil
        feedback = MalayalamActions.perform(p.intent, confirmed: true, source: p.source)
    }

    func cancelPending(reason: String = "cancelled") {
        guard let p = pending else { return }
        pending = nil
        feedback = "Okay, I didn't do that."
        Audit.record(AuditEntry(tool: Safety.name(of: p.intent), tier: Safety.tier(of: p.intent).rawValue, source: p.source, result: reason))
    }

    // MARK: Phone call (Sarvam Voice Agents), falling back to speaking it here
    func callPhone(_ text: String, fallbackSpeak: Bool) {
        let serverURL = URL(string: "http://localhost:\(ProcessInfo.processInfo.environment["MALAYALAM_PORT"] ?? "3000")")!
        Task {
            guard phone.hasPrefix("+") else {
                feedback = "Add your phone number (+91…) in Activity to get calls."
                if fallbackSpeak { await speak("Reminder. \(text)") }
                return
            }
            var req = URLRequest(url: serverURL.appendingPathComponent("api/call"))
            req.httpMethod = "POST"; req.timeoutInterval = 20
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            req.httpBody = try? JSONSerialization.data(withJSONObject: ["phone": phone, "reminderText": text, "userName": userName.isEmpty ? "friend" : userName])
            if let (data, resp) = try? await URLSession.shared.data(for: req), (resp as? HTTPURLResponse)?.statusCode == 200,
               let j = try? JSONSerialization.jsonObject(with: data) as? [String: Any], j["ok"] as? Bool == true {
                feedback = "Calling your phone now…"
                return
            }
            feedback = "The phone line isn't available, so I spoke it here instead."
            if fallbackSpeak { await speak("Reminder. \(text)") }
        }
    }

    // MARK: Files (Spotlight, names only, nothing leaves the Mac)
    func findFiles(_ query: String) -> String {
        let q = query.replacingOccurrences(of: "\"", with: "").replacingOccurrences(of: "'", with: "")
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/bin/mdfind")
        p.arguments = ["-onlyin", NSHomeDirectory(), "-name", q]
        let pipe = Pipe(); p.standardOutput = pipe; p.standardError = Pipe()
        do { try p.run() } catch { return "Search isn't available" }
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        p.waitUntilExit()
        let paths = (String(data: data, encoding: .utf8) ?? "").split(separator: "\n").map(String.init)
            .filter { !$0.contains("/Library/") && !$0.contains("/.") }
        foundFiles = Array(paths.prefix(6))
        guard let first = paths.first else { return "I couldn't find “\(query)”" }
        NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: first)])
        return "Found \(paths.count) — showing the first in Finder"
    }

    // MARK: Briefing (spoken in Malayalam by Sarvam)
    func briefing() {
        let name = userName.isEmpty ? "" : " \(userName)"
        var parts = ["Good day\(name)."]
        parts.append(SystemInfo.batteryLine() + ".")
        let next = upcoming.prefix(3)
        if next.isEmpty { parts.append("You have no reminders.") }
        else {
            let f = DateFormatter(); f.timeStyle = .short; f.dateStyle = .none
            parts.append("You have \(upcoming.count) reminder\(upcoming.count == 1 ? "" : "s"): " + next.map { "\($0.text) at \(f.string(from: $0.fire))" }.joined(separator: ", ") + ".")
        }
        let line = parts.joined(separator: " ")
        briefingText = line
        Task { await speak(line, lang: "ml-IN") }
    }
}

enum SystemInfo {
    /// "Battery 62%, charging" or "Battery 80%, on battery".
    static func batteryLine() -> String {
        guard let b = battery() else { return "No battery found" }
        return "Battery \(b.percent) percent, \(b.charging ? "charging" : "on battery power")"
    }

    static func battery() -> (percent: Int, charging: Bool)? {
        guard let info = IOPSCopyPowerSourcesInfo()?.takeRetainedValue(),
              let list = IOPSCopyPowerSourcesList(info)?.takeRetainedValue() as? [CFTypeRef], let src = list.first,
              let d = IOPSGetPowerSourceDescription(info, src)?.takeUnretainedValue() as? [String: Any],
              let cur = d[kIOPSCurrentCapacityKey] as? Int, let max = d[kIOPSMaxCapacityKey] as? Int, max > 0 else { return nil }
        return (cur * 100 / max, (d[kIOPSIsChargingKey] as? Bool) ?? false)
    }

    static func diskFreeGB() -> Int? {
        let v = try? URL(fileURLWithPath: "/").resourceValues(forKeys: [.volumeAvailableCapacityForImportantUsageKey])
        return v?.volumeAvailableCapacityForImportantUsage.map { Int($0 / 1_000_000_000) }
    }

    static func uptimeText() -> String {
        let s = Int(ProcessInfo.processInfo.systemUptime)
        return s >= 86400 ? "\(s / 86400)d \((s % 86400) / 3600)h" : "\(s / 3600)h \((s % 3600) / 60)m"
    }
}
