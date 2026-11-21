//
//  MalayalamIntent.swift — Malayalam Notch
//  Local, rule-based understanding of a spoken or typed command, run on English text (what
//  Sarvam returns for speech). No network, no model: "open WhatsApp", "remind me to call Amma
//  in 10 minutes", "set a timer for 5 minutes", "tidy my desktop" all work offline. Anything
//  these rules do not recognise can go to the agent (server /api/agent).
//

import Foundation

enum MalayalamIntent: Equatable {
    case openApp(name: String)
    case whatsApp(contact: String?, text: String?)
    case remind(text: String, at: Date)
    case timer(seconds: Int)
    case tidyDesktop
    case translateClipboard
    case media(command: String)          // "playpause" | "next track" | "previous track"
    case none
}

enum MalayalamIntentParser {

    private static let openVerbs = ["open", "launch", "start", "run", "go to"]
    private static let sendVerbs = ["message", "text", "send", "tell", "whatsapp", "write to", "ping"]
    private static let words: [String: Int] = ["a": 1, "an": 1, "one": 1, "two": 2, "three": 3, "four": 4, "five": 5, "six": 6, "seven": 7,
                                               "eight": 8, "nine": 9, "ten": 10, "fifteen": 15, "twenty": 20, "thirty": 30, "forty": 40,
                                               "forty-five": 45, "sixty": 60, "half": 30]

    static func parse(_ raw: String, now: Date = Date()) -> MalayalamIntent {
        let text = raw.trimmingCharacters(in: .whitespacesAndNewlines).trimmingCharacters(in: CharacterSet(charactersIn: ".!?,;:"))
        guard !text.isEmpty else { return .none }
        let lower = text.lowercased()

        if let r = parseReminder(lower, original: text, now: now) { return r }
        if let t = parseTimer(lower) { return t }
        if lower.range(of: #"\b(tidy|clean|organi[sz]e|sort)\b.*\bdesktop\b|\bdesktop\b.*\b(tidy|clean|organi[sz]e)"#, options: .regularExpression) != nil { return .tidyDesktop }
        if lower.contains("clipboard") && (lower.contains("translate") || lower.contains("read")) { return .translateClipboard }
        if let m = parseMedia(lower) { return m }
        if let wa = parseWhatsApp(lower, original: text) { return wa }

        for verb in openVerbs where lower.hasPrefix(verb + " ") {
            var rest = String(lower.dropFirst(verb.count + 1))
            for filler in ["the ", "my ", "app ", "the app "] where rest.hasPrefix(filler) { rest.removeFirst(filler.count) }
            rest = rest.replacingOccurrences(of: " app", with: "").trimmingCharacters(in: .whitespaces)
            if !rest.isEmpty { return .openApp(name: rest) }
        }
        return .none
    }

    // MARK: Reminders and timers

    static func parseReminder(_ lower: String, original: String, now: Date) -> MalayalamIntent? {
        guard let m = lower.range(of: #"^(remind me|set (?:a )?reminder|reminder)\b"#, options: .regularExpression) else { return nil }
        var rest = String(lower[m.upperBound...]).trimmingCharacters(in: .whitespaces)
        for f in ["to ", "about ", "that ", "for "] where rest.hasPrefix(f) { rest.removeFirst(f.count); break }
        let (task, date) = splitWhen(rest, now: now)
        let cleaned = task.trimmingCharacters(in: .whitespaces)
        guard !cleaned.isEmpty else { return nil }
        // Keep the original casing of the task when it appears verbatim.
        let display = original.range(of: cleaned, options: .caseInsensitive).map { String(original[$0]) } ?? cleaned
        return .remind(text: display, at: date ?? now.addingTimeInterval(3600))
    }

    static func parseTimer(_ lower: String) -> MalayalamIntent? {
        guard lower.contains("timer") || lower.hasPrefix("countdown") else { return nil }
        guard let secs = durationSeconds(in: lower) else { return nil }
        return .timer(seconds: secs)
    }

    /// Splits "<task> in 10 minutes" / "<task> at 5 pm" / "<task> tomorrow at 9" into (task, date).
    static func splitWhen(_ s: String, now: Date) -> (String, Date?) {
        if let r = s.range(of: #"\s+in\s+(\d+|[a-z-]+)\s*(seconds?|secs?|minutes?|mins?|hours?|hrs?|days?)\b"#, options: .regularExpression) {
            let phrase = String(s[r])
            let task = String(s[..<r.lowerBound])
            if let secs = durationSeconds(in: phrase) { return (task, now.addingTimeInterval(TimeInterval(secs))) }
        }
        let tomorrow = s.range(of: #"\s+tomorrow\b"#, options: .regularExpression)
        if let r = s.range(of: #"\s+at\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b"#, options: .regularExpression) {
            let phrase = String(s[r])
            var task = String(s[..<r.lowerBound])
            if let t = tomorrow { task = task.replacingOccurrences(of: s[t], with: "") }
            if let d = clock(from: phrase, now: now, tomorrow: tomorrow != nil) { return (task, d) }
        }
        if let t = tomorrow {
            let task = String(s[..<t.lowerBound])
            let cal = Calendar.current
            let d = cal.date(bySettingHour: 9, minute: 0, second: 0, of: cal.date(byAdding: .day, value: 1, to: now)!)
            return (task, d)
        }
        return (s, nil)
    }

    private static func durationSeconds(in s: String) -> Int? {
        guard let re = try? NSRegularExpression(pattern: #"(\d+|[a-z]+(?:-[a-z]+)?)\s*(seconds?|secs?|minutes?|mins?|hours?|hrs?|days?)\b"#),
              let m = re.firstMatch(in: s, range: NSRange(s.startIndex..., in: s)),
              let nr = Range(m.range(at: 1), in: s), let ur = Range(m.range(at: 2), in: s) else { return nil }
        let token = String(s[nr])
        guard let n = Int(token) ?? words[token] else { return nil }
        let unit = String(s[ur])
        if unit.hasPrefix("sec") { return n }
        if unit.hasPrefix("min") { return n * 60 }
        if unit.hasPrefix("h") { return n * 3600 }
        if unit.hasPrefix("d") { return n * 86400 }
        return nil
    }

    private static func clock(from phrase: String, now: Date, tomorrow: Bool) -> Date? {
        guard let re = try? NSRegularExpression(pattern: #"(\d{1,2})(?::(\d{2}))?\s*(am|pm)?"#),
              let m = re.firstMatch(in: phrase, range: NSRange(phrase.startIndex..., in: phrase)),
              let hr = Range(m.range(at: 1), in: phrase), var h = Int(phrase[hr]) else { return nil }
        var min = 0
        if m.range(at: 2).location != NSNotFound, let mr = Range(m.range(at: 2), in: phrase) { min = Int(phrase[mr]) ?? 0 }
        if m.range(at: 3).location != NSNotFound, let ar = Range(m.range(at: 3), in: phrase) {
            let ap = phrase[ar]
            if ap == "pm" && h < 12 { h += 12 } else if ap == "am" && h == 12 { h = 0 }
        }
        guard h < 24, min < 60 else { return nil }
        let cal = Calendar.current
        var d = cal.date(bySettingHour: h, minute: min, second: 0, of: now)!
        if tomorrow { d = cal.date(byAdding: .day, value: 1, to: d)! }
        else if d <= now { d = cal.date(byAdding: .day, value: 1, to: d)! }
        return d
    }

    // MARK: Media and WhatsApp

    private static func parseMedia(_ lower: String) -> MalayalamIntent? {
        if lower.range(of: #"^(pause|resume|play|stop)( the)?( music| song)?$|^play pause$"#, options: .regularExpression) != nil { return .media(command: "playpause") }
        if lower.range(of: #"^(next|skip)( the)?( song| track)?$"#, options: .regularExpression) != nil { return .media(command: "next track") }
        if lower.range(of: #"^(previous|go back|last)( the)?( song| track)?$"#, options: .regularExpression) != nil { return .media(command: "previous track") }
        return nil
    }

    private static func parseWhatsApp(_ lower: String, original: String) -> MalayalamIntent? {
        guard lower.contains("whatsapp") || lower.contains("whats app") else {
            return parseMessage(lower, original: original)
        }
        return parseMessage(lower, original: original) ?? .whatsApp(contact: nil, text: nil)
    }

    private static func parseMessage(_ lower: String, original: String) -> MalayalamIntent? {
        guard let verb = sendVerbs.first(where: { lower.hasPrefix($0 + " ") }) else { return nil }
        var rest = String(lower.dropFirst(verb.count + 1))
        rest = rest.replacingOccurrences(of: "on whatsapp", with: "").replacingOccurrences(of: "on whats app", with: "")
            .replacingOccurrences(of: "via whatsapp", with: "").trimmingCharacters(in: .whitespaces)
        for filler in ["a message to ", "message to ", "to "] where rest.hasPrefix(filler) { rest.removeFirst(filler.count) }
        var contact = rest
        var body: String?
        for m in [" saying ", " that ", " to say ", ": ", ", "] {
            if let r = rest.range(of: m) {
                contact = String(rest[..<r.lowerBound])
                body = String(rest[r.upperBound...]).trimmingCharacters(in: .whitespaces)
                break
            }
        }
        contact = contact.trimmingCharacters(in: .whitespaces)
        if contact.isEmpty { return nil }
        if let b = body, let r = original.range(of: b, options: .caseInsensitive) { body = String(original[r]) }
        return .whatsApp(contact: contact.capitalized, text: body)
    }
}
