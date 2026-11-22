import AppKit
import SwiftUI

/// Reports the frame of the view it backs in its window's content view, top-left
/// origin, whenever that may have moved. SwiftUI's own geometry stops at its
/// hosting view, and a toolbar item is hosted apart from the window's content,
/// so this is how the content learns where a toolbar control sits.
struct WindowFrameReader: NSViewRepresentable {
  let report: (CGRect) -> Void

  func makeNSView(context: Context) -> ReaderView { ReaderView(report: report) }

  func updateNSView(_ view: ReaderView, context: Context) {
    view.report = report
    view.send()
  }

  final class ReaderView: NSView {
    var report: (CGRect) -> Void
    private var observers: [NSObjectProtocol] = []
    private var last: CGRect?

    init(report: @escaping (CGRect) -> Void) {
      self.report = report
      super.init(frame: .zero)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("ReaderView is created in code") }

    override func hitTest(_ point: NSPoint) -> NSView? { nil }

    /// Also called with no window as the view goes, which drops the
    /// observers.
    override func viewDidMoveToWindow() {
      super.viewDidMoveToWindow()
      for observer in observers { NotificationCenter.default.removeObserver(observer) }
      observers = []
      guard let window else { return }
      // The toolbar re-lays its items after the window changes size.
      let names: [Notification.Name] = [
        NSWindow.didResizeNotification, NSWindow.didEndLiveResizeNotification,
        NSWindow.didEnterFullScreenNotification, NSWindow.didExitFullScreenNotification,
      ]
      for name in names {
        observers.append(
          NotificationCenter.default.addObserver(forName: name, object: window, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.send() }
          })
      }
      send()
    }

    override func layout() {
      super.layout()
      send()
    }

    /// After this turn of the run loop, once the toolbar has laid out.
    func send() {
      DispatchQueue.main.async { [weak self] in
        guard let self, let window = self.window, let content = window.contentView else { return }
        var rect = content.convert(self.convert(self.bounds, to: nil), from: nil)
        if !content.isFlipped { rect.origin.y = content.bounds.height - rect.maxY }
        guard rect != self.last else { return }
        self.last = rect
        self.report(rect)
      }
    }
  }
}
