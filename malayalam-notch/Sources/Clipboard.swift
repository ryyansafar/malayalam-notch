//
//  Clipboard.swift — Malayalam Notch
//  A short, private clipboard history: opt-in, memory only. Secrets and huge copies are skipped.
//

import AppKit
import SwiftUI

@MainActor
final class ClipboardModel: ObservableObject {
    static let shared = ClipboardModel()

    struct Item: Identifiable, Equatable {
        let id = UUID()
        let text: String
    }

    /// Off by default — nothing is remembered until the user asks for it.
    @Published var enabled = UserDefaults.standard.bool(forKey: "clipboardHistory") {
        didSet {
            UserDefaults.standard.set(enabled, forKey: "clipboardHistory")
            if !enabled { items = [] }
            lastCount = NSPasteboard.general.changeCount
        }
    }
    @Published private(set) var items: [Item] = []   // memory only: never written to disk
    @Published private(set) var copiedID: UUID?

    private var lastCount = NSPasteboard.general.changeCount
    private var watcher: Timer?
    private var copiedReset: Task<Void, Never>?

    func start() {
        guard watcher == nil else { return }
        watcher = Timer.scheduledTimer(withTimeInterval: 0.6, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.poll() }
        }
    }

    private func poll() {
        let pb = NSPasteboard.general
        guard pb.changeCount != lastCount else { return }
        lastCount = pb.changeCount
        guard enabled else { return }
        // never keep what a password manager marked as secret or transient
        let secret = pb.types?.contains { $0.rawValue == "org.nspasteboard.ConcealedType" || $0.rawValue == "org.nspasteboard.TransientType" } ?? false
        guard !secret, let s = pb.string(forType: .string), s.count <= 2000,
              !s.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
        items.removeAll { $0.text == s }
        items.insert(Item(text: s), at: 0)
        if items.count > 20 { items = Array(items.prefix(20)) }
    }

    func copyAgain(_ item: Item) {
        let pb = NSPasteboard.general
        pb.clearContents()
        pb.setString(item.text, forType: .string)
        lastCount = pb.changeCount   // don't re-record our own copy
        copiedID = item.id
        copiedReset?.cancel()
        copiedReset = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 1_200_000_000)
            guard !Task.isCancelled else { return }
            self?.copiedID = nil
        }
    }

    func remove(_ item: Item) { items.removeAll { $0.id == item.id } }
    func clear() { items = [] }

    static func isMalayalam(_ s: String) -> Bool {
        s.unicodeScalars.contains { (0x0D00...0x0D7F).contains($0.value) }
    }
}

struct ClipboardView: View {
    @ObservedObject private var m = ClipboardModel.shared

    var body: some View {
        Card(title: "CLIPBOARD HISTORY") {
            VStack(alignment: .leading, spacing: 7) {
                Toggle(isOn: $m.enabled) {
                    Text("Keep a short history of what I copy").font(Design.Font.body)
                }
                .toggleStyle(.switch).tint(MalayalamTheme.accent)

                if m.enabled {
                    if m.items.isEmpty {
                        Text("Copy some text and it will appear here.")
                            .font(Design.Font.caption)
                            .foregroundStyle(.white.opacity(Design.Text.secondary))
                    } else {
                        ForEach(m.items.prefix(6)) { item in row(item) }
                        HStack {
                            Spacer(minLength: 0)
                            Chip(symbol: "trash", text: "Clear") { m.clear() }
                        }
                    }
                }
                Spacer(minLength: 0)
            }
        }
        .onAppear { m.start() }
    }

    private func row(_ item: ClipboardModel.Item) -> some View {
        HStack(spacing: 7) {
            Button {
                m.copyAgain(item)
            } label: {
                let first = item.text.components(separatedBy: .newlines).first ?? item.text
                if ClipboardModel.isMalayalam(first) {
                    Text(first).font(Design.Font.ml).lineSpacing(5).lineLimit(1)
                } else {
                    Text(first).font(Design.Font.caption).lineLimit(1)
                }
            }
            .buttonStyle(.plain)
            .frame(maxWidth: .infinity, alignment: .leading)
            .contentShape(Rectangle())
            if m.copiedID == item.id {
                Text("Copied").font(Design.Font.caption).foregroundStyle(MalayalamTheme.accent)
            }
            Button {
                m.remove(item)
            } label: {
                Image(systemName: "xmark").font(.system(size: 9, weight: .semibold))
                    .foregroundStyle(.white.opacity(Design.Text.tertiary))
            }
            .buttonStyle(.plain)
        }
    }
}
