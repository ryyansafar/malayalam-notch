//
//  MalayalamIntent.swift
//  boringNotch (Malayalam fork)
//
//  Local, rule-based understanding of a spoken command, run on the English text
//  that Sarvam returns for the speech. No network, no model: plain Swift rules, so
//  "open WhatsApp" or "message Amma on WhatsApp saying I am late" works offline once
//  the words have been transcribed.
//

import Foundation

enum MalayalamIntent: Equatable {
    case openApp(name: String)
    case whatsApp(contact: String?, text: String?)
    case none
}

enum MalayalamIntentParser {

    private static let openVerbs = ["open", "launch", "start", "run", "go to"]
    private static let sendVerbs = ["message", "text", "send", "tell", "whatsapp", "write to", "ping"]

    /// Parse English text. Returns .none when nothing actionable is recognised.
    static func parse(_ raw: String) -> MalayalamIntent {
        let text = raw
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .trimmingCharacters(in: CharacterSet(charactersIn: ".!?,;:"))
        guard !text.isEmpty else { return .none }
        let lower = text.lowercased()

        if let wa = parseWhatsApp(lower, original: text) { return wa }

        for verb in openVerbs where lower.hasPrefix(verb + " ") {
            var rest = String(lower.dropFirst(verb.count + 1))
            for filler in ["the ", "my ", "app ", "the app "] where rest.hasPrefix(filler) { rest.removeFirst(filler.count) }
            rest = rest.replacingOccurrences(of: " app", with: "").trimmingCharacters(in: .whitespaces)
            if !rest.isEmpty { return .openApp(name: rest) }
        }
        return .none
    }

    private static func parseWhatsApp(_ lower: String, original: String) -> MalayalamIntent? {
        guard lower.contains("whatsapp") || lower.contains("whats app") else {
            // "message Amma saying ..." without naming the app still means WhatsApp here.
            return parseMessageWithoutApp(lower, original: original)
        }
        return parseMessageWithoutApp(lower, original: original, force: true)
            ?? .whatsApp(contact: nil, text: nil) // "open WhatsApp"
    }

    private static func parseMessageWithoutApp(_ lower: String, original: String, force: Bool = false) -> MalayalamIntent? {
        guard let verb = sendVerbs.first(where: { lower.hasPrefix($0 + " ") }) else { return force ? nil : nil }
        var rest = String(lower.dropFirst(verb.count + 1))
        rest = rest.replacingOccurrences(of: "on whatsapp", with: "")
            .replacingOccurrences(of: "on whats app", with: "")
            .replacingOccurrences(of: "via whatsapp", with: "")
            .trimmingCharacters(in: .whitespaces)
        for filler in ["a message to ", "message to ", "to "] where rest.hasPrefix(filler) { rest.removeFirst(filler.count) }

        // Split "<contact> saying|that|:|to say <body>"
        let markers = [" saying ", " that ", " to say ", ": ", ", "]
        var contact = rest
        var body: String?
        for m in markers {
            if let r = rest.range(of: m) {
                contact = String(rest[..<r.lowerBound])
                body = String(rest[r.upperBound...]).trimmingCharacters(in: .whitespaces)
                break
            }
        }
        contact = contact.trimmingCharacters(in: .whitespaces)
        if contact.isEmpty { return nil }
        // Preserve the original casing of the body (names, punctuation).
        if let b = body, let r = original.range(of: b, options: .caseInsensitive) { body = String(original[r]) }
        return .whatsApp(contact: contact.capitalized, text: body)
    }
}
