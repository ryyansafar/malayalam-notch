import CoreGraphics
import Foundation

// usage: mouse move X Y | drag X1 Y1 X2 Y2 [steps] [holdAtEndSeconds] | click X Y
let a = CommandLine.arguments
func post(_ type: CGEventType, _ x: Double, _ y: Double) {
    let e = CGEvent(mouseEventSource: nil, mouseType: type, mouseCursorPosition: CGPoint(x: x, y: y), mouseButton: .left)
    e?.post(tap: .cghidEventTap)
}
func d(_ i: Int) -> Double { Double(a[i])! }
switch a[1] {
case "move": post(.mouseMoved, d(2), d(3))
case "click": post(.mouseMoved, d(2), d(3)); usleep(80_000); post(.leftMouseDown, d(2), d(3)); usleep(60_000); post(.leftMouseUp, d(2), d(3))
case "drag":
    let (x1, y1, x2, y2) = (d(2), d(3), d(4), d(5))
    let steps = a.count > 6 ? Int(a[6])! : 40
    let hold = a.count > 7 ? Double(a[7])! : 0
    post(.mouseMoved, x1, y1); usleep(150_000)
    post(.leftMouseDown, x1, y1); usleep(200_000)
    for s in 1...steps {
        let t = Double(s) / Double(steps)
        post(.leftMouseDragged, x1 + (x2 - x1) * t, y1 + (y2 - y1) * t)
        usleep(25_000)
    }
    usleep(UInt32(hold * 1_000_000))
    post(.leftMouseUp, x2, y2)
case "type":
    for ch in a[2] {
        let up = Array(String(ch).utf16)
        let d = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: true)
        d?.keyboardSetUnicodeString(stringLength: up.count, unicodeString: up); d?.post(tap: .cghidEventTap)
        let u = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: false)
        u?.keyboardSetUnicodeString(stringLength: up.count, unicodeString: up); u?.post(tap: .cghidEventTap)
        usleep(18_000)
    }
case "enter":
    let d = CGEvent(keyboardEventSource: nil, virtualKey: 36, keyDown: true); d?.post(tap: .cghidEventTap)
    let u = CGEvent(keyboardEventSource: nil, virtualKey: 36, keyDown: false); u?.post(tap: .cghidEventTap)
default: print("bad command")
}
