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
    private var clickMonitor: Any?
    private var dragBaseline = NSPasteboard(name: .drag).changeCount
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
        ToolsModel.shared.start()
        buildStatusItem()
        // Clicks pass straight through everywhere except over the visible island (updated every tick below).
        model.onOpenChanged = { [weak self] open in self?.panel.ignoresMouseEvents = !open }
        // A click anywhere outside the island (the menu bar, the area behind the notch, any other app)
        // belongs to whatever is there; it also folds the island away. Clicks inside never reach this monitor.
        clickMonitor = NSEvent.addGlobalMonitorForEvents(matching: [.leftMouseDown, .rightMouseDown, .otherMouseDown]) { [weak self] _ in
            MainActor.assumeIsolated {
                guard let self, self.model.isOpen, AssistantModel.shared.pending == nil, MalayalamViewModel.shared.phase == .idle else { return }
                self.model.pinnedUntil = .distantPast
                self.model.setOpen(false)
            }
        }
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
        menu.addItem(withTitle: "Pause / resume the assistant", action: #selector(togglePause), keyEquivalent: "").target = self
        menu.addItem(withTitle: "Mute / unmute", action: #selector(toggleMute), keyEquivalent: "").target = self
        menu.addItem(withTitle: "Open the desk in the browser", action: #selector(openDesk), keyEquivalent: "").target = self
        menu.addItem(.separator())
        menu.addItem(withTitle: "Quit Malayalam Notch", action: #selector(quit), keyEquivalent: "q").target = self
        view.menu = menu
    }
    @objc private func togglePause() { AssistantModel.shared.paused.toggle() }
    @objc private func toggleMute() { MalayalamViewModel.shared.muted.toggle() }
    @objc private func openDesk() { NSWorkspace.shared.open(URL(string: "http://localhost:3000/dashboard.html")!) }
    @objc private func quit() { NSApp.terminate(nil) }

    // MARK: Menu bar icon: a second, obvious way in
    private var statusItem: NSStatusItem?
    private func buildStatusItem() {
        let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        item.button?.image = NSImage(systemSymbolName: "waveform", accessibilityDescription: "Malayalam Notch")
        let menu = NSMenu()
        menu.addItem(withTitle: "Open the notch", action: #selector(openFromMenu), keyEquivalent: "").target = self
        menu.addItem(.separator())
        menu.addItem(withTitle: "Pause or resume the assistant", action: #selector(togglePause), keyEquivalent: "").target = self
        menu.addItem(withTitle: "Quit Malayalam Notch", action: #selector(quit), keyEquivalent: "q").target = self
        item.menu = menu
        statusItem = item
    }
    @objc private func openFromMenu() {
        model.pinnedUntil = Date().addingTimeInterval(8)
        model.setOpen(true)
    }

    // MARK: Cursor poll
    private var hoverSince: Date?

    private func tick() {
        guard let s = screen else { return }
        let loc = NSEvent.mouseLocation
        let topY = s.frame.maxY
        let midX = s.frame.midX

        let live = NowPlayingModel.shared.isPlaying || MalayalamViewModel.shared.phase != .idle || AssistantModel.shared.soon != nil
        if live != model.extended { withAnimation(.spring(response: 0.42, dampingFraction: 0.8)) { model.extended = live } }

        let mouseDown = NSEvent.pressedMouseButtons & 1 == 1
        // A drag only counts when the drag pasteboard changed since the button went down; a plain click
        // (menu bar, desktop) must never look like a drag, even if an old audio drag is still on the pasteboard.
        if !mouseDown { dragBaseline = NSPasteboard(name: .drag).changeCount }
        model.isDragging = mouseDown && NSPasteboard(name: .drag).changeCount != dragBaseline && dragCarriesAudio()

        // The action area is the notch pill itself (a few points of slack, nothing beside it).
        // Closer than that (a short way around the pill) the notch only "peeks".
        let pillW = model.closedWidth + (model.extended ? model.wingExtra : 0)
        let dx = abs(loc.x - midX)
        let onScreen = s.frame.contains(loc)                    // another display (e.g. one above) never counts
        let dy = onScreen ? topY - loc.y : .greatestFiniteMagnitude   // distance below the top edge
        let onPill = dx < 92.5 && dy < 37                        // the traced physical notch box (185 x 37), whatever the pill is showing
        let nearPill = dx < pillW / 2 + 14 && dy < model.closedHeight + 12
        let nearForDrag = dx < model.openSize.width / 2 && dy < 170
        let openRect = dx < model.openSize.width / 2 + model.topRadius && dy < model.openSize.height

        // Only the island itself takes mouse events: not its transparent corners, the shadow strip under it,
        // or anything beside it. Closed, the window ignores the mouse completely.
        let insideIsland = model.isOpen && dx < model.openSize.width / 2 + model.topRadius && dy < model.openSize.height
        if panel.ignoresMouseEvents == insideIsland { panel.ignoresMouseEvents = !insideIsland }

        if !model.isOpen {
            let wantPeek = nearPill && !onPill && !mouseDown
            if wantPeek != model.peek { withAnimation(.spring(response: 0.35, dampingFraction: 0.75)) { model.peek = wantPeek } }
            if onPill && !mouseDown {
                if hoverSince == nil { hoverSince = Date() }
                if let t = hoverSince, Date().timeIntervalSince(t) > 0.12 { hoverSince = nil; model.peek = false; model.setOpen(true) }
            } else {
                hoverSince = nil
                if model.isDragging && nearForDrag { model.peek = false; model.setOpen(true) }
            }
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
