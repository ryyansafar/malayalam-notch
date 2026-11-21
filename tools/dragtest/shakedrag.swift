// shakedrag: press on a chip, drag to the notch, shake side to side three times, hold, then drop on a target.
//   shakedrag <startX> <startY> <notchX> <notchY> <dropX> <dropY>   (points, top-left origin)
import AppKit
func post(_ t: CGEventType, _ x: Double, _ y: Double) {
    CGEvent(mouseEventSource: nil, mouseType: t, mouseCursorPosition: CGPoint(x: x, y: y), mouseButton: .left)?.post(tap: .cghidEventTap)
}
let a = CommandLine.arguments.dropFirst().compactMap(Double.init)
guard a.count == 6 else { print("usage"); exit(2) }
func move(_ t: CGEventType, _ x0: Double, _ y0: Double, _ x1: Double, _ y1: Double, steps: Int, delay: UInt32) {
    for i in 1...steps { let f = Double(i) / Double(steps); post(t, x0 + (x1 - x0) * f, y0 + (y1 - y0) * f); usleep(delay) }
}
post(.mouseMoved, a[0], a[1]); usleep(150_000)
post(.leftMouseDown, a[0], a[1]); usleep(200_000)
move(.leftMouseDragged, a[0], a[1], a[2], a[3], steps: 40, delay: 16_000)
var x = a[2]
for _ in 0..<3 { move(.leftMouseDragged, x, a[3], a[2] + 70, a[3], steps: 8, delay: 14_000); move(.leftMouseDragged, a[2] + 70, a[3], a[2] - 70, a[3], steps: 16, delay: 14_000); x = a[2] - 70 }
move(.leftMouseDragged, x, a[3], a[2], a[3], steps: 6, delay: 14_000)
usleep(1_500_000)                       // the island opens now
move(.leftMouseDragged, a[2], a[3], a[4], a[5], steps: 30, delay: 20_000)
usleep(500_000)
post(.leftMouseUp, a[4], a[5])
