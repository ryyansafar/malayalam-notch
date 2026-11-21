//
//  ScreenLook.swift — Malayalam Notch
//  "What's on my screen?" The Mac captures the screen and reads the text on it with Apple's on-device text
//  recognition. Only that text (never the picture) goes to the assistant, which can answer and propose actions
//  from the same fixed, confirmed tool list as everything else. Needs Screen Recording permission.
//

import AppKit
import SwiftUI

@MainActor
final class ScreenLook: ObservableObject {
    static let shared = ScreenLook()
    private let server = URL(string: "http://localhost:\(ProcessInfo.processInfo.environment["MALAYALAM_PORT"] ?? "3000")")!

    func run(question: String) {
        let a = AssistantModel.shared
        guard !a.paused else { a.feedback = "The assistant is paused."; return }
        NotchModel.shared.tab = .assistant
        NotchModel.shared.pinnedUntil = Date().addingTimeInterval(40)
        a.feedback = "Looking at your screen…"
        Task {
            let shot = FileManager.default.temporaryDirectory.appendingPathComponent("screen-\(UUID().uuidString.prefix(6)).png")
            // The notch is closed first so it is not part of what is read; the capture is the screen only.
            let ok = await Task.detached(priority: .userInitiated) { () -> Bool in
                let p = Process(); p.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture")
                p.arguments = ["-x", "-t", "png", shot.path]
                try? p.run(); p.waitUntilExit()
                return p.terminationStatus == 0 && FileManager.default.fileExists(atPath: shot.path)
            }.value
            guard ok else { a.feedback = "I couldn't capture the screen. Allow Screen Recording for Malayalam Notch in System Settings."; return }
            let ex = await Task.detached(priority: .userInitiated) { FileAnalyzer.extract(shot) }.value
            try? FileManager.default.removeItem(at: shot)
            guard !ex.text.isEmpty else { a.feedback = "I couldn't find any readable text on the screen. If this is the first time, allow Screen Recording in System Settings."; return }
            await a.askAgent(question, screen: ex.text)
            Audit.record(AuditEntry(tool: "look_at_screen", tier: Tier.read.rawValue, source: "rule", result: "\(ex.text.count) characters of screen text sent"))
        }
    }
}
