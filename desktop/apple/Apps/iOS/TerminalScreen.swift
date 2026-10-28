import Observation
import PhiKit
import PhiTerminal
import SwiftUI
import UIKit

/// One live pane. Draw, resize and compose only; the shared `PaneSession`
/// owns the socket, the journal and the ordering rules.
struct TerminalScreen: View {
  let target: SavedTarget
  let pane: PaneCatalog.Pane

  @State private var model: TerminalModel?
  @State private var draft = ""
  @State private var newline = true
  @State private var size: CGSize = .zero

  var body: some View {
    VStack(spacing: 0) {
      GeometryReader { proxy in
        if let model {
          TerminalCanvas(snapshot: model.snapshot, metrics: model.metrics)
            .onChange(of: proxy.size, initial: true) { _, newSize in
              size = newSize
              model.fit(to: newSize)
            }
        } else {
          ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
        }
      }
      .background(Color.black)

      Text(model?.snapshot?.statusLine ?? "connecting")
        .font(.caption2)
        .lineLimit(2)
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 8)
        .padding(.vertical, 4)
        .background(.bar)

      compose
    }
    .navigationTitle(pane.title ?? pane.coder)
    .navigationBarTitleDisplayMode(.inline)
    .task {
      guard model == nil, let origin = URL(string: target.origin) else { return }
      let created = try? TerminalModel(origin: origin, pane: pane.id)
      model = created
      created?.start()
    }
    .onDisappear { model?.stop() }
  }

  private var compose: some View {
    HStack(spacing: 8) {
      TextField("Type for the pane", text: $draft)
        .textInputAutocapitalization(.never)
        .autocorrectionDisabled()
        .onSubmit { send() }
        .padding(8)
        .background(.quaternary, in: RoundedRectangle(cornerRadius: 8))
      Toggle("↵", isOn: $newline).toggleStyle(.button).labelsHidden()
      Button {
        model?.send(bytes: [0x03])
      } label: {
        Image(systemName: "stop.circle")
      }
      .disabled(model == nil)
      Button("Send") { send() }.buttonStyle(.borderedProminent).disabled(model == nil)
    }
    .padding(8)
  }

  private func send() {
    guard let model, !draft.isEmpty || newline else { return }
    var bytes = Array(draft.utf8)
    if newline { bytes.append(0x0d) }
    model.send(bytes: bytes)
    draft = ""
  }
}

@MainActor
@Observable
final class TerminalModel {
  let metrics = TerminalMetrics()
  var snapshot: PaneSession.Snapshot?

  private let session: PaneSession

  init(origin: URL, pane: String) throws {
    let support = FileManager.default.urls(
      for: .applicationSupportDirectory, in: .userDomainMask
    ).first ?? URL(fileURLWithPath: NSTemporaryDirectory())
    session = try PaneSession(
      origin: origin, paneID: pane,
      stateDir: support.appendingPathComponent("PhiPhone", isDirectory: true))
  }

  func start() {
    session.onUpdate = { [weak self] snapshot in
      self?.snapshot = snapshot
    }
    session.start()
  }

  func stop() {
    session.stop()
  }

  func send(bytes: [UInt8]) {
    session.send(bytes: bytes)
  }

  func fit(to size: CGSize) {
    guard size.width > 0, size.height > 0 else { return }
    session.resize(
      cols: max(1, Int(size.width / metrics.cellSize.width)),
      rows: max(1, Int(size.height / metrics.cellSize.height)))
  }
}

/// Monospaced cell metrics shared by the renderer and the resize math.
struct TerminalMetrics {
  let font: UIFont
  let cellSize: CGSize
  let baselineOffset: CGFloat

  init(size: CGFloat = 12) {
    font = UIFont.monospacedSystemFont(ofSize: size, weight: .regular)
    let advance = ("M" as NSString).size(withAttributes: [.font: font]).width
    cellSize = CGSize(width: advance.rounded(.up), height: font.lineHeight.rounded(.up))
    baselineOffset = font.ascender.rounded(.up)
  }
}

/// Draws the copied grid with Core Text through a `Canvas`. Wide glyphs and
/// per-cell colours use the same cell origin the macOS view uses.
struct TerminalCanvas: View {
  let snapshot: PaneSession.Snapshot?

  let metrics: TerminalMetrics

  private let background = Color(red: 0.06, green: 0.06, blue: 0.07)
  private let foreground = Color(white: 0.92)

  var body: some View {
    Canvas { context, size in
      context.fill(Path(CGRect(origin: .zero, size: size)), with: .color(background))
      guard let frame = snapshot?.frame else { return }
      let cols = max(1, Int(size.width / metrics.cellSize.width))

      for (row, text) in frame.rows.enumerated() where !text.isEmpty {
        context.draw(
          Text(text).font(Font(metrics.font)).foregroundStyle(foreground),
          at: CGPoint(x: 0, y: CGFloat(row) * metrics.cellSize.height),
          anchor: .topLeading)
      }

      for cell in frame.colored where cell.column < cols && cell.row < frame.rows.count {
        context.draw(
          Text(cell.text).font(Font(metrics.font)).foregroundColor(
            Color(red: Double(cell.red) / 255, green: Double(cell.green) / 255,
                  blue: Double(cell.blue) / 255)),
          at: CGPoint(
            x: CGFloat(cell.column) * metrics.cellSize.width,
            y: CGFloat(cell.row) * metrics.cellSize.height),
          anchor: .topLeading)
      }

      if let cursor = snapshot?.cursor, cursor.x < cols, cursor.y < frame.rows.count {
        let rect = CGRect(
          x: CGFloat(cursor.x) * metrics.cellSize.width,
          y: CGFloat(cursor.y) * metrics.cellSize.height,
          width: metrics.cellSize.width, height: metrics.cellSize.height)
        context.fill(Path(rect), with: .color(foreground))
        let glyph = String(glyphAt(frame: frame, x: cursor.x, y: cursor.y))
        context.draw(
          Text(glyph).font(Font(metrics.font)).foregroundStyle(background),
          at: rect.origin, anchor: .topLeading)
      }
    }
    .clipped()
  }

  private func glyphAt(frame: PaneWireClient.Frame, x: Int, y: Int) -> Character {
    let row = Array(frame.rows[safe: y] ?? "")
    return row[safe: x] ?? " "
  }
}

extension Array {
  subscript(safe index: Int) -> Element? {
    indices.contains(index) ? self[index] : nil
  }
}
