import SwiftUI

/// The toolbar's update status, before the view switch: says an update is
/// available, shows it downloading and being prepared, and offers Relaunch Now
/// once it's ready. It sits in the toolbar's own glass capsule like Today and
/// the arrows, with the same hover pills (`ToolbarPillButtonStyle`); only the
/// status icon carries colour. Draws `AppUpdater.status`; CalendarToolbar
/// leaves the item out while that's idle.
struct UpdatePill: View {
  let status: UpdateStatus
  private let updater = AppUpdater.shared
  /// Toolbar controls grey out while the window is in the background.
  @Environment(\.appearsActive) private var appearsActive

  var body: some View {
    HStack(spacing: 2) {
      HStack(spacing: 7) {
        icon
          .frame(width: 16, height: 16)
        Text(title)
          .lineLimit(1)
        if case .downloading(let progress?) = status {
          Text(progress, format: .percent.precision(.fractionLength(0)))
            .monospacedDigit()
            .foregroundStyle(.secondary)
            .contentTransition(.numericText(value: progress))
        }
      }
      .font(.system(size: 13, weight: .medium))
      .foregroundStyle(appearsActive ? .primary : .secondary)
      // Lines the text up with a pill's label, as "Today" sits beside its arrows.
      .padding(.horizontal, 10)
      .frame(minHeight: 28)
      .help(helpText)

      actions
        .buttonStyle(ToolbarPillButtonStyle())
    }
    // The capsule's own inset around its pills, as in the view switch.
    .padding(.horizontal, 4)
    .fixedSize()
    .animation(.snappy(duration: 0.3), value: status)
    .accessibilityElement(children: .contain)
    .accessibilityLabel(title)
  }

  // MARK: Parts

  @ViewBuilder private var icon: some View {
    switch status {
    case .checking, .downloading(nil), .preparing:
      ProgressView().controlSize(.small)
    case .downloading(let progress?):
      ProgressView(value: progress).progressViewStyle(.circular).controlSize(.small)
    case .upToDate, .ready:
      Image(systemName: "checkmark.circle.fill").foregroundStyle(Palette.meet)
    case .available:
      Image(systemName: "arrow.down.circle.fill")
    case .failed:
      Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(.orange)
    case .idle:
      EmptyView()
    }
  }

  /// The main action rests on a soft fill, like the view switch's selected
  /// segment; the ✕ only shows its pill on hover, like the arrows.
  @ViewBuilder private var actions: some View {
    switch status {
    case .available:
      Button("Update") { updater.install() }
        .buttonStyle(ToolbarPillButtonStyle(selected: true))
      dismissButton(help: "Not now")
    case .ready:
      Button("Relaunch Now") { updater.relaunch() }
        .buttonStyle(ToolbarPillButtonStyle(selected: true))
      dismissButton(help: "Install when Qali quits")
    default:
      EmptyView()
    }
  }

  private func dismissButton(help: String) -> some View {
    Button { updater.dismiss() } label: {
      Label(help, systemImage: "xmark")
        .labelStyle(.iconOnly)
        .imageScale(.small)
    }
    .help(help)
  }

  private var title: String {
    switch status {
    case .idle: ""
    case .checking: "Checking for updates"
    case .upToDate: "Qali is up to date"
    case .available(let version): version.isEmpty ? "Update available" : "Qali \(version) is available"
    case .downloading: "Downloading update"
    case .preparing: "Preparing update"
    case .ready: "Update ready"
    case .failed: "Couldn't update"
    }
  }

  private var helpText: String {
    switch status {
    case .ready(let version) where !version.isEmpty: "Qali \(version) is ready. Relaunch to finish, or it installs when you quit."
    case .ready: "Relaunch to finish, or it installs when you quit."
    case .failed(let message): message
    default: title
    }
  }
}
