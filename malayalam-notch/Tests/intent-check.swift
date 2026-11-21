// Screen-free checks for the local command rules (MalayalamIntent.swift). Run: ./test.sh
import Foundation

var failures = 0
func check(_ name: String, _ ok: Bool) { if ok { print("ok   \(name)") } else { print("FAIL \(name)"); failures += 1 } }
let now = Date()

@main struct Runner {
    static func main() {
        func p(_ s: String) -> MalayalamIntent { MalayalamIntentParser.parse(s, now: now) }

        check("open app", p("open Calendar") == .openApp(name: "calendar"))
        check("whatsapp message", p("message Amma on WhatsApp saying I am late") == .whatsApp(contact: "Amma", text: "I am late"))
        check("just whatsapp", p("open WhatsApp") == .whatsApp(contact: nil, text: nil))
        if case .remind(let t, let d) = p("remind me to drink water in 10 minutes") {
            check("remind text", t == "drink water"); check("remind +10min", abs(d.timeIntervalSince(now) - 600) < 2)
        } else { check("remind parsed", false) }
        if case .remind(let t, let d) = p("remind me in 10 minutes to call Amma") {
            check("remind time-first text", t == "call Amma"); check("remind time-first +10min", abs(d.timeIntervalSince(now) - 600) < 2)
        } else { check("remind time-first parsed", false) }
        if case .timer(let s) = p("set a timer for 5 minutes") { check("timer 5 min", s == 300) } else { check("timer parsed", false) }
        if case .timer(let s) = p("set a timer for 90 seconds") { check("timer 90 s", s == 90) } else { check("timer s parsed", false) }
        check("tidy desktop", p("tidy my desktop") == .tidyDesktop)
        check("clipboard", p("translate the clipboard") == .translateClipboard)
        check("pause media", p("pause") == .media(command: "playpause"))
        check("next song", p("next song") == .media(command: "next track"))
        check("brightness lowest", p("please dim my laptop to the lowest") == .brightness(target: 0, delta: 0))
        check("brightness percent", p("set the brightness to 40 percent") == .brightness(target: 40, delta: 0))
        check("dim relative", p("dim the screen") == .brightness(target: nil, delta: -25))
        check("volume up", p("turn the volume up") == .volume(target: nil, delta: 15))
        check("mute", p("mute") == .volume(target: 0, delta: 0))
        check("dark mode", p("turn on dark mode") == .appearance(mode: "dark"))
        check("light mode", p("switch to light mode") == .appearance(mode: "light"))
        check("battery", p("what is my battery") == .battery)
        check("briefing", p("good morning") == .briefing)
        check("quit app", p("quit Safari") == .quitApp(name: "Safari"))
        check("find files", p("find my resume") == .findFiles(query: "my resume"))
        check("remember", p("remember that my mother is Amma") == .remember(text: "my mother is Amma"))
        if case .remindCall(let t, let d) = p("ring my phone in 2 minutes to take my tablet") {
            check("call text", t == "take my tablet"); check("call +2min", abs(d.timeIntervalSince(now) - 120) < 2)
        } else { check("remindCall parsed", false) }
        if case .callMe(let t) = p("call me to say dinner is ready") { check("call me text", t == "dinner is ready") } else { check("callMe parsed", false) }
        print("DBG", p("ring my phone in 2 minutes to test"))
        check("gibberish is none", p("blah blah purple") == .none)
        check("empty is none", p("   ") == .none)
        print(failures == 0 ? "ALL OK" : "\(failures) FAILED")
        exit(failures == 0 ? 0 : 1)
    }
}
