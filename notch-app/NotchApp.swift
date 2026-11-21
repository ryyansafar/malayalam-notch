// rowing-call notch — native shell for the island page.
//
// A borderless, non-activating NSPanel parked over the MacBook notch, hosting
// a transparent WKWebView that loads the island page from the rowing-call
// server. The page drives the window size through a "notch" script-message
// channel ({type:"size",w,h} / {type:"hover",on} / {type:"quit"}).
//
// Build (see package.json "notch" script):
//   swiftc -O -framework AppKit -framework WebKit \
//     -Xlinker -sectcreate -Xlinker __TEXT -Xlinker __info_plist -Xlinker notch-app/Info.plist \
//     notch-app/NotchApp.swift -o notch-app/build/notch

import AppKit
import WebKit

final class IslandController: NSObject, WKScriptMessageHandler, WKUIDelegate, WKNavigationDelegate {

    private(set) var window: NSPanel!
    private var webView: WKWebView!
    private var retryTimer: Timer?
    private var targetScreen: NSScreen?
    private var notchW: CGFloat = 0
    private var notchH: CGFloat = 32
    private var lastSize = NSSize.zero

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
        config.mediaTypesRequiringUserActionForPlayback = [] // the call plays without a click
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
        panel.contentView = webView
        window = panel

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

    private func resize(to size: NSSize, animated: Bool) {
        var s = size
        s.width = min(max(s.width, 60), 900)
        s.height = min(max(s.height, 24), 640)
        guard s != lastSize else { return }
        lastSize = s
        let f = frame(for: s)
        if animated {
            NSAnimationContext.runAnimationGroup { ctx in
                ctx.duration = 0.25
                ctx.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
                window.animator().setFrame(f, display: true)
            }
        } else {
            window.setFrame(f, display: true)
        }
    }

    @objc private func screensChanged() {
        pickScreen()
        lastSize = .zero
        load()
    }

    // MARK: WKScriptMessageHandler — the page's expand/collapse/quit channel
    func userContentController(_ userContentController: WKUserContentController,
                               didReceive message: WKScriptMessage) {
        guard let body = message.body as? [String: Any], let type = body["type"] as? String else { return }
        switch type {
        case "size":
            if let w = body["w"] as? Double, let h = body["h"] as? Double {
                resize(to: NSSize(width: w + 8, height: h + 4), animated: true)
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
