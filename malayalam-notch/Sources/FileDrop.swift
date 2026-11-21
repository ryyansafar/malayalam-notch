//
//  FileDrop.swift — Malayalam Notch
//  Drag any file or folder toward the notch and shake it twice: the island opens as two big areas the
//  size of the open notch. Left: Analyze (read it on this Mac, send only the text found in it to Sarvam for
//  a plain explanation). Right: Clipboard (copy it so it can be pasted or dragged anywhere; if it is still
//  waiting a few minutes later, the notch reminds you). Audio files still go straight to the voice-note reader.
//

import AppKit
import PDFKit
import SwiftUI
import UniformTypeIdentifiers
import UserNotifications
import Vision

struct Extracted { let kind: String; let text: String; let labels: [String] }

enum FileAnalyzer {
    static let textExts: Set<String> = ["txt", "md", "csv", "json", "html", "xml", "swift", "js", "ts", "py", "log", "yaml", "yml", "rtf", "srt", "vtt"]
    static let audioExts: Set<String> = ["opus", "ogg", "m4a", "mp3", "wav", "aac", "amr", "webm", "flac"]

    static func isAudio(_ url: URL) -> Bool { audioExts.contains(url.pathExtension.lowercased()) }
    static func isFolder(_ url: URL) -> Bool { (try? url.resourceValues(forKeys: [.isDirectoryKey]).isDirectory) == true }

    /// Read the file on this Mac. Nothing leaves the Mac here.
    static func extract(_ url: URL) -> Extracted {
        if isFolder(url) { return folder(url) }
        let ext = url.pathExtension.lowercased()
        let type = UTType(filenameExtension: ext)
        if type?.conforms(to: .image) == true { return image(url) }
        if ext == "pdf", let doc = PDFDocument(url: url) {
            return Extracted(kind: "PDF, \(doc.pageCount) pages", text: String((doc.string ?? "").prefix(7000)), labels: [])
        }
        if textExts.contains(ext) || type?.conforms(to: .text) == true, let s = try? String(contentsOf: url, encoding: .utf8) {
            return Extracted(kind: "text file", text: String(s.prefix(7000)), labels: [])
        }
        return Extracted(kind: type?.localizedDescription ?? "file", text: "", labels: [])
    }

    /// A folder: only the names and sizes of what is inside (never the contents of files).
    private static func folder(_ url: URL) -> Extracted {
        let fm = FileManager.default
        let items = (try? fm.contentsOfDirectory(at: url, includingPropertiesForKeys: [.fileSizeKey, .isDirectoryKey], options: [.skipsHiddenFiles])) ?? []
        var lines: [String] = []
        for u in items.sorted(by: { $0.lastPathComponent < $1.lastPathComponent }).prefix(80) {
            let v = try? u.resourceValues(forKeys: [.fileSizeKey, .isDirectoryKey])
            lines.append(v?.isDirectory == true ? "[folder] \(u.lastPathComponent)" : "\(u.lastPathComponent) (\((v?.fileSize ?? 0) / 1024) KB)")
        }
        return Extracted(kind: "folder with \(items.count) items", text: "Folder \(url.lastPathComponent) contains:\n" + lines.joined(separator: "\n"), labels: [])
    }

    private static func image(_ url: URL) -> Extracted {
        guard let src = CGImageSourceCreateWithURL(url as CFURL, nil) else { return Extracted(kind: "image", text: "", labels: []) }
        // A smaller copy reads much faster and loses nothing a person could read.
        let opts: [CFString: Any] = [kCGImageSourceCreateThumbnailFromImageAlways: true, kCGImageSourceCreateThumbnailWithTransform: true, kCGImageSourceThumbnailMaxPixelSize: 2400]
        guard let cg = CGImageSourceCreateThumbnailAtIndex(src, 0, opts as CFDictionary) ?? CGImageSourceCreateImageAtIndex(src, 0, nil) else {
            return Extracted(kind: "image", text: "", labels: [])
        }
        let ocr = VNRecognizeTextRequest()
        ocr.recognitionLevel = .accurate
        ocr.usesLanguageCorrection = true
        ocr.automaticallyDetectsLanguage = false          // automatic detection took minutes on a big screenshot
        if let supported = try? ocr.supportedRecognitionLanguages() {
            let wanted = supported.filter { ["en", "ml", "hi", "ta", "te", "kn", "bn"].contains(String($0.prefix(2))) }
            if !wanted.isEmpty { ocr.recognitionLanguages = wanted }
        }
        let classify = VNClassifyImageRequest()
        try? VNImageRequestHandler(cgImage: cg, options: [:]).perform([ocr, classify])
        let text = (ocr.results ?? []).compactMap { $0.topCandidates(1).first?.string }.joined(separator: "\n")
        let labels = (classify.results ?? []).filter { $0.confidence > 0.3 }.prefix(6).map(\.identifier)
        return Extracted(kind: "image", text: String(text.prefix(7000)), labels: Array(labels))
    }
}

@MainActor
final class DropModel: ObservableObject {
    static let shared = DropModel()
    enum Stage { case idle, working, result }
    enum Action { case analyze, clipboard }

    @Published var armed = false                 // the two big areas are showing
    @Published var stage: Stage = .idle
    @Published var files: [URL] = []
    @Published var result = ""
    @Published var note = ""
    @Published var flying = false                // the file glides toward the Shelf tab
    @Published var shelfPulse = 0                // bumps when it arrives, so the tab icon bounces
    @Published var waiting: [URL] = []           // copied by us and still on the clipboard, not yet pasted
    private var resultAt: Date?
    private var waitingSince: Date?
    private var waitingCount = 0
    private var reminded = false
    private var timer: Timer?
    private let server = URL(string: "http://localhost:\(ProcessInfo.processInfo.environment["MALAYALAM_PORT"] ?? "3000")")!

    func start() {
        guard timer == nil else { return }
        timer = Timer.scheduledTimer(withTimeInterval: 15, repeats: true) { [weak self] _ in MainActor.assumeIsolated { self?.checkWaiting() } }
    }

    var showing: Bool { armed || stage == .working }

    func arm() {
        guard !AssistantModel.shared.paused else { return }
        stage = .idle; files = []; result = ""; note = ""       // a new shake always starts fresh
        armed = true
        NotchModel.shared.pinnedUntil = Date().addingTimeInterval(25)
        NotchModel.shared.setOpen(true)
    }
    func disarmSoon() { DispatchQueue.main.asyncAfter(deadline: .now() + 1.2) { if self.stage == .idle { self.armed = false } } }

    /// A drop that did not land on one of the two areas (for example on the Voice card): audio is read, anything else asks nothing and is analysed.
    func receive(_ urls: [URL]) {
        let urls = urls.filter { $0.isFileURL }
        guard !urls.isEmpty else { return }
        if urls.count == 1, FileAnalyzer.isAudio(urls[0]) { armed = false; MalayalamViewModel.shared.handleDrop(url: urls[0]); return }
        drop(urls, .analyze)
    }

    func drop(_ urls: [URL], _ action: Action) {
        guard !urls.isEmpty else { return }
        files = urls; armed = false; result = ""; note = ""
        NotchModel.shared.pinnedUntil = Date().addingTimeInterval(45)
        switch action {
        case .analyze: analyze()
        case .clipboard: copyToClipboard()
        }
    }

    private func copyToClipboard() {
        let pb = NSPasteboard.general
        pb.clearContents()
        pb.writeObjects(files.map { $0 as NSURL })
        waiting = files; waitingSince = Date(); waitingCount = pb.changeCount; reminded = false
        Audit.record(AuditEntry(tool: "copy_to_clipboard", tier: Tier.reversible.rawValue, source: "drop", result: "\(files.count) item(s)"))
        ShelfModel.shared.add(files)
        note = files.count == 1 ? "On your clipboard and kept on the shelf." : "\(files.count) items on your clipboard and kept on the shelf."
        flying = false
        stage = .result
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.45) { withAnimation(.spring(response: 0.8, dampingFraction: 0.82)) { self.flying = true } }
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.15) { self.shelfPulse += 1 }
        DispatchQueue.main.asyncAfter(deadline: .now() + 2.4) { if self.result.isEmpty { self.dismiss() } }
    }

    func keepOnShelf() { ShelfModel.shared.add(files); note = "Kept on the shelf." }
    func copyResult() { NSPasteboard.general.clearContents(); NSPasteboard.general.setString(result, forType: .string); note = "Explanation copied." }
    func dismiss() { stage = .idle; armed = false; files = []; result = ""; note = ""; flying = false }
    func clearWaiting() { waiting = []; waitingSince = nil }

    /// Something we copied is still waiting: remind once after 5 minutes. Copying anything else clears it.
    private func checkWaiting() {
        if stage == .result, let t = resultAt, Date().timeIntervalSince(t) > 90 { dismiss() }
        guard !waiting.isEmpty, let since = waitingSince else { return }
        if NSPasteboard.general.changeCount != waitingCount { clearWaiting(); return }
        guard !reminded, Date().timeIntervalSince(since) > 300, !AssistantModel.shared.paused else { return }
        reminded = true
        let c = UNMutableNotificationContent(); c.title = "Still on your clipboard"; c.body = waiting.first?.lastPathComponent ?? "A file"; c.sound = .default
        UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: "clip-wait", content: c, trigger: nil))
        NotchModel.shared.pinnedUntil = Date().addingTimeInterval(8)
        NotchModel.shared.setOpen(true)
    }

    func analyze() {
        guard let url = files.first, !AssistantModel.shared.paused else { note = "The assistant is paused."; return }
        stage = .working; note = ""
        Task {
            let ex = await Task.detached(priority: .userInitiated) { FileAnalyzer.extract(url) }.value
            guard !ex.text.isEmpty || !ex.labels.isEmpty else {
                result = "I can't read this kind of file yet (\(ex.kind)). You can still copy it to the clipboard."
                stage = .result; return
            }
            var req = URLRequest(url: server.appendingPathComponent("api/analyze"))
            req.httpMethod = "POST"; req.timeoutInterval = 45
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            req.httpBody = try? JSONSerialization.data(withJSONObject: ["name": url.lastPathComponent, "kind": ex.kind, "text": ex.text, "labels": ex.labels])
            if let (d, r) = try? await URLSession.shared.data(for: req), (r as? HTTPURLResponse)?.statusCode == 200,
               let j = try? JSONSerialization.jsonObject(with: d) as? [String: Any], let s = j["summary"] as? String {
                result = s
                Audit.record(AuditEntry(tool: "analyze_file", tier: Tier.read.rawValue, source: "drop", result: "\(ex.kind), \(ex.text.count) characters sent"))
            } else {
                result = "The explanation didn't come back. Try again."
            }
            stage = .result; resultAt = Date()
        }
    }

    /// Read every dropped file URL from the providers, then act on them together.
    nonisolated static func load(_ providers: [NSItemProvider], action: Action? = nil) {
        let group = DispatchGroup(); let lock = NSLock(); var urls: [URL] = []
        for p in providers where p.canLoadObject(ofClass: URL.self) {
            group.enter()
            _ = p.loadObject(ofClass: URL.self) { url, _ in
                if let url { lock.lock(); urls.append(url); lock.unlock() }
                group.leave()
            }
        }
        group.notify(queue: .main) {
            MainActor.assumeIsolated { if let action { DropModel.shared.drop(urls.filter { $0.isFileURL }, action) } else { DropModel.shared.receive(urls) } }
        }
    }
}

/// Two big areas the size of the open notch. A file dropped on the left is explained; on the right it is copied.
struct DropZones: View {
    @State private var left = false
    @State private var right = false
    var body: some View {
        HStack(spacing: Design.Space.m) {
            zone("sparkles", "Analyze", "Drop here to understand it. Pictures, PDFs, text and folders, in any language.", highlight: left)
                .onDrop(of: [.fileURL], isTargeted: $left) { p in DropModel.load(p, action: .analyze); return true }
            zone("doc.on.doc", "Clipboard", "Drop here to copy it. Then paste it or drag it anywhere else.", highlight: right)
                .onDrop(of: [.fileURL], isTargeted: $right) { p in DropModel.load(p, action: .clipboard); return true }
        }
        .transition(.opacity)
    }
    private func zone(_ symbol: String, _ title: String, _ hint: String, highlight: Bool) -> some View {
        VStack(spacing: 10) {
            Image(systemName: symbol).font(.system(size: 44, weight: .light)).foregroundStyle(highlight ? MalayalamTheme.accent : .white.opacity(Design.Text.secondary))
                .symbolEffect(.bounce, value: highlight)
            Text(title).font(Design.Font.hero).lineLimit(1).minimumScaleFactor(0.6)
            Text(hint).font(Design.Font.body).multilineTextAlignment(.center).foregroundStyle(.white.opacity(Design.Text.secondary)).padding(.horizontal, 24)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(ZStack {
            RoundedRectangle(cornerRadius: Design.Radius.card, style: .continuous).fill(Color.black)
            RoundedRectangle(cornerRadius: Design.Radius.card, style: .continuous).fill(Color(white: 0.09))
            RoundedRectangle(cornerRadius: Design.Radius.card, style: .continuous).fill(MalayalamTheme.accent.opacity(highlight ? 0.16 : 0))
        })
        .overlay(RoundedRectangle(cornerRadius: Design.Radius.card, style: .continuous).strokeBorder(MalayalamTheme.accent.opacity(highlight ? 0.8 : 0), lineWidth: 1.4))
        .scaleEffect(highlight ? 1.01 : 1)
        .animation(.spring(response: 0.3, dampingFraction: 0.75), value: highlight)
    }
}

/// Progress and the answer after a drop.
struct DropResult: View {
    @ObservedObject private var d = DropModel.shared
    var body: some View {
        VStack(alignment: .leading, spacing: Design.Space.m) {
            HStack(spacing: 10) {
                if let f = d.files.first { Image(nsImage: NSWorkspace.shared.icon(forFile: f.path)).resizable().frame(width: 36, height: 36) }
                Text(d.files.first?.lastPathComponent ?? "File").font(Design.Font.title).lineLimit(1)
                if d.files.count > 1 { Text("and \(d.files.count - 1) more").font(Design.Font.caption).foregroundStyle(.white.opacity(Design.Text.secondary)) }
                Spacer()
                Button { d.dismiss() } label: { Image(systemName: "xmark.circle.fill").font(.system(size: 20)).foregroundStyle(.white.opacity(Design.Text.tertiary)) }.buttonStyle(.plain)
            }
            if d.stage == .working {
                HStack(spacing: 8) { ProgressView().controlSize(.small); Text("Reading it…").font(Design.Font.body).foregroundStyle(.white.opacity(Design.Text.secondary)) }
            } else if d.result.isEmpty {
                Text(d.note).font(Design.Font.title).foregroundStyle(MalayalamTheme.accent)
                if let f = d.files.first {
                    // the file glides up and to the left, into the Shelf tab
                    Image(nsImage: NSWorkspace.shared.icon(forFile: f.path)).resizable().frame(width: 96, height: 96)
                        .frame(maxWidth: .infinity)
                        .offset(x: d.flying ? -200 : 0, y: d.flying ? -150 : 0)
                        .scaleEffect(d.flying ? 0.18 : 1)
                        .opacity(d.flying ? 0 : 1)
                }
            } else {
                ScrollView {
                    Text(d.result).font(.system(size: 15)).lineSpacing(5).frame(maxWidth: .infinity, alignment: .leading).textSelection(.enabled)
                }
                HStack(spacing: 8) {
                    Chip(symbol: "doc.on.doc", text: "Copy text") { d.copyResult() }
                    Chip(symbol: "tray.and.arrow.down", text: "Keep file on shelf") { d.keepOnShelf() }
                    if !d.note.isEmpty { Text(d.note).font(Design.Font.caption).foregroundStyle(MalayalamTheme.accent) }
                }
            }
            Spacer(minLength: 0)
        }
        .padding(Design.Space.l)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background(ZStack { RoundedRectangle(cornerRadius: Design.Radius.card, style: .continuous).fill(Color.black); RoundedRectangle(cornerRadius: Design.Radius.card, style: .continuous).fill(Color(white: 0.09)) })
    }
}

/// What sits over the island's tab content while dropping.
struct DropLayer: View {
    @ObservedObject private var d = DropModel.shared
    var body: some View {
        Group {
            if d.stage != .idle { DropResult() }
            else if d.armed { DropZones() }
        }
        .animation(.easeOut(duration: 0.18), value: d.armed)
        .animation(.easeOut(duration: 0.18), value: d.stage)
    }
}

/// A small chip in the tab bar while something we copied is still waiting on the clipboard.
struct WaitingChip: View {
    @ObservedObject private var d = DropModel.shared
    var body: some View {
        if let f = d.waiting.first {
            HStack(spacing: 5) {
                Image(systemName: "doc.on.clipboard").font(.system(size: 11))
                Text("\(f.lastPathComponent) waiting").font(Design.Font.caption).lineLimit(1)
                Button { d.clearWaiting() } label: { Image(systemName: "xmark").font(.system(size: 9, weight: .bold)) }.buttonStyle(.plain)
            }
            .foregroundStyle(MalayalamTheme.accent).padding(.horizontal, 9).frame(height: 24)
            .background(Capsule().fill(MalayalamTheme.accent.opacity(0.15)))
            .frame(maxWidth: 220)
        }
    }
}
