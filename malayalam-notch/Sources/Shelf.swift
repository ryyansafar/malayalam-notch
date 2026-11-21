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

    var body: some View {
        Card(title: "FILE SHELF") {
            VStack(alignment: .leading, spacing: 7) {
                if m.entries.isEmpty {
                    Text("Drop files here to keep them handy.")
                        .font(Design.Font.caption)
                        .foregroundStyle(.white.opacity(Design.Text.secondary))
                } else {
                    ForEach(m.entries) { e in row(e) }
                    Text("Files stay in place — nothing is copied or moved.")
                        .font(Design.Font.caption)
                        .foregroundStyle(.white.opacity(Design.Text.tertiary))
                }
                Spacer(minLength: 0)
            }
        }
        .overlay(
            RoundedRectangle(cornerRadius: Design.Radius.card, style: .continuous)
                .fill(MalayalamTheme.accent.opacity(targeted ? 0.1 : 0))
                .overlay(
                    RoundedRectangle(cornerRadius: Design.Radius.card, style: .continuous)
                        .strokeBorder(MalayalamTheme.accent.opacity(targeted ? 0.7 : 0), lineWidth: 1.2)
                )
        )
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

    private func row(_ e: ShelfModel.Entry) -> some View {
        HStack(spacing: 7) {
            Image(nsImage: NSWorkspace.shared.icon(forFile: e.path))
                .resizable().frame(width: 16, height: 16)
            Text(e.url.lastPathComponent)
                .font(Design.Font.caption).lineLimit(1).truncationMode(.middle)
            Spacer(minLength: 0)
            Button {
                m.reveal(e)
            } label: {
                Text("Reveal").font(Design.Font.caption)
                    .foregroundStyle(.white.opacity(Design.Text.secondary))
            }
            .buttonStyle(.plain)
            Button {
                m.remove(e)
            } label: {
                Image(systemName: "xmark").font(.system(size: 9, weight: .semibold))
                    .foregroundStyle(.white.opacity(Design.Text.tertiary))
            }
            .buttonStyle(.plain)
        }
        .onDrag { NSItemProvider(contentsOf: e.url) ?? NSItemProvider() }
    }
}
