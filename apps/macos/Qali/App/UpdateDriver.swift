import AppKit
import Sparkle

/// Sparkle's user interface, replaced: instead of Sparkle's windows, each step
/// of an update becomes an `UpdateStatus` on `AppUpdater`, which the toolbar's
/// pill draws (found → downloading → preparing → ready to relaunch). The
/// pill's buttons answer through `choose(_:)`.
final class UpdateDriver: NSObject, SPUUserDriver {
  private unowned let owner: AppUpdater
  /// Sparkle's question for the update on show: install, dismiss or skip.
  private var pendingChoice: ((SPUUserUpdateChoice) -> Void)?
  /// The version on offer, kept for the ready pill once downloading has
  /// replaced it in the status.
  private var version = ""
  private var expectedBytes: UInt64 = 0
  private var receivedBytes: UInt64 = 0
  /// Clears a brief "up to date" or "failed" pill.
  private var clearTask: Task<Void, Never>?

  init(owner: AppUpdater) {
    self.owner = owner
  }

  /// Answers the pending question, once.
  func choose(_ choice: SPUUserUpdateChoice) {
    guard let reply = pendingChoice else { return }
    pendingChoice = nil
    reply(choice)
  }

  private func show(_ status: UpdateStatus) {
    clearTask?.cancel()
    owner.status = status
    switch status {
    case .upToDate, .failed:
      clearTask = Task { [weak self] in
        try? await Task.sleep(for: .seconds(status == .upToDate ? 3 : 6))
        guard !Task.isCancelled, let self, self.owner.status == status else { return }
        self.owner.status = .idle
      }
    default:
      break
    }
  }

  // MARK: Checking

  /// Automatic checks are on by default (`SUEnableAutomaticChecks`), so this
  /// isn't normally asked; answer it the same way if it is.
  func show(_ request: SPUUpdatePermissionRequest, reply: @escaping (SUUpdatePermissionResponse) -> Void) {
    reply(SUUpdatePermissionResponse(automaticUpdateChecks: true, sendSystemProfile: false))
  }

  func showUserInitiatedUpdateCheck(cancellation: @escaping () -> Void) {
    show(.checking)
  }

  func showUpdateFound(with appcastItem: SUAppcastItem, state: SPUUserUpdateState, reply: @escaping (SPUUserUpdateChoice) -> Void) {
    // Nothing to download (an informational item): just let it go.
    if appcastItem.isInformationOnlyUpdate {
      reply(.dismiss)
      if state.userInitiated { show(.upToDate) }
      return
    }
    pendingChoice = reply
    version = appcastItem.displayVersionString
    switch state.stage {
    case .notDownloaded:
      show(.available(version: version))
      #if DEBUG
        if UserDefaults.standard.bool(forKey: "QaliAcceptUpdates") { choose(.install) }
      #endif
    case .downloaded, .installing:
      show(.ready(version: version))
      #if DEBUG
        if UserDefaults.standard.bool(forKey: "QaliAcceptUpdates") { choose(.install) }
      #endif
    @unknown default:
      show(.available(version: version))
    }
  }

  func showUpdateReleaseNotes(with downloadData: SPUDownloadData) {}

  func showUpdateReleaseNotesFailedToDownloadWithError(_ error: any Error) {}

  func showUpdateNotFoundWithError(_ error: any Error, acknowledgement: @escaping () -> Void) {
    // Only a check the user asked for reaches here with something to say.
    show(owner.status == .checking ? .upToDate : .idle)
    acknowledgement()
  }

  func showUpdaterError(_ error: any Error, acknowledgement: @escaping () -> Void) {
    pendingChoice = nil
    show(owner.status == .idle ? .idle : .failed(error.localizedDescription))
    acknowledgement()
  }

  // MARK: Downloading and installing

  func showDownloadInitiated(cancellation: @escaping () -> Void) {
    expectedBytes = 0
    receivedBytes = 0
    show(.downloading(progress: nil))
  }

  func showDownloadDidReceiveExpectedContentLength(_ expectedContentLength: UInt64) {
    expectedBytes = expectedContentLength
    receivedBytes = 0
  }

  func showDownloadDidReceiveData(ofLength length: UInt64) {
    receivedBytes += length
    guard expectedBytes > 0 else { return }
    let progress = min(1, Double(receivedBytes) / Double(expectedBytes))
    // Whole percents, so the pill isn't redrawn for every packet.
    if case .downloading(let shown) = owner.status, let shown, Int(shown * 100) == Int(progress * 100) { return }
    show(.downloading(progress: progress))
  }

  func showDownloadDidStartExtractingUpdate() {
    show(.preparing)
  }

  func showExtractionReceivedProgress(_ progress: Double) {}

  func showReady(toInstallAndRelaunch reply: @escaping (SPUUserUpdateChoice) -> Void) {
    pendingChoice = reply
    show(.ready(version: version))
    #if DEBUG
      if UserDefaults.standard.bool(forKey: "QaliAcceptUpdates") { choose(.install) }
    #endif
  }

  func showInstallingUpdate(withApplicationTerminated applicationTerminated: Bool, retryTerminatingApplication: @escaping () -> Void) {
    show(.preparing)
  }

  func showUpdateInstalledAndRelaunched(_ relaunched: Bool, acknowledgement: @escaping () -> Void) {
    show(.idle)
    acknowledgement()
  }

  func showUpdateInFocus() {
    owner.revealApp()
  }

  /// The end of every update session. A brief "up to date" or "failed" pill
  /// stays for its few seconds; anything else goes.
  func dismissUpdateInstallation() {
    pendingChoice = nil
    switch owner.status {
    case .upToDate, .failed: break
    default: show(.idle)
    }
  }
}
