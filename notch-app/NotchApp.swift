// Malayalam in the notch — native shell for the island page.
//
// A borderless, non-activating NSPanel parked over the MacBook notch, hosting
// a transparent WKWebView that loads the island page from the server. The
// page drives the window size through a "notch" script-message channel
// ({type:"size",w,h} / {type:"hover",on} / {type:"quit"} / {type:"drag",on}).
//
// Drag-to-notch works natively too: an always-on transparent DropZone view
// sits over the notch inside the panel, accepts audio file drags, expands the
// island via the page channel, and posts the file bytes to /api/shout with
// URLSession — the result card then arrives over the page's own SSE stream.
// A global .leftMouseDragged monitor + drag-pasteboard check opens the island
// as a file drag approaches the screen top, before it reaches the zone.
//
// Build (see package.json "notch" script):
//   swiftc -O -framework AppKit -framework WebKit \
//     -Xlinker -sectcreate -Xlinker __TEXT -Xlinker __info_plist -Xlinker notch-app/Info.plist \
//     notch-app/NotchApp.swift -o notch-app/build/notch

import AppKit
import WebKit
import UniformTypeIdentifiers

private let audioExts: Set<String> = ["opus", "ogg", "m4a", "mp3", "wav", "aac", "amr", "webm", "mp4", "flac"]
private let mimeForExt: [String: String] = [
    "opus": "audio/ogg;codecs=opus", "ogg": "audio/ogg", "m4a": "audio/mp4",
    "mp3": "audio/mpeg", "wav": "audio/wav", "aac": "audio/aac", "amr": "audio/amr",
    "webm": "audio/webm", "mp4": "audio/mp4", "flac": "audio/flac",
]

// Always-on, nearly invisible drag target parked over the notch. It expands
// the island on enter, collapses on exit, and on drop posts the bytes natively.
final class DropZone: NSView {
    var onExpand: (() -> Void)?
    var onCollapse: (() -> Void)?
    var onDropFile: ((URL) -> Void)?
    private var collapseWork: DispatchWorkItem?

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        registerForDraggedTypes([.fileURL])
        wantsLayer = true
        layer?.backgroundColor = NSColor.clear.cgColor
    }
    required init?(coder: NSCoder) { fatalError() }

    override func hitTest(_ point: NSPoint) -> NSView? {
        // Only hit-test inside our own bounds; alpha is ~0 so we must opt in.
        bounds.contains(convert(point, from: superview)) ? self : nil
    }

    private func urls(_ info: NSDraggingInfo) -> [URL] {
        info.draggingPasteboard.readObjects(forClasses: [NSURL.self]) as? [URL] ?? []
    }
    private func accepts(_ info: NSDraggingInfo) -> Bool {
        urls(info).contains { url in
            let ext = url.pathExtension.lowercased()
            if audioExts.contains(ext) { return true }
            if let t = UTType(filenameExtension: ext) { return t.conforms(to: .audio) }
            return false
        }
    }

    override func draggingEntered(_ sender: NSDraggingInfo) -> NSDragOperation {
        guard accepts(sender) else { return [] }
        collapseWork?.cancel()
        onExpand?()
        return .copy
    }
    override func draggingUpdated(_ sender: NSDraggingInfo) -> NSDragOperation {
        accepts(sender) ? .copy : []
    }
    override func draggingExited(_ sender: NSDraggingInfo?) {
        let work = DispatchWorkItem { [weak self] in self?.onCollapse?() }
        collapseWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.4, execute: work)
    }
    override func prepareForDragOperation(_ sender: NSDraggingInfo) -> Bool { accepts(sender) }
    override func performDragOperation(_ sender: NSDraggingInfo) -> Bool {
        collapseWork?.cancel()
        guard let url = urls(sender).first(where: { audioExts.contains($0.pathExtension.lowercased()) }) else { return false }
        onDropFile?(url)
        return true
    }
}

final class IslandController: NSObject, WKScriptMessageHandler, WKUIDelegate, WKNavigationDelegate {

    private(set) var window: NSPanel!
    private var webView: WKWebView!
    private var dropZone: DropZone!
    private var retryTimer: Timer?
    private var targetScreen: NSScreen?
    private var notchW: CGFloat = 0
    private var notchH: CGFloat = 32
    private var lastSize = NSSize.zero
    private var dragMonitor: Any?
    private var mouseMonitor: Any?
    private var zoneExpanded = false

    private var port: String {
        let p = ProcessInfo.processInfo.environment["PORT"] ?? "3000"
        return p.isEmpty ? "3000" : p
    }

    private var pageURL: URL {
        var c = URLComponents(string: "http://localhost:\(port)/notch.html")!
        c.queryItems = [
            URLQueryItem(name: "nw", value: String(Int(notchW.rounded()))),
            URLQueryItem(name: "nh", value: String(Int(notchH.rounded()))),
        ]
        return c.url!
    }

    // The screen that has a real notch; nil-safe fallback to the main screen.
    private func pickScreen() {
        targetScreen = NSScreen.screens.first(where: { $0.safeAreaInsets.top > 0 }) ?? NSScreen.main
        guard let s = targetScreen else { notchW = 0; notchH = 32; return }
        notchH = max(24, s.safeAreaInsets.top)
        if s.safeAreaInsets.top > 0,
           let left = s.auxiliaryTopLeftArea, let right = s.auxiliaryTopRightArea {
            notchW = s.frame.width - left.width - right.width
        } else {
            notchW = 0 // floating pill: no camera gap to leave room for
        }
    }

    func start() {
        pickScreen()

        let config = WKWebViewConfiguration()
        config.mediaTypesRequiringUserActionForPlayback = [] // spoken translation plays without a click
        config.userContentController.add(self, name: "notch")

        webView = WKWebView(frame: .zero, configuration: config)
        webView.setValue(false, forKey: "drawsBackground") // transparent: clicks pass through outside the pill
        webView.uiDelegate = self
        webView.navigationDelegate = self

        let panel = NSPanel(
            contentRect: NSRect(x: 0, y: 0, width: 260, height: 40),
            styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered, defer: false)
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = false
        panel.level = NSWindow.Level(rawValue: NSWindow.Level.statusBar.rawValue + 1)
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary]
        panel.isMovable = false
        panel.ignoresMouseEvents = false

        // Layer order inside the panel: webView fills it, the drop zone floats
        // over the notch region on top so a drag can hit it even when the page
        // is only a collapsed pill.
        let container = NSView(frame: .zero)
        container.wantsLayer = true
        container.addSubview(webView)
        dropZone = DropZone(frame: .zero)
        container.addSubview(dropZone)
        panel.contentView = container
        window = panel

        dropZone.onExpand = { [weak self] in self?.setDragTarget(on: true) }
        dropZone.onCollapse = { [weak self] in self?.setDragTarget(on: false) }
        dropZone.onDropFile = { [weak self] url in self?.postAudio(url) }

        // Collapsed pill until the page reports its real size.
        resize(to: NSSize(width: max(260, notchW + 112), height: notchH + 6), animated: false)
        window.orderFrontRegardless()
        load()

        NotificationCenter.default.addObserver(
            self, selector: #selector(screensChanged),
            name: NSApplication.didChangeScreenParametersNotification, object: nil)

        // Cmd-Q while the island is hovered: the panel is made key on hover,
        // so this app does receive the key event.
        NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] event in
            guard let self, self.window.isKeyWindow else { return event }
            if event.modifierFlags.intersection(.deviceIndependentFlagsMask) == .command,
               event.charactersIgnoringModifiers?.lowercased() == "q" {
                NSApp.terminate(nil)
                return nil
            }
            return event
        }

        // While any file is being dragged anywhere, watch the cursor: the
        // island starts opening while the drag is still approaching — within
        // ~120 pt of the notch horizontally and ~160 pt of the top. The very
        // top edge is never required: it triggers Mission Control.
        dragMonitor = NSEvent.addGlobalMonitorForEvents(matching: .leftMouseDragged) { [weak self] _ in
            guard let self else { return }
            let pb = NSPasteboard(name: .drag)
            guard pb.types?.contains(.fileURL) == true else { return }
            let loc = NSEvent.mouseLocation
            guard let s = self.targetScreen, s.frame.contains(loc) else { return }
            let near = loc.y > s.frame.maxY - 160 && abs(loc.x - s.frame.midX) < self.notchW / 2 + 120
            self.setDragTarget(on: near)
        }

        // Hover expand: cursor resting near the notch opens the island.
        mouseMonitor = NSEvent.addGlobalMonitorForEvents(matching: .mouseMoved) { [weak self] _ in
            guard let self else { return }
            let loc = NSEvent.mouseLocation
            guard let s = self.targetScreen, s.frame.contains(loc) else { return }
            let near = loc.y > s.frame.maxY - 60 && abs(loc.x - s.frame.midX) < 400
            self.tellPage(type: "hoverNear", ["on": near])
        }
    }

    private func load() {
        webView.load(URLRequest(url: pageURL))
    }

    private func scheduleRetry() {
        retryTimer?.invalidate()
        retryTimer = Timer.scheduledTimer(withTimeInterval: 2, repeats: false) { [weak self] _ in
            self?.load()
        }
    }

    // Top edge pinned to the top of the notched screen, centred on the notch.
    private func frame(for size: NSSize) -> NSRect {
        guard let s = targetScreen else {
            return NSRect(origin: .zero, size: size)
        }
        let x = s.frame.midX - size.width / 2
        let y = s.frame.maxY - size.height - (notchW > 0 ? 0 : 8) // pill floats 8pt down on notch-less Macs
        return NSRect(x: x, y: y, width: size.width, height: size.height)
    }

    // The window is never animated (docs/NOTCH-REFERENCE.md): it jumps to the
    // needed size instantly while the island morphs inside it in CSS. Growing:
    // the page sends the size first, then expands; shrinking: the island
    // settles small first, then the window follows — no clipped frame.
    private func resize(to size: NSSize, animated: Bool) {
        var s = size
        s.width = min(max(s.width, 60), 900)
        s.height = min(max(s.height, 24), 640)
        guard s != lastSize else { return }
        lastSize = s
        window.setFrame(frame(for: s), display: true)
        layoutSubviews()
    }

    private func layoutSubviews() {
        guard let container = window?.contentView else { return }
        webView.frame = container.bounds
        if zoneExpanded {
            // Drag in flight: the drop target must sit well below the edge —
            // the dashed target in the page spans y 50…170 from the top, so
            // cover that region natively (a drop at y 90 lands here, not on
            // the web view, which is the most reliable path).
            let top: CGFloat = 46, bottom: CGFloat = min(176, container.bounds.height - 14)
            dropZone.frame = NSRect(x: 16, y: container.bounds.height - bottom,
                                    width: container.bounds.width - 32, height: bottom - top)
        } else {
            // Always-on small zone over the notch: the second path from
            // docs/DRAG-FINDINGS.md. 240 x 44 pt, centred, nearly invisible.
            let zoneW: CGFloat = 240, zoneH: CGFloat = 44
            let zx = (container.bounds.width - zoneW) / 2
            dropZone.frame = NSRect(x: zx, y: container.bounds.height - zoneH, width: zoneW, height: zoneH)
        }
    }

    // A file drag entered the approach region (or the small zone): open the
    // island into its drag-target size and grow the native drop zone to cover
    // the dashed area. Off restores the small zone.
    private func setDragTarget(on: Bool) {
        if on != zoneExpanded {
            zoneExpanded = on
            layoutSubviews()
        }
        tellPage(type: "drag", ["on": on])
    }

    @objc private func screensChanged() {
        pickScreen()
        lastSize = .zero
        load()
    }

    private func tellPage(type: String, _ extra: [String: Any] = [:]) {
        var dict: [String: Any] = ["type": type]
        dict.merge(extra) { _, new in new }
        if let data = try? JSONSerialization.data(withJSONObject: dict),
           let json = String(data: data, encoding: .utf8) {
            webView.evaluateJavaScript("window.dispatchEvent(new CustomEvent('notch-native',{detail:\(json)}))")
        }
    }

    // Post the dropped file natively: bytes -> base64 -> /api/shout.
    private func postAudio(_ url: URL) {
        setDragTarget(on: false)
        tellPage(type: "nativeDrop", ["filename": url.lastPathComponent])
        guard let data = try? Data(contentsOf: url, options: .mappedIfSafe) else {
            tellPage(type: "nativeError", ["message": "Could not read \(url.lastPathComponent)"])
            return
        }
        let ext = url.pathExtension.lowercased()
        let body: [String: Any] = [
            "audioBase64": data.base64EncodedString(),
            "mime": mimeForExt[ext] ?? "audio/ogg",
            "filename": url.lastPathComponent,
            "source": "notch_drop",
            "targetLang": "en-IN",
        ]
        var req = URLRequest(url: URL(string: "http://localhost:\(port)/api/shout")!)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try? JSONSerialization.data(withJSONObject: body)
        URLSession.shared.dataTask(with: req) { [weak self] _, resp, err in
            DispatchQueue.main.async {
                if err != nil || (resp as? HTTPURLResponse)?.statusCode != 200 {
                    self?.tellPage(type: "nativeError", ["message": "Translation failed — is the server running?"])
                }
                // On success the note arrives over the page's SSE stream.
            }
        }.resume()
    }

    // MARK: WKScriptMessageHandler — the page's expand/collapse/quit channel
    func userContentController(_ userContentController: WKUserContentController,
                               didReceive message: WKScriptMessage) {
        guard let body = message.body as? [String: Any], let type = body["type"] as? String else { return }
        switch type {
        case "size":
            if let w = body["w"] as? Double, let h = body["h"] as? Double {
                // The page animates the island; the window only jumps to size (no frame animation).
                resize(to: NSSize(width: w + 48, height: h + 28), animated: false)
            }
        case "hover":
            if (body["on"] as? Bool) == true {
                window.makeKey() // key without activating: lets the text field and Cmd-Q work
            } else if window.isKeyWindow {
                window.resignKey()
            }
        case "quit":
            NSApp.terminate(nil)
        default:
            break
        }
    }

    // MARK: WKUIDelegate — let the page open the Mac microphone
    func webView(_ webView: WKWebView,
                 requestMediaCapturePermissionFor origin: WKSecurityOrigin,
                 initiatedByFrame frame: WKFrameInfo,
                 type: WKMediaCaptureType,
                 decisionHandler: @escaping (WKPermissionDecision) -> Void) {
        // macOS may still show a one-time TCC prompt; after that this just grants.
        decisionHandler(.grant)
    }

    // MARK: WKNavigationDelegate — waiting-for-server retry
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        scheduleRetry()
    }
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        scheduleRetry()
    }
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory) // no Dock icon, no Cmd-Tab entry
let controller = IslandController()

final class Delegate: NSObject, NSApplicationDelegate {
    func applicationDidFinishLaunching(_ notification: Notification) {
        controller.start()
    }
}

let delegate = Delegate()
app.delegate = delegate
app.run()
