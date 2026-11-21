//
//  WhatsAppVoice.swift — Malayalam Notch
//  "Open the latest voice message from Amma": finds the newest voice note WhatsApp Desktop has stored for that
//  person, reads it with the voice-note reader (script, English letters, English), then offers a reply that is
//  prepared in the chat as text or as a voice (audio) message. Sending is always a deliberate step: the notch
//  asks first, prepares the chat, and the last key press is yours.
//  Reading WhatsApp's folder needs Full Disk Access (macOS privacy); without it the notch says so.
//

import AppKit
import SwiftUI

enum WhatsAppMedia {
    static var base: URL {
        FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Group Containers/group.net.whatsapp.WhatsApp.shared/Message/Media", isDirectory: true)
    }

    enum Result { case found(URL), none, noAccess }

    /// The newest .opus under the chat folder whose name contains the contact's number (last 10 digits).
    static func newestVoiceNote(number: String, base: URL = WhatsAppMedia.base) -> Result {
        let fm = FileManager.default
        let digits = number.filter { $0.isNumber }
        let tail = String(digits.suffix(10))
        guard !tail.isEmpty else { return .none }
        guard let chats = try? fm.contentsOfDirectory(at: base, includingPropertiesForKeys: nil, options: [.skipsHiddenFiles]) else {
            return fm.fileExists(atPath: base.path) ? .noAccess : .none
        }
        var best: (url: URL, date: Date)?
        for chat in chats where chat.lastPathComponent.contains(tail) {
            guard let e = fm.enumerator(at: chat, includingPropertiesForKeys: [.contentModificationDateKey], options: [.skipsHiddenFiles]) else { continue }
            for case let f as URL in e where f.pathExtension.lowercased() == "opus" {
                let d = (try? f.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate) ?? .distantPast
                if best == nil || d > best!.date { best = (f, d) }
            }
        }
        return best.map { .found($0.url) } ?? .none
    }
}

@MainActor
final class WhatsAppVoice: ObservableObject {
    static let shared = WhatsAppVoice()
    @Published var contact: String?              // set while there is a note to answer
    @Published var status = ""
    @Published var needsAccess = false
    @Published var reply = ""
    @Published var asVoice = false
    private enum Step { case none, askReply, askMessage, askMode }
    private var step: Step = .none

    private let server = URL(string: "http://localhost:\(ProcessInfo.processInfo.environment["MALAYALAM_PORT"] ?? "3000")")!

    func start(contact name: String) -> String {
        needsAccess = false
        guard let number = MalayalamActions.number(for: name) else {
            status = "I don't have \(name)'s number. Add it in Me, under People."
            NotchModel.shared.tab = .me; NotchModel.shared.setOpen(true)
            return status
        }
        switch WhatsAppMedia.newestVoiceNote(number: number) {
        case .noAccess:
            needsAccess = true
            status = "Allow Full Disk Access for Malayalam Notch so I can read WhatsApp voice notes."
        case .none:
            status = "I couldn't find a voice note from \(name). Open the chat in WhatsApp once so it downloads."
        case .found(let url):
            // Work on a copy: WhatsApp's own file is never touched.
            let copy = FileManager.default.temporaryDirectory.appendingPathComponent("wa-\(UUID().uuidString.prefix(6)).opus")
            try? FileManager.default.removeItem(at: copy)
            do { try FileManager.default.copyItem(at: url, to: copy) } catch { status = "I couldn't read that file."; break }
            contact = name; reply = ""; asVoice = false
            status = "Reading \(name)'s latest voice note…"
            NotchModel.shared.tab = .voice
            NotchModel.shared.pinnedUntil = Date().addingTimeInterval(60)
            NotchModel.shared.setOpen(true)
            MalayalamViewModel.shared.handleDrop(url: copy)
            Task { await self.beginDialogueWhenRead() }
        }
        if contact == nil { NotchModel.shared.pinnedUntil = Date().addingTimeInterval(15); NotchModel.shared.setOpen(true) }
        return status
    }

    // MARK: The conversation: it asks, waits for your voice, then acts on the answer

    /// Once the voice note has been read, ask whether to reply and listen for the answer.
    private func beginDialogueWhenRead() async {
        let vm = MalayalamViewModel.shared
        for _ in 0..<160 {     // up to ~40 s for the reading to finish
            if vm.note != nil, vm.phase == .idle { break }
            try? await Task.sleep(nanoseconds: 250_000_000)
        }
        guard let name = contact, vm.note != nil else { return }
        step = .askReply
        await ask("Do you want to reply to \(name)?")
    }

    private func ask(_ question: String) async {
        status = question
        await AssistantModel.shared.speakAndWait(question)
        guard step != .none else { return }
        MalayalamViewModel.shared.startRecording()
        NotchModel.shared.recording = true
    }

    func dialogueEnded() { if step != .none { step = .none; status = "I stopped listening. Tap the mic to continue." } }

    /// An answer heard from the microphone. Returns true when it belonged to the conversation.
    func handleSpoken(english: String, source: String) -> Bool {
        guard step != .none, let name = contact else { return false }
        let said = english.lowercased()
        switch step {
        case .askReply:
            let yes = ["yes", "yeah", "yep", "sure", "ok", "okay", "please", "reply", "do it", "go ahead"].contains { said.contains($0) } || source.contains("അതെ") || source.contains("ശരി") || source.contains("വേണം")
            if yes { step = .askMessage; Task { await ask("Okay. What should I say?") } }
            else { step = .none; status = "Okay, no reply."; Task { await AssistantModel.shared.speak("Okay.") } }
        case .askMessage:
            let text = (source.isEmpty ? english : source).trimmingCharacters(in: .whitespacesAndNewlines)
            guard !text.isEmpty else { Task { await ask("I didn't catch that. What should I say?") }; return true }
            reply = text; step = .askMode
            Task { await ask("Should I send it as text or as a voice message?") }
        case .askMode:
            asVoice = said.contains("voice") || said.contains("audio") || said.contains("speak")
            step = .none
            status = "Please check the message on screen."
            Task { await AssistantModel.shared.speak("Please check the message on screen.") }
            _ = MalayalamActions.perform(.whatsappReply(contact: name, text: reply, voice: asVoice), source: "rule")
        case .none: break
        }
        return true
    }

    func openFullDiskAccessSettings() {
        if let u = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles") { NSWorkspace.shared.open(u) }
    }

    /// Prepare the reply in WhatsApp. Text: the chat opens with the message ready. Voice: a spoken audio file is
    /// made and pasted into the chat. The last key press (send) stays yours.
    func prepare(contact name: String, text: String, voice: Bool) async -> String {
        guard let number = MalayalamActions.number(for: name) else { return "I don't have \(name)'s number." }
        var comps = URLComponents(); comps.scheme = "whatsapp"; comps.host = "send"
        var items = [URLQueryItem(name: "phone", value: number.filter { $0.isNumber })]
        if !voice { items.append(URLQueryItem(name: "text", value: text)) }
        comps.queryItems = items
        if !voice {
            guard let url = comps.url, NSWorkspace.shared.open(url) else { return "I couldn't open WhatsApp." }
            return "Your message to \(name) is ready in WhatsApp. Press Return to send."
        }
        guard let audio = await speechFile(for: text) else { return "I couldn't make the voice message. Try text instead." }
        let pb = NSPasteboard.general
        pb.clearContents(); pb.writeObjects([audio as NSURL])
        if let url = comps.url { NSWorkspace.shared.open(url) }
        try? await Task.sleep(nanoseconds: 1_600_000_000)
        if AXIsProcessTrusted() {
            let src = CGEventSource(stateID: .hidSystemState)
            let down = CGEvent(keyboardEventSource: src, virtualKey: 9, keyDown: true); down?.flags = .maskCommand      // ⌘V
            let up = CGEvent(keyboardEventSource: src, virtualKey: 9, keyDown: false); up?.flags = .maskCommand
            down?.post(tap: .cghidEventTap); up?.post(tap: .cghidEventTap)
            return "The voice message is in your chat to \(name). Press Return to send."
        }
        return "The voice message is on your clipboard and the chat is open. Press ⌘V, then Return."
    }

    /// The reply read aloud by Sarvam (Malayalam voice for Malayalam text), saved as an audio file.
    private func speechFile(for text: String) async -> URL? {
        let lang = text.unicodeScalars.contains(where: { (0x0D00...0x0D7F).contains($0.value) }) ? "ml-IN" : "en-IN"
        var req = URLRequest(url: server.appendingPathComponent("api/speak"))
        req.httpMethod = "POST"; req.timeoutInterval = 40
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try? JSONSerialization.data(withJSONObject: ["text": text, "targetLang": lang, "ttsProvider": MalayalamViewModel.shared.ttsProvider])
        guard let (d, r) = try? await URLSession.shared.data(for: req), (r as? HTTPURLResponse)?.statusCode == 200,
              let j = try? JSONSerialization.jsonObject(with: d) as? [String: Any],
              let b64 = j["ttsAudioBase64"] as? String, let wav = Data(base64Encoded: b64) else { return nil }
        let dir = FileManager.default.temporaryDirectory
        let wavURL = dir.appendingPathComponent("reply-\(UUID().uuidString.prefix(6)).wav")
        let m4a = wavURL.deletingPathExtension().appendingPathExtension("m4a")
        guard (try? wav.write(to: wavURL)) != nil else { return nil }
        let p = Process(); p.executableURL = URL(fileURLWithPath: "/usr/bin/afconvert")
        p.arguments = [wavURL.path, m4a.path, "-f", "m4af", "-d", "aac"]
        try? p.run(); p.waitUntilExit()
        return FileManager.default.fileExists(atPath: m4a.path) ? m4a : wavURL
    }
}

/// Shown under a voice note read from WhatsApp: write a reply, pick text or voice, send.
struct WhatsAppReplyBar: View {
    @ObservedObject private var w = WhatsAppVoice.shared
    var body: some View {
        if let name = w.contact {
            VStack(alignment: .leading, spacing: 8) {
                HStack(spacing: 8) {
                    TextField("Reply to \(name)", text: $w.reply).textFieldStyle(.plain).font(.system(size: 15))
                        .padding(.horizontal, 12).frame(height: 36).background(Capsule().fill(Color.white.opacity(0.09)))
                    Picker("", selection: $w.asVoice) { Text("Text").tag(false); Text("Voice").tag(true) }
                        .pickerStyle(.segmented).frame(width: 130).labelsHidden()
                    Chip(symbol: "paperplane.fill", text: "Send", primary: true) {
                        let t = w.reply.trimmingCharacters(in: .whitespacesAndNewlines)
                        guard !t.isEmpty else { return }
                        _ = MalayalamActions.perform(.whatsappReply(contact: name, text: t, voice: w.asVoice), source: "rule")
                    }
                }
            }
        } else if w.needsAccess {
            HStack(spacing: 10) {
                Text(w.status).font(Design.Font.caption).foregroundStyle(.white.opacity(Design.Text.secondary)).lineLimit(2)
                Chip(symbol: "lock.open", text: "Open settings") { w.openFullDiskAccessSettings() }
            }
        } else if !w.status.isEmpty {
            Text(w.status).font(Design.Font.caption).foregroundStyle(.white.opacity(Design.Text.secondary)).lineLimit(2)
        }
    }
}

/// Me tab: the people you message. A name and a number is all it takes.
struct PeopleEditor: View {
    @State private var name = ""
    @State private var number = ""
    @State private var people = MalayalamActions.contacts
    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 6) {
                TextField("Name", text: $name).textFieldStyle(.plain).font(.system(size: 14)).frame(width: 90)
                    .padding(.horizontal, 10).frame(height: 28).background(Capsule().fill(Color.white.opacity(0.09)))
                TextField("+91 number", text: $number).textFieldStyle(.plain).font(.system(size: 14))
                    .padding(.horizontal, 10).frame(height: 28).background(Capsule().fill(Color.white.opacity(0.09)))
                Button { add() } label: { Image(systemName: "plus.circle.fill").font(.system(size: 20)).foregroundStyle(MalayalamTheme.accent) }
                    .buttonStyle(.plain).disabled(name.trimmingCharacters(in: .whitespaces).isEmpty || number.filter { $0.isNumber }.count < 8)
            }
            if !people.isEmpty {
                HStack(spacing: 6) {
                    ForEach(people.keys.sorted(), id: \.self) { n in
                        HStack(spacing: 4) {
                            Text(n).font(Design.Font.caption)
                            Button { var c = MalayalamActions.contacts; c[n] = nil; MalayalamActions.contacts = c; people = c } label: { Image(systemName: "xmark").font(.system(size: 9, weight: .bold)) }.buttonStyle(.plain)
                        }
                        .padding(.horizontal, 9).frame(height: 24).background(Capsule().fill(Color.white.opacity(0.1)))
                    }
                }
            }
        }
    }
    private func add() {
        var c = MalayalamActions.contacts
        c[name.trimmingCharacters(in: .whitespaces)] = number.filter { $0.isNumber }
        MalayalamActions.contacts = c; people = c; name = ""; number = ""
    }
}
