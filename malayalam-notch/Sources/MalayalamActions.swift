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
    @MainActor @discardableResult
    static func perform(_ intent: MalayalamIntent) -> String {
        switch intent {
        case .none:
            return ""
        case .remind(let text, let date):
            AssistantModel.shared.addReminder(text, at: date)
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

    private static func number(for contact: String) -> String? {
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
