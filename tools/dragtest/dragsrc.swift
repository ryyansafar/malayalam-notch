import AppKit

// A small always-on-top window with one draggable file chip (a real file URL on the drag pasteboard).
let filePath = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : ""
final class Chip: NSView, NSDraggingSource {
    func draggingSession(_ session: NSDraggingSession, sourceOperationMaskFor context: NSDraggingContext) -> NSDragOperation { .copy }
    override func draw(_ r: NSRect) {
        NSColor(calibratedWhite: 0.12, alpha: 1).setFill(); NSBezierPath(roundedRect: bounds, xRadius: 14, yRadius: 14).fill()
        let t = "PTT-test-2.opus\n(drag me to the notch)" as NSString
        t.draw(in: bounds.insetBy(dx: 12, dy: 38), withAttributes: [.foregroundColor: NSColor.white, .font: NSFont.systemFont(ofSize: 13)])
    }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
    override func mouseDown(with e: NSEvent) {
        let url = URL(fileURLWithPath: filePath) as NSURL
        let item = NSDraggingItem(pasteboardWriter: url)
        item.setDraggingFrame(NSRect(x: 0, y: 0, width: 64, height: 64), contents: NSWorkspace.shared.icon(forFile: filePath))
        beginDraggingSession(with: [item], event: e, source: self)
    }
}
let app = NSApplication.shared
app.setActivationPolicy(.accessory)
final class KeyWindow: NSWindow { override var canBecomeKey: Bool { true } }
let w = KeyWindow(contentRect: NSRect(x: 600, y: 500, width: 220, height: 110), styleMask: [.borderless], backing: .buffered, defer: false)
w.level = .floating
w.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
w.contentView = Chip(frame: NSRect(x: 0, y: 0, width: 220, height: 110))
w.makeKeyAndOrderFront(nil)
app.run()
