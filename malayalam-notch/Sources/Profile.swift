//
//  Profile.swift — Malayalam Notch
//  "About me": what the user told the assistant, stored only on this Mac (a 0600 file in Application
//  Support). Facts are used on this Mac freely; they go to the cloud model only while the share switch
//  is on, only the facts marked shared, capped, and the exact text is always visible in the Me tab.
//

import AppKit
import SwiftUI

struct ProfileFact: Codable, Identifiable, Equatable {
    var id = UUID()
    var text: String
    var source: String          // "typed" | "spoken"
    var share = true
    var added = Date()
}

@MainActor
final class ProfileModel: ObservableObject {
    static let shared = ProfileModel()

    @Published var facts: [ProfileFact] = [] { didSet { save() } }
    @Published var shareWithCloud = UserDefaults.standard.object(forKey: "profileShare") as? Bool ?? true {
        didSet { UserDefaults.standard.set(shareWithCloud, forKey: "profileShare") }
    }

    private let url: URL? = {
        guard let dir = try? FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
            .appendingPathComponent("MalayalamNotch", isDirectory: true) else { return nil }
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir.appendingPathComponent("profile.json")
    }()

    init() {
        if let url, let d = try? Data(contentsOf: url), let f = try? JSONDecoder().decode([ProfileFact].self, from: d) { facts = f }
    }

    private func save() {
        guard let url, let d = try? JSONEncoder().encode(facts) else { return }
        try? d.write(to: url, options: .atomic)
        try? FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
    }

    func add(_ text: String, source: String) {
        let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !t.isEmpty, facts.count < 60 else { return }
        facts.insert(ProfileFact(text: String(t.prefix(240)), source: source), at: 0)
    }
    func remove(_ f: ProfileFact) { facts.removeAll { $0.id == f.id } }
    func toggleShare(_ f: ProfileFact) { if let i = facts.firstIndex(of: f) { facts[i].share.toggle() } }
    func forgetAll() { facts = []; if let url { try? FileManager.default.removeItem(at: url) } }

    /// Exactly what is sent to the cloud model with a request (nil when sharing is off or nothing is shared).
    func cloudString() -> String? {
        guard shareWithCloud else { return nil }
        let shared = facts.filter(\.share).map(\.text)
        guard !shared.isEmpty else { return nil }
        var out = ""
        for line in shared { if out.count + line.count + 3 > 600 { break }; out += (out.isEmpty ? "" : "; ") + line }
        return out.isEmpty ? nil : out
    }
}

struct MeView: View {
    @ObservedObject private var p = ProfileModel.shared
    @ObservedObject private var a = AssistantModel.shared
    @ObservedObject private var vm = MalayalamViewModel.shared
    @State private var draft = ""

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            card("TELL ME ABOUT YOU") { tellArea }.frame(maxWidth: .infinity)
            card("WHAT I KNOW") { knownArea }.frame(width: 330)
            card("WHAT THE CLOUD SEES") { cloudArea }.frame(width: 250)
        }
    }

    private func card<C: View>(_ title: String, @ViewBuilder _ content: () -> C) -> some View {
        VStack(alignment: .leading, spacing: 7) {
            Text(Design.sentence(title)).font(Design.Font.caption).foregroundStyle(.white.opacity(Design.Text.tertiary))
            content()
        }
        .padding(.horizontal, 11).padding(.vertical, 9)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background(RoundedRectangle(cornerRadius: 16, style: .continuous).fill(Color.white.opacity(0.055)))
    }

    private var tellArea: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                Text("Your name").font(.system(size: 11)).foregroundStyle(.secondary).frame(width: 64, alignment: .leading)
                TextField("e.g. Ryyan", text: $a.userName).textFieldStyle(.plain).font(.system(size: 12.5))
                    .padding(.horizontal, 10).frame(height: 28).background(Capsule().fill(Color.white.opacity(0.09)))
            }
            HStack(spacing: 8) {
                TextField("Tell me something to remember — Malayalam or English", text: $draft)
                    .textFieldStyle(.plain).font(.system(size: 12.5))
                    .onSubmit(save)
                Button(action: save) { Image(systemName: "plus.circle.fill").font(.system(size: 18)).foregroundStyle(MalayalamTheme.accent) }
                    .buttonStyle(.plain).disabled(draft.trimmingCharacters(in: .whitespaces).isEmpty)
            }
            .padding(.horizontal, 10).frame(height: 34).background(Capsule().fill(Color.white.opacity(0.09)))
            Text("Say it instead: hold the mic and tell me about yourself.").font(.system(size: 10.5)).foregroundStyle(.secondary)
            Spacer(minLength: 0)
            HStack(spacing: 8) {
                micButton
                Text("e.g. “My mother is Amma. I live in Alappuzha. I take my tablet at 8.”")
                    .font(.system(size: 10)).foregroundStyle(.tertiary).lineLimit(2)
            }
        }
    }

    private func save() { p.add(draft, source: "typed"); draft = "" }

    private var micButton: some View {
        let rec = vm.phase == .recording && vm.profileCapture
        return HStack(spacing: 6) {
            Image(systemName: rec ? "waveform" : "mic.fill").font(.system(size: 11, weight: .bold))
            Text(rec ? "Listening…" : "Hold to tell me").font(.system(size: 11, weight: .semibold))
        }
        .foregroundStyle(rec ? Color.black : .white).padding(.horizontal, 12).frame(height: 30)
        .background(Capsule().fill(rec ? MalayalamTheme.accent : Color.white.opacity(0.12)))
        .contentShape(Capsule())
        .onLongPressGesture(minimumDuration: 0, maximumDistance: .infinity, pressing: { pressing in
            if pressing { vm.profileCapture = true; vm.startRecording() } else { vm.stopRecording() }
        }, perform: {})
    }

    private var knownArea: some View {
        VStack(alignment: .leading, spacing: 5) {
            if p.facts.isEmpty {
                Spacer(minLength: 0)
                Text("Nothing yet").font(.system(size: 12, weight: .medium)).foregroundStyle(.secondary)
                Text("Say “remember that …” anywhere, or add facts on the left.").font(.system(size: 10.5)).foregroundStyle(.tertiary)
                Spacer(minLength: 0)
            } else {
                ForEach(p.facts.prefix(5)) { f in
                    HStack(spacing: 7) {
                        Button { p.toggleShare(f) } label: {
                            Image(systemName: f.share ? "cloud.fill" : "lock.fill").font(.system(size: 10))
                                .foregroundStyle(f.share ? MalayalamTheme.accent : Color.secondary)
                        }.buttonStyle(.plain).help(f.share ? "Shared with the assistant (cloud). Click to keep it on this Mac only." : "Only on this Mac. Click to share.")
                        Text(f.text).font(.system(size: 11.5)).lineLimit(1)
                        Spacer(minLength: 0)
                        Button { p.remove(f) } label: { Image(systemName: "xmark.circle.fill").foregroundStyle(.secondary) }.buttonStyle(.plain)
                    }
                }
                if p.facts.count > 5 { Text("+\(p.facts.count - 5) more").font(.system(size: 10)).foregroundStyle(.tertiary) }
                Spacer(minLength: 0)
                Button("Forget everything") { p.forgetAll() }.buttonStyle(.plain).font(.system(size: 10.5, weight: .semibold)).foregroundStyle(.orange)
            }
        }
    }

    private var cloudArea: some View {
        VStack(alignment: .leading, spacing: 7) {
            Toggle(isOn: $p.shareWithCloud) { Text("Give the assistant these facts").font(.system(size: 11.5, weight: .semibold)) }
                .toggleStyle(.switch).tint(MalayalamTheme.accent)
            Text(p.cloudString() ?? (p.shareWithCloud ? "Nothing is shared." : "Sharing is off. The assistant only sees what you type to it."))
                .font(.system(size: 10.5)).foregroundStyle(.secondary).lineLimit(5)
            Spacer(minLength: 0)
            Text("Stored only on this Mac. Files, clipboard and contacts are never sent.").font(.system(size: 9.5)).foregroundStyle(.tertiary)
        }
    }
}
