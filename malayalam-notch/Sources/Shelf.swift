//
//  Shelf.swift — Malayalam Notch
//  A file shelf: drop files to keep shortcuts handy. Files are never copied, moved, or deleted.
//

import AppKit
import SwiftUI
import UniformTypeIdentifiers

@MainActor
final class ShelfModel: ObservableObject {
    static let shared = ShelfModel()

    struct Entry: Identifiable, Equatable {
        let path: String
        var id: String { path }
        var url: URL { URL(fileURLWithPath: path) }
    }

    @Published private(set) var entries: [Entry] = []
    private let key = "fileShelf.paths"
    private let limit = 12

    private init() {
        entries = (UserDefaults.standard.stringArray(forKey: key) ?? []).map(Entry.init)
        prune()   // drop shortcuts whose file is gone
    }

    /// Drop entries whose file no longer exists.
    func prune() {
        let kept = entries.filter { FileManager.default.fileExists(atPath: $0.path) }
        if kept != entries { entries = kept; save() }
    }

    func add(_ urls: [URL]) {
        for url in urls where url.isFileURL {
            let path = url.path(percentEncoded: false)
            guard FileManager.default.fileExists(atPath: path) else { continue }
            entries.removeAll { $0.path == path }
            entries.insert(Entry(path: path), at: 0)
        }
        entries = Array(entries.prefix(limit))
        save()
    }

    /// Removes the shortcut only — the file itself is never touched.
    func remove(_ entry: Entry) {
        entries.removeAll { $0.id == entry.id }
        save()
    }

    func reveal(_ entry: Entry) {
        guard FileManager.default.fileExists(atPath: entry.path) else { prune(); return }
        NSWorkspace.shared.activateFileViewerSelecting([entry.url])
    }

    private func save() {
        UserDefaults.standard.set(entries.map(\.path), forKey: key)
    }
}

struct ShelfView: View {
    @ObservedObject private var m = ShelfModel.shared
    @State private var targeted = false
    private let cols = [GridItem(.adaptive(minimum: 112, maximum: 140), spacing: 14, alignment: .top)]

    var body: some View {
        ZStack {
            if m.entries.isEmpty {
                VStack(spacing: 10) {
                    Image(systemName: "tray.and.arrow.down").font(.system(size: 46, weight: .light)).foregroundStyle(MalayalamTheme.accent.opacity(0.85))
                    Text("Drop files here").font(.system(size: 20, weight: .semibold))
                    Text("They wait on the shelf. Drag them out when you need them.").font(Design.Font.body).foregroundStyle(.white.opacity(Design.Text.secondary))
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                ScrollView {
                    LazyVGrid(columns: cols, alignment: .leading, spacing: 14) {
                        ForEach(m.entries) { e in tile(e) }
                    }
                    .padding(.vertical, 4)
                }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(RoundedRectangle(cornerRadius: Design.Radius.card, style: .continuous).fill(MalayalamTheme.accent.opacity(targeted ? 0.12 : 0)))
        .overlay(RoundedRectangle(cornerRadius: Design.Radius.card, style: .continuous).strokeBorder(MalayalamTheme.accent.opacity(targeted ? 0.7 : 0), lineWidth: 1.2))
        .onDrop(of: [.fileURL], isTargeted: $targeted) { providers in
            for p in providers where p.canLoadObject(ofClass: URL.self) {
                _ = p.loadObject(ofClass: URL.self) { item, _ in
                    guard let url = item else { return }
                    Task { @MainActor in ShelfModel.shared.add([url]) }
                }
            }
            return true
        }
        .onAppear { m.prune() }
    }

    /// One file: its real icon, its name, click to show it in Finder, drag it anywhere, x to take it off the shelf.
    private func tile(_ e: ShelfModel.Entry) -> some View {
        VStack(spacing: 6) {
            Image(nsImage: NSWorkspace.shared.icon(forFile: e.path)).resizable().frame(width: 60, height: 60)
                .shadow(color: .black.opacity(0.4), radius: 4, y: 2)
            Text(e.url.lastPathComponent).font(Design.Font.caption).multilineTextAlignment(.center)
                .lineLimit(2).truncationMode(.middle).frame(maxWidth: 110)
        }
        .padding(.vertical, 10).padding(.horizontal, 6)
        .frame(width: 118)
        .background(RoundedRectangle(cornerRadius: 14, style: .continuous).fill(Color.white.opacity(0.06)))
        .overlay(alignment: .topTrailing) {
            Button { m.remove(e) } label: { Image(systemName: "xmark.circle.fill").font(.system(size: 16)).foregroundStyle(.white.opacity(0.55)) }
                .buttonStyle(.plain).padding(5)
        }
        .contentShape(RoundedRectangle(cornerRadius: 14))
        .onTapGesture { m.reveal(e) }
        .onDrag { NSItemProvider(contentsOf: e.url) ?? NSItemProvider() }
        .help("Click to show in Finder. Drag it anywhere.")
    }
}
