//
//  TabsExtra.swift — Malayalam Notch
//  The Now tab (music, system, briefing) and the Activity tab (audit log, kill switch, phone setup).
//

import AppKit
import SwiftUI

private func card<C: View>(_ title: String, @ViewBuilder _ content: () -> C) -> some View {
    VStack(alignment: .leading, spacing: 7) {
        Text(title).font(.system(size: 8.5, weight: .semibold)).tracking(1.4).foregroundStyle(.secondary)
        content()
    }
    .padding(.horizontal, 11).padding(.vertical, 9)
    .frame(maxHeight: .infinity, alignment: .topLeading)
    .background(RoundedRectangle(cornerRadius: 16, style: .continuous).fill(Color.white.opacity(0.055)))
}

private func pill(_ symbol: String, _ text: String, action: @escaping () -> Void) -> some View {
    Button(action: action) {
        HStack(spacing: 5) {
            Image(systemName: symbol).font(.system(size: 10.5, weight: .semibold))
            Text(text).font(.system(size: 10.5, weight: .semibold))
        }
        .foregroundStyle(.white).padding(.horizontal, 10).frame(height: 26)
        .background(Capsule().fill(Color.white.opacity(0.12)))
    }.buttonStyle(.plain)
}

// MARK: Now
struct NowView: View {
    @ObservedObject private var a = AssistantModel.shared
    @State private var tick = Date()
    private let timer = Timer.publish(every: 5, on: .main, in: .common).autoconnect()

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            card("NOW PLAYING") { NowPlayingView() }.frame(width: 290)
            card("THIS MAC") { systemArea }.frame(width: 240)
            card("YOUR DAY") { dayArea }.frame(maxWidth: .infinity)
        }
        .onReceive(timer) { tick = $0 }
    }

    private var systemArea: some View {
        VStack(alignment: .leading, spacing: 8) {
            let b = SystemInfo.battery()
            stat("battery.100", "Battery", b.map { "\($0.percent)%\($0.charging ? " · charging" : "")" } ?? "—")
            stat("internaldrive", "Free space", SystemInfo.diskFreeGB().map { "\($0) GB" } ?? "—")
            stat("clock", "Up for", SystemInfo.uptimeText())
            stat("app.badge", "Apps open", "\(NSWorkspace.shared.runningApplications.filter { $0.activationPolicy == .regular }.count)")
            Spacer(minLength: 0)
        }.id(tick)
    }

    private func stat(_ symbol: String, _ label: String, _ value: String) -> some View {
        HStack(spacing: 8) {
            Image(systemName: symbol).font(.system(size: 12)).foregroundStyle(MalayalamTheme.accent).frame(width: 18)
            Text(label).font(.system(size: 11.5)).foregroundStyle(.secondary)
            Spacer(minLength: 0)
            Text(value).font(.system(size: 11.5, weight: .semibold).monospacedDigit())
        }
    }

    private var dayArea: some View {
        VStack(alignment: .leading, spacing: 6) {
            if a.upcoming.isEmpty { Text("No reminders today").font(.system(size: 12)).foregroundStyle(.secondary) }
            ForEach(a.upcoming.prefix(3)) { r in
                HStack(spacing: 8) {
                    Image(systemName: r.ring ? "phone.fill" : "bell.fill").font(.system(size: 10)).foregroundStyle(MalayalamTheme.accent)
                    Text(r.text).font(.system(size: 11.5, weight: .medium)).lineLimit(1)
                    Spacer(minLength: 0)
                    Text(r.fire, style: .time).font(.system(size: 10.5).monospacedDigit()).foregroundStyle(.secondary)
                }
            }
            if !a.briefingText.isEmpty { Text(a.briefingText).font(.system(size: 10.5)).foregroundStyle(.tertiary).lineLimit(3) }
            Spacer(minLength: 0)
            pill("speaker.wave.2.fill", "Read my day in Malayalam") { a.briefing() }
        }
    }
}

// MARK: Activity
struct ActivityView: View {
    @ObservedObject private var a = AssistantModel.shared
    @State private var callReady: Bool?
    @State private var missing: [String] = []

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            card("WHAT I DID") { logArea }.frame(maxWidth: .infinity)
            card("CONTROL") { controlArea }.frame(width: 250)
            card("PHONE CALLS") { phoneArea }.frame(width: 280)
        }
        .task { await loadStatus() }
    }

    private var logArea: some View {
        VStack(alignment: .leading, spacing: 5) {
            if a.audit.isEmpty { Spacer(minLength: 0); Text("Nothing yet. Every action I take is listed here.").font(.system(size: 11.5)).foregroundStyle(.secondary); Spacer(minLength: 0) }
            ForEach(a.audit.prefix(7)) { e in
                HStack(spacing: 7) {
                    Text(e.ts, style: .time).font(.system(size: 9.5).monospacedDigit()).foregroundStyle(.tertiary).frame(width: 50, alignment: .leading)
                    Text(e.tool).font(.system(size: 10.5, weight: .semibold)).frame(width: 96, alignment: .leading).lineLimit(1)
                    Text(e.tier.prefix(2)).font(.system(size: 8.5, weight: .bold))
                        .padding(.horizontal, 5).padding(.vertical, 1)
                        .background(Capsule().fill(e.tier.hasPrefix("T2") ? Color.orange.opacity(0.25) : Color.white.opacity(0.1)))
                    Text(e.result).font(.system(size: 10.5)).foregroundStyle(.secondary).lineLimit(1)
                    Spacer(minLength: 0)
                }
            }
            Spacer(minLength: 0)
        }
    }

    private var controlArea: some View {
        VStack(alignment: .leading, spacing: 8) {
            Button { a.paused.toggle() } label: {
                HStack(spacing: 7) {
                    Image(systemName: a.paused ? "play.fill" : "pause.fill")
                    Text(a.paused ? "Assistant paused — resume" : "Pause the assistant").font(.system(size: 11.5, weight: .semibold))
                }
                .foregroundStyle(a.paused ? Color.black : .white).frame(maxWidth: .infinity, minHeight: 32)
                .background(Capsule().fill(a.paused ? Color.orange : Color.red.opacity(0.45)))
            }.buttonStyle(.plain)
            VStack(alignment: .leading, spacing: 3) {
                Text("T0 read — runs and is logged").font(.system(size: 10)).foregroundStyle(.secondary)
                Text("T1 change — runs and is logged").font(.system(size: 10)).foregroundStyle(.secondary)
                Text("T2 confirm — always asks first").font(.system(size: 10, weight: .semibold)).foregroundStyle(.orange)
            }
            Spacer(minLength: 0)
            Text("No shell, no deleting files, nothing leaves this Mac unless you ask.").font(.system(size: 9.5)).foregroundStyle(.tertiary)
        }
    }

    private var phoneArea: some View {
        VStack(alignment: .leading, spacing: 7) {
            HStack(spacing: 8) {
                Image(systemName: "phone.fill").font(.system(size: 11)).foregroundStyle(MalayalamTheme.accent)
                TextField("+91 your number", text: $a.phone).textFieldStyle(.plain).font(.system(size: 12.5))
            }
            .padding(.horizontal, 10).frame(height: 30).background(Capsule().fill(Color.white.opacity(0.09)))
            HStack(spacing: 6) {
                Circle().fill(callReady == true ? Color.green : Color.orange).frame(width: 7, height: 7)
                Text(callReady == true ? "Phone line ready" : (callReady == nil ? "Checking…" : "Not set up yet")).font(.system(size: 11, weight: .semibold))
            }
            if callReady == false {
                Text("Add the Sarvam Voice Agent ids to .env (SARVAM_VOICE_*). Until then reminders are spoken on this Mac.")
                    .font(.system(size: 10)).foregroundStyle(.secondary).lineLimit(4)
            } else {
                Text("Say “ring my phone in 2 minutes to take my tablet”. I ask you first, then call in Malayalam.").font(.system(size: 10)).foregroundStyle(.secondary).lineLimit(3)
            }
            Spacer(minLength: 0)
            pill("phone.arrow.up.right", "Ring me now (test)") { _ = MalayalamActions.perform(.callMe(text: "ഇത് ഒരു പരീക്ഷണ കോൾ ആണ്"), source: "rule") }
        }
    }

    private func loadStatus() async {
        guard let url = URL(string: "http://localhost:3000/api/call/status"),
              let (d, _) = try? await URLSession.shared.data(from: url),
              let j = try? JSONSerialization.jsonObject(with: d) as? [String: Any] else { callReady = false; return }
        callReady = j["configured"] as? Bool ?? false
        missing = (j["missing"] as? [String]) ?? []
    }
}
