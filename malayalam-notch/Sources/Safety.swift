//
//  Safety.swift — Malayalam Notch
//  Every action the assistant can take has a risk tier. Reading is automatic, small reversible changes
//  run and are logged, and anything that reaches another person or can lose work always waits for an
//  on-screen OK. A kill switch stops everything. Every action is written to a local audit log.
//

import AppKit
import Foundation

enum Tier: String {
    case read = "T0 read"            // looks only
    case reversible = "T1 change"    // small, undoable or harmless
    case outbound = "T2 confirm"     // reaches a person, or can lose work: always asks first
}

enum Safety {
    static func tier(of intent: MalayalamIntent) -> Tier {
        switch intent {
        case .none, .battery, .briefing, .findFiles, .translateClipboard, .whatsappVoice, .lookAtScreen: return .read
        case .callMe, .remindCall, .quitApp, .tidyApply, .whatsappReply: return .outbound
        default: return .reversible
        }
    }

    /// One plain line shown on the confirm card, with the exact arguments.
    @MainActor static func describe(_ intent: MalayalamIntent) -> String {
        switch intent {
        case .callMe(let text): return "Ring your phone now and say: “\(text)”"
        case .remindCall(let text, let date):
            let f = DateFormatter(); f.timeStyle = .short; f.dateStyle = Calendar.current.isDateInToday(date) ? .none : .short
            return "Ring your phone at \(f.string(from: date)) and say: “\(text)”"
        case .quitApp(let name): return "Quit \(name). Unsaved work in it could be lost."
        case .whatsappReply(let c, let t, let v):
            return "Send a \(v ? "voice" : "text") message to \(c) in WhatsApp: “\(t)”. I will press Send for you."
        case .tidyApply:
            let n = AssistantModel.shared.plan.reduce(0) { $0 + $1.files.count }
            return "Move \(n) loose files from your Desktop into folders under Desktop/Organized. Undo puts them back."
        default: return "Run this action"
        }
    }

    static func name(of intent: MalayalamIntent) -> String {
        switch intent {
        case .openApp: return "open_app"; case .whatsApp: return "whatsapp"; case .remind: return "remind"
        case .timer: return "timer"; case .tidyDesktop: return "tidy_desktop"; case .translateClipboard: return "translate_clipboard"
        case .media: return "media"; case .brightness: return "set_brightness"; case .volume: return "set_volume"
        case .appearance: return "appearance"; case .callMe: return "call_me"; case .remindCall: return "remind_call"
        case .quitApp: return "quit_app"; case .findFiles: return "find_files"; case .battery: return "battery"
        case .briefing: return "briefing"; case .remember: return "remember"; case .tidyApply: return "tidy_apply"; case .openURL: return "open_url"; case .whatsappVoice: return "whatsapp_voice"; case .whatsappReply: return "whatsapp_reply"; case .lookAtScreen: return "look_at_screen"; case .none: return "none"
        }
    }
}

struct AuditEntry: Codable, Identifiable, Equatable {
    var id = UUID()
    var ts = Date()
    var tool: String
    var tier: String
    var source: String       // "rule" (understood on this Mac) or "agent" (chosen by the cloud model)
    var result: String
}

@MainActor
enum Audit {
    private static var url: URL? = {
        guard let dir = try? FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
            .appendingPathComponent("MalayalamNotch", isDirectory: true) else { return nil }
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir.appendingPathComponent("audit.jsonl")
    }()

    static func record(_ entry: AuditEntry) {
        AssistantModel.shared.audit.insert(entry, at: 0)
        if AssistantModel.shared.audit.count > 40 { AssistantModel.shared.audit.removeLast() }
        guard let url, let data = try? JSONEncoder().encode(entry), var line = String(data: data, encoding: .utf8) else { return }
        line += "\n"
        if let h = try? FileHandle(forWritingTo: url) { h.seekToEndOfFile(); h.write(Data(line.utf8)); try? h.close() }
        else { try? Data(line.utf8).write(to: url); try? FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path) }
    }
}

/// An action waiting for the user's OK. Times out after 20 seconds.
struct PendingAction: Identifiable {
    let id = UUID()
    let intent: MalayalamIntent
    let source: String
    let expires = Date().addingTimeInterval(20)
}
