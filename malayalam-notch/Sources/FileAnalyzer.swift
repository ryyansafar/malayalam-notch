//
//  FileAnalyzer.swift — Malayalam Notch
//  Reads any file on this Mac (pictures, PDFs, Office documents, text, audio, video, archives, folders, or just
//  its details) into plain text for the explanation. Nothing leaves the Mac here.
//

import AppKit
import AVFoundation
import PDFKit
import UniformTypeIdentifiers
import Vision

struct Extracted { let kind: String; let text: String; let labels: [String]; var audio: Data? = nil; var audioMime = "audio/mp4" }

enum FileAnalyzer {
    static let textExts: Set<String> = ["txt", "md", "csv", "tsv", "json", "html", "htm", "xml", "swift", "js", "ts", "tsx", "jsx", "py", "rb", "go", "rs", "java", "c", "h", "cpp", "cs", "php", "sh", "log", "yaml", "yml", "toml", "ini", "srt", "vtt", "css", "sql", "plist", "tex", "rtf"]
    static let audioExts: Set<String> = ["opus", "ogg", "m4a", "mp3", "wav", "aac", "amr", "webm", "flac", "aiff", "caf"]
    static let videoExts: Set<String> = ["mp4", "mov", "m4v", "avi", "mkv", "webm"]

    static func isAudio(_ url: URL) -> Bool { audioExts.contains(url.pathExtension.lowercased()) }
    static func isFolder(_ url: URL) -> Bool { (try? url.resourceValues(forKeys: [.isDirectoryKey]).isDirectory) == true }

    /// Read any file on this Mac. Nothing leaves the Mac here. Every file gets an answer: its contents when they can
    /// be read, otherwise a description built from its details (kind, size, dates, tags), and the file itself is never sent.
    static func extract(_ url: URL) -> Extracted {
        if isFolder(url) { return folder(url) }
        let ext = url.pathExtension.lowercased()
        let type = UTType(filenameExtension: ext)
        if type?.conforms(to: .image) == true { return image(url) }
        if ext == "pdf", let doc = PDFDocument(url: url), let t = doc.string, !t.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            return Extracted(kind: "PDF, \(doc.pageCount) pages", text: String(t.prefix(7000)), labels: [])
        }
        if audioExts.contains(ext) || type?.conforms(to: .audio) == true { return audio(url) }
        if videoExts.contains(ext) || type?.conforms(to: .movie) == true { return video(url) }
        if ["docx", "doc", "odt", "rtf", "rtfd", "html", "htm", "webarchive"].contains(ext), let t = attributedText(url) {
            return Extracted(kind: "document (\(ext))", text: String(t.prefix(7000)), labels: [])
        }
        if ["xlsx", "pptx", "docx", "pages", "numbers", "key", "odp", "ods", "epub"].contains(ext), let t = zippedText(url) {
            return Extracted(kind: "Office-style document (\(ext))", text: String(t.prefix(7000)), labels: [])
        }
        if ["zip", "jar", "apk", "tar", "gz", "tgz", "7z", "dmg"].contains(ext) { return archive(url) }
        if let t = looseText(url) { return Extracted(kind: "text file", text: String(t.prefix(7000)), labels: []) }
        return details(url, type: type?.localizedDescription)
    }

    // MARK: kinds

    private static func attributedText(_ url: URL) -> String? {
        guard let a = try? NSAttributedString(url: url, options: [:], documentAttributes: nil) else { return nil }
        let t = a.string.trimmingCharacters(in: .whitespacesAndNewlines)
        return t.isEmpty ? nil : t
    }

    /// docx/xlsx/pptx/odt/epub/pages are zip files of XML: unzip the text parts and strip the tags.
    private static func zippedText(_ url: URL) -> String? {
        let listing = run("/usr/bin/unzip", ["-Z1", url.path]) ?? ""
        let parts = listing.split(separator: "\n").map(String.init).filter {
            $0.hasSuffix(".xml") && ($0.contains("word/document") || $0.contains("sharedStrings") || $0.contains("slides/slide") || $0.hasPrefix("content") || $0.hasSuffix(".xhtml"))
        }
        var out = ""
        for part in parts.prefix(25) {
            guard let xml = run("/usr/bin/unzip", ["-p", url.path, part]) else { continue }
            let t = xml.replacingOccurrences(of: "<[^>]+>", with: " ", options: .regularExpression)
                .replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
            out += t + "\n"
            if out.count > 7000 { break }
        }
        let trimmed = out.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }

    private static func archive(_ url: URL) -> Extracted {
        let list = run("/usr/bin/unzip", ["-Z1", url.path]) ?? run("/usr/bin/tar", ["-tf", url.path]) ?? ""
        let names = list.split(separator: "\n").prefix(120).joined(separator: "\n")
        return names.isEmpty ? details(url, type: "archive") : Extracted(kind: "archive", text: "Archive \(url.lastPathComponent) contains:\n\(names)", labels: [])
    }

    private static func looseText(_ url: URL) -> String? {
        guard let h = try? FileHandle(forReadingFrom: url) else { return nil }
        defer { try? h.close() }
        guard let head = try? h.read(upToCount: 8192), !head.contains(0) else { return nil }
        guard let all = try? Data(contentsOf: url, options: .mappedIfSafe), all.count <= 3_000_000 else { return String(data: head, encoding: .utf8) }
        return String(data: all, encoding: .utf8) ?? String(data: all, encoding: .utf16)
    }

    /// Audio: its tags and length always; speech in it is transcribed (the first clips only) when it is short enough.
    private static func audio(_ url: URL) -> Extracted {
        let asset = AVURLAsset(url: url)
        let secs = CMTimeGetSeconds(asset.duration)
        var lines = ["Audio file \(url.lastPathComponent)", String(format: "Length: %d:%02d", Int(secs) / 60, Int(secs) % 60)]
        for item in asset.commonMetadata {
            if let k = item.commonKey?.rawValue, let v = item.stringValue, ["title", "artist", "albumName", "type"].contains(k) { lines.append("\(k): \(v)") }
        }
        let size = (try? url.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0
        var ex = Extracted(kind: "audio, \(Int(secs)) s", text: lines.joined(separator: "\n"), labels: [])
        if secs > 0, secs <= 29, size <= 5_000_000, let data = try? Data(contentsOf: url) {
            ex.audio = data
            ex.audioMime = ["mp3": "audio/mpeg", "wav": "audio/wav", "m4a": "audio/mp4", "aac": "audio/aac", "ogg": "audio/ogg", "opus": "audio/ogg", "flac": "audio/flac", "amr": "audio/amr", "webm": "audio/webm"][url.pathExtension.lowercased()] ?? "audio/mp4"
        } else if secs > 29 { ex = Extracted(kind: ex.kind, text: ex.text + "\n(Longer than 30 seconds, so I can describe it but not transcribe it.)", labels: []) }
        return ex
    }

    /// Video: length, size and what a frame near the start shows (text and labels read on this Mac).
    private static func video(_ url: URL) -> Extracted {
        let asset = AVURLAsset(url: url)
        let secs = CMTimeGetSeconds(asset.duration)
        var text = "Video \(url.lastPathComponent), \(Int(secs) / 60):\(String(format: "%02d", Int(secs) % 60)) long."
        var labels: [String] = []
        let gen = AVAssetImageGenerator(asset: asset); gen.appliesPreferredTrackTransform = true; gen.maximumSize = CGSize(width: 1600, height: 1600)
        if let cg = try? gen.copyCGImage(at: CMTime(seconds: min(1, max(0, secs / 2)), preferredTimescale: 600), actualTime: nil) {
            let r = vision(cg); text += "\nText seen in a frame:\n\(r.text)"; labels = r.labels
        }
        return Extracted(kind: "video, \(Int(secs)) s", text: text, labels: labels)
    }

    /// Anything else: what macOS itself knows about it. Honest and always available.
    private static func details(_ url: URL, type: String?) -> Extracted {
        let kind = run("/usr/bin/mdls", ["-name", "kMDItemKind", "-raw", url.path]) ?? type ?? "file"
        let fileKind = run("/usr/bin/file", ["-b", url.path])?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let v = try? url.resourceValues(forKeys: [.fileSizeKey, .contentModificationDateKey, .creationDateKey])
        let df = DateFormatter(); df.dateStyle = .medium; df.timeStyle = .short
        var lines = ["File \(url.lastPathComponent)", "Kind: \(kind)", "Format: \(fileKind)", "Size: \((v?.fileSize ?? 0) / 1024) KB"]
        if let d = v?.creationDate { lines.append("Created: \(df.string(from: d))") }
        if let d = v?.contentModificationDate { lines.append("Modified: \(df.string(from: d))") }
        lines.append("(Its contents cannot be read as text, so this is described from its details.)")
        return Extracted(kind: kind, text: lines.joined(separator: "\n"), labels: [])
    }

    private static func run(_ tool: String, _ args: [String]) -> String? {
        let p = Process(); p.executableURL = URL(fileURLWithPath: tool); p.arguments = args
        let out = Pipe(); p.standardOutput = out; p.standardError = Pipe()
        do { try p.run() } catch { return nil }
        let data = out.fileHandleForReading.readDataToEndOfFile()
        p.waitUntilExit()
        return p.terminationStatus == 0 ? String(data: data, encoding: .utf8) : nil
    }

    /// Text recognition and labels for a picture, on this Mac.
    private static func vision(_ cg: CGImage) -> (text: String, labels: [String]) {
        let ocr = VNRecognizeTextRequest()
        ocr.recognitionLevel = .accurate; ocr.usesLanguageCorrection = true; ocr.automaticallyDetectsLanguage = false
        if let supported = try? ocr.supportedRecognitionLanguages() {
            let wanted = supported.filter { ["en", "ml", "hi", "ta", "te", "kn", "bn"].contains(String($0.prefix(2))) }
            if !wanted.isEmpty { ocr.recognitionLanguages = wanted }
        }
        let classify = VNClassifyImageRequest()
        try? VNImageRequestHandler(cgImage: cg, options: [:]).perform([ocr, classify])
        let text = (ocr.results ?? []).compactMap { $0.topCandidates(1).first?.string }.joined(separator: "\n")
        let labels = (classify.results ?? []).filter { $0.confidence > 0.3 }.prefix(6).map(\.identifier)
        return (String(text.prefix(7000)), Array(labels))
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
        guard let src = CGImageSourceCreateWithURL(url as CFURL, nil) else { return details(url, type: "image") }
        // A smaller copy reads much faster and loses nothing a person could read.
        let opts: [CFString: Any] = [kCGImageSourceCreateThumbnailFromImageAlways: true, kCGImageSourceCreateThumbnailWithTransform: true, kCGImageSourceThumbnailMaxPixelSize: 2400]
        guard let cg = CGImageSourceCreateThumbnailAtIndex(src, 0, opts as CFDictionary) ?? CGImageSourceCreateImageAtIndex(src, 0, nil) else { return details(url, type: "image") }
        let r = vision(cg)
        return Extracted(kind: "image", text: r.text, labels: r.labels)
    }
}

