//
//  App.swift — Malayalam Notch
//  A borderless, non-activating panel pinned to the top centre of the notched screen.
//  Created once at full size; ignores the mouse while closed so clicks reach other apps.
//  One 30 Hz poll of the cursor drives hover-open, drag-open and close (no event taps needed).
//

import AppKit
import SwiftUI
import UniformTypeIdentifiers

private let audioExtensions: Set<String> = ["opus", "ogg", "m4a", "mp3", "wav", "aac", "amr", "webm", "mp4", "flac"]

final class NotchPanel: NSPanel {
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { false }
}

@MainActor
final class AppController: NSObject, NSApplicationDelegate {
    private var panel: NotchPanel!
    private var screen: NSScreen?
    private var timer: Timer?
    private var leaveSince: Date?
    private let model = NotchModel.shared
    private var dragPasteboardCount = -1
    private var dragIsAudioCache = false

    func applicationDidFinishLaunching(_ notification: Notification) {
        measureScreen()
        buildPanel()
        refreshCount()
        NowPlayingModel.shared.start()
        AssistantModel.shared.start()
        model.onOpenChanged = { [weak self] open in self?.panel.ignoresMouseEvents = !open }
        timer = Timer.scheduledTimer(withTimeInterval: 1.0 / 30.0, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.tick() }
        }
        NotificationCenter.default.addObserver(forName: NSApplication.didChangeScreenParametersNotification,
                                               object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.measureScreen(); self?.placePanel() }
        }
        Timer.scheduledTimer(withTimeInterval: 30, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.refreshCount() }
        }
    }

    // MARK: Screen / panel
    private func measureScreen() {
        screen = NSScreen.screens.first(where: { $0.safeAreaInsets.top > 0 }) ?? NSScreen.main
        guard let s = screen else { return }
        if s.safeAreaInsets.top > 0, let l = s.auxiliaryTopLeftArea, let r = s.auxiliaryTopRightArea {
            model.notchWidth = s.frame.width - l.width - r.width + 4   // +4 hides the seam against the real notch
            model.closedHeight = s.safeAreaInsets.top
        } else {
            model.notchWidth = 0
            model.closedHeight = 30
        }
        model.closedWidth = model.notchWidth > 0 ? model.notchWidth : 185   // idle: exactly the notch, no wings
    }

    private func buildPanel() {
        panel = NotchPanel(contentRect: .zero, styleMask: [.borderless, .nonactivatingPanel],
                           backing: .buffered, defer: false)
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = false
        panel.level = NSWindow.Level(rawValue: NSWindow.Level.statusBar.rawValue + 1)
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary, .ignoresCycle]
        panel.isMovable = false
        panel.ignoresMouseEvents = true
        let host = NSHostingView(rootView: NotchRootView())
        host.autoresizingMask = [.width, .height]
        panel.contentView = host
        placePanel()
        panel.orderFrontRegardless()
        addContextMenu(to: host)
    }

    private func placePanel() {
        guard let s = screen else { return }
        let size = model.windowSize
        let frame = NSRect(x: s.frame.midX - size.width / 2, y: s.frame.maxY - size.height,
                           width: size.width, height: size.height)
        panel.setFrame(frame, display: true)
    }

    private func addContextMenu(to view: NSView) {
        let menu = NSMenu()
        menu.addItem(withTitle: "Mute / unmute", action: #selector(toggleMute), keyEquivalent: "").target = self
        menu.addItem(withTitle: "Open the desk in the browser", action: #selector(openDesk), keyEquivalent: "").target = self
        menu.addItem(.separator())
        menu.addItem(withTitle: "Quit Malayalam Notch", action: #selector(quit), keyEquivalent: "q").target = self
        view.menu = menu
    }
    @objc private func toggleMute() { MalayalamViewModel.shared.muted.toggle() }
    @objc private func openDesk() { NSWorkspace.shared.open(URL(string: "http://localhost:3000/dashboard.html")!) }
    @objc private func quit() { NSApp.terminate(nil) }

    // MARK: Cursor poll
    private func tick() {
        guard let s = screen else { return }
        let loc = NSEvent.mouseLocation
        let topY = s.frame.maxY
        let midX = s.frame.midX

        let live = NowPlayingModel.shared.isPlaying || MalayalamViewModel.shared.phase != .idle
        if live != model.extended { withAnimation(.spring(response: 0.42, dampingFraction: 0.8)) { model.extended = live } }

        let mouseDown = NSEvent.pressedMouseButtons & 1 == 1
        model.isDragging = mouseDown && dragCarriesAudio()

        // Hover target: the closed pill; drag target: a wider, taller approach zone (never needs the edge).
        let pillHalf = (model.closedWidth + (model.extended ? model.wingExtra : 0)) / 2 + 6
        let overPill = abs(loc.x - midX) < pillHalf && loc.y > topY - (model.closedHeight + 4)
        let nearForDrag = abs(loc.x - midX) < model.openSize.width / 2 && loc.y > topY - 170
        let openRect = abs(loc.x - midX) < model.openSize.width / 2 + 24 && loc.y > topY - (model.openSize.height + 28)

        if !model.isOpen {
            if overPill && !mouseDown { model.setOpen(true) }
            else if model.isDragging && nearForDrag { model.setOpen(true) }
        } else if openRect || model.shouldStayOpen {
            leaveSince = nil
        } else {
            if leaveSince == nil { leaveSince = Date() }
            if let t = leaveSince, Date().timeIntervalSince(t) > 0.35 { model.setOpen(false); leaveSince = nil }
        }
    }

    /// Does the drag pasteboard carry an audio file? Cached per pasteboard change.
    private func dragCarriesAudio() -> Bool {
        let pb = NSPasteboard(name: .drag)
        if pb.changeCount != dragPasteboardCount {
            dragPasteboardCount = pb.changeCount
            let urls = pb.readObjects(forClasses: [NSURL.self], options: [.urlReadingFileURLsOnly: true]) as? [URL] ?? []
            dragIsAudioCache = urls.contains { audioExtensions.contains($0.pathExtension.lowercased()) }
        }
        return dragIsAudioCache
    }

    private func refreshCount() {
        guard let url = URL(string: "http://localhost:3000/api/archive.json") else { return }
        URLSession.shared.dataTask(with: url) { data, _, _ in
            guard let data, let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let entries = json["entries"] as? [[String: Any]] else { return }
            let midnight = Calendar.current.startOfDay(for: Date())
            let iso = ISO8601DateFormatter()
            let n = entries.filter { e in
                guard let t = e["time"] as? String, let d = iso.date(from: t) ?? ISO8601DateFormatter().date(from: t) else { return false }
                return d >= midnight
            }.count
            DispatchQueue.main.async { NotchModel.shared.notesToday = n }
        }.resume()
    }
}

@main
struct MalayalamNotchApp {
    static func main() {
        let app = NSApplication.shared
        app.setActivationPolicy(.accessory)   // no Dock icon, no Cmd-Tab entry
        let controller = MainActor.assumeIsolated { AppController() }
        app.delegate = controller
        withExtendedLifetime(controller) { app.run() }
    }
}
