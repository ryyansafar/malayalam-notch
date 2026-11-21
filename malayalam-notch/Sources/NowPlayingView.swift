//
//  NowPlayingView.swift — Malayalam Notch
//  The "Now playing" area. Reads and controls Apple Music and Spotify through AppleScript
//  (the system asks for permission once). Browser and other audio is not shown.
//

import AppKit
import SwiftUI

@MainActor
final class NowPlayingModel: ObservableObject {
    static let shared = NowPlayingModel()

    @Published var title = ""
    @Published var artist = ""
    @Published var app = ""
    @Published var isPlaying = false
    @Published var artwork: NSImage?
    @Published var progress: Double = 0
    @Published var elapsed: Double = 0      // seconds
    @Published var total: Double = 0        // seconds

    private var timer: Timer?
    private var lastArtKey = ""

    private struct Player { let name: String; let bundle: String }
    private let players = [Player(name: "Music", bundle: "com.apple.Music"), Player(name: "Spotify", bundle: "com.spotify.client")]

    func start() {
        guard timer == nil else { return }
        refresh()
        timer = Timer.scheduledTimer(withTimeInterval: 1.5, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.refresh() }
        }
    }

    private func running(_ p: Player) -> Bool {
        NSWorkspace.shared.runningApplications.contains { $0.bundleIdentifier == p.bundle }
    }

    func refresh() {
        // Prefer whichever player is actually playing, else the first one that is running.
        var best: (Player, [String])?
        for p in players where running(p) {
            guard let info = query(p) else { continue }
            if best == nil || info[3] == "playing" { best = (p, info) }
            if info[3] == "playing" { break }
        }
        guard let (p, info) = best else { clear(); return }
        title = info[0]; artist = info[1]; app = p.name
        isPlaying = info[3] == "playing"
        let dur = Double(info[2]) ?? 0, pos = Double(info[4]) ?? 0
        let durSec = p.name == "Spotify" ? dur / 1000 : dur
        progress = dur > 0 ? min(max(pos / durSec, 0), 1) : 0
        elapsed = pos; total = durSec
        loadArtwork(p, key: "\(p.name)|\(title)|\(artist)")
    }

    private func clear() { title = ""; artist = ""; app = ""; isPlaying = false; artwork = nil; progress = 0; lastArtKey = "" }

    /// [name, artist, duration, state, position] or nil when nothing is loaded.
    private func query(_ p: Player) -> [String]? {
        let src = """
        tell application "\(p.name)"
            if player state is stopped then return ""
            set playerStatus to (player state as string)
            return (name of current track) & "\u{1F}" & (artist of current track) & "\u{1F}" & ((duration of current track) as string) & "\u{1F}" & playerStatus & "\u{1F}" & ((player position) as string)
        end tell
        """
        guard let out = run(src), !out.isEmpty else { return nil }
        let parts = out.components(separatedBy: "\u{1F}")
        return parts.count == 5 ? parts : nil
    }

    private func loadArtwork(_ p: Player, key: String) {
        guard key != lastArtKey else { return }
        lastArtKey = key
        artwork = nil
        if p.name == "Music" {
            // Raw artwork data is returned as a descriptor; write it out through the script bridge.
            let src = "tell application \"Music\" to return (data of artwork 1 of current track)"
            if let d = runData(src), let img = NSImage(data: d) { artwork = img }
        } else {
            let src = "tell application \"Spotify\" to return artwork url of current track"
            if let s = run(src), let url = URL(string: s) {
                URLSession.shared.dataTask(with: url) { data, _, _ in
                    guard let data, let img = NSImage(data: data) else { return }
                    DispatchQueue.main.async { NowPlayingModel.shared.artwork = img }
                }.resume()
            }
        }
    }

    private func run(_ source: String) -> String? {
        var err: NSDictionary?
        let r = NSAppleScript(source: source)?.executeAndReturnError(&err)
        return err == nil ? r?.stringValue : nil
    }
    private func runData(_ source: String) -> Data? {
        var err: NSDictionary?
        let r = NSAppleScript(source: source)?.executeAndReturnError(&err)
        return err == nil ? r?.data : nil
    }

    // MARK: Controls
    func sendCommand(_ cmd: String) { if app.isEmpty { refresh() }; control(cmd) }
    func playPause() { control("playpause") }
    func next() { control("next track") }
    func previous() { control("previous track") }
    private func control(_ cmd: String) {
        guard !app.isEmpty else { return }
        _ = run("tell application \"\(app)\" to \(cmd)")
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) { self.refresh() }
    }
}

struct NowPlayingView: View {
    @ObservedObject private var m = NowPlayingModel.shared

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if m.title.isEmpty {
                Spacer(minLength: 0)
                Image(systemName: "music.note").font(.system(size: 38, weight: .light)).foregroundStyle(MalayalamTheme.accent.opacity(0.8)).frame(maxWidth: .infinity)
                Text("Nothing playing").font(.system(size: 14, weight: .medium)).foregroundStyle(.white.opacity(Design.Text.secondary)).frame(maxWidth: .infinity)
                Spacer(minLength: 0)
            } else {
                HStack(alignment: .center, spacing: 22) {
                    artworkView
                    VStack(alignment: .leading, spacing: 6) {
                        Text(m.title).font(.system(size: 24, weight: .bold)).lineLimit(1)
                        Text(m.artist).font(.system(size: 18, weight: .medium)).foregroundStyle(MalayalamTheme.accent).lineLimit(1)
                        Spacer(minLength: 4)
                        ProgressView(value: m.progress).progressViewStyle(.linear).tint(MalayalamTheme.accent).frame(height: 5)
                        HStack {
                            Text(Self.clock(m.elapsed)); Spacer(); Text(Self.clock(m.total))
                        }.font(.system(size: 12.5, weight: .medium).monospacedDigit()).foregroundStyle(.white.opacity(Design.Text.secondary))
                        HStack(spacing: 30) {
                            Spacer(minLength: 0)
                            transport("backward.fill", 20) { m.previous() }
                            transport(m.isPlaying ? "pause.fill" : "play.fill", 38) { m.playPause() }
                            transport("forward.fill", 20) { m.next() }
                            Spacer(minLength: 0)
                        }
                    }
                    .frame(height: 200)
                }
                .frame(maxHeight: .infinity, alignment: .center)
            }
        }
        .onAppear { m.start() }
    }

    static func clock(_ s: Double) -> String { let n = max(0, Int(s)); return String(format: "%d:%02d", n / 60, n % 60) }

    private var artworkView: some View {
        Group {
            if let a = m.artwork {
                Image(nsImage: a).resizable().aspectRatio(contentMode: .fill)
            } else {
                ZStack { Color.white.opacity(0.08); Image(systemName: "music.note").foregroundStyle(.secondary) }
            }
        }
        .frame(width: 200, height: 200)
        .clipShape(RoundedRectangle(cornerRadius: 24, style: .continuous))
        .scaleEffect(m.isPlaying ? 1 : 0.88)
        .opacity(m.isPlaying ? 1 : 0.7)
        .animation(.spring(response: 0.4, dampingFraction: 0.75), value: m.isPlaying)
        .shadow(color: .black.opacity(0.5), radius: 8, y: 4)
    }

    private func transport(_ symbol: String, _ size: CGFloat, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: symbol).font(.system(size: size, weight: .bold)).foregroundStyle(.white)
                .frame(width: 44, height: 40)
        }
        .buttonStyle(.plain)
    }
}
