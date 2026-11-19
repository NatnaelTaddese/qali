import Foundation

/// The event windows loaded so far, so that coming back to a range (or
/// jumping somewhere the live window doesn't cover yet) draws what was there
/// at once instead of an empty grid that fills in a moment later. The live
/// subscription still answers for the window on screen and replaces what
/// the cache showed as soon as it arrives.
///
/// Kept in memory for the session and written to the app's Caches folder,
/// so a relaunch opens on the events it last saw. Cleared on sign-out.
///
/// It also keeps the calendar list, which the events take their colours
/// from: without it, cached events would draw in fallback hues until the
/// live list arrived.
nonisolated final class EventCache {
  private struct Window: Codable {
    var startMs: Double
    var endMs: Double
    var events: [CalendarEvent]
    /// When the window last loaded: a later load of an overlapping window
    /// wins for an event both hold.
    var loadedAt: Double
  }

  /// About two years of week windows; older ones are dropped first.
  private static let capacity = 40

  private var windows: [Window] = []
  private var saveTask: Task<Void, Never>?
  /// The calendar list last loaded.
  private(set) var calendars: [CalendarListItem]?

  init() {
    windows = Self.readDisk()
    if let url = Self.calendarsURL, let data = try? Data(contentsOf: url) {
      calendars = try? JSONDecoder().decode([CalendarListItem].self, from: data)
    }
  }

  /// Stores the live calendar list.
  func record(calendars next: [CalendarListItem]) {
    guard next != calendars else { return }
    calendars = next
    Task.detached(priority: .utility) {
      guard let url = Self.calendarsURL, let data = try? JSONEncoder().encode(next) else { return }
      try? data.write(to: url, options: .atomic)
    }
  }

  /// Stores the live result for `[startMs, endMs)`.
  func record(_ events: [CalendarEvent], startMs: Double, endMs: Double) {
    // A sync re-reports every subscription in bursts, mostly unchanged.
    if let last = windows.last, last.startMs == startMs, last.endMs == endMs, last.events == events { return }
    windows.removeAll { $0.startMs == startMs && $0.endMs == endMs }
    windows.append(Window(startMs: startMs, endMs: endMs, events: events, loadedAt: Date.now.timeIntervalSince1970))
    if windows.count > Self.capacity { windows.removeFirst(windows.count - Self.capacity) }
    scheduleSave()
  }

  /// What the cache knows of `[startMs, endMs)`, start-ordered; nil when no
  /// stored window overlaps it.
  func events(startMs: Double, endMs: Double) -> [CalendarEvent]? {
    let overlapping = windows
      .filter { $0.startMs < endMs && $0.endMs > startMs }
      .sorted { $0.loadedAt < $1.loadedAt }
    guard !overlapping.isEmpty else { return nil }
    var byId: [String: CalendarEvent] = [:]
    for window in overlapping {
      // An event gone from a newer window that covers its old time was
      // deleted or moved: forget the older copy.
      let present = Set(window.events.map(\.id))
      for (id, event) in byId where window.startMs <= event.startMs && event.startMs < window.endMs {
        if !present.contains(id) { byId[id] = nil }
      }
      for event in window.events { byId[event.id] = event }
    }
    return byId.values
      .filter { $0.startMs < endMs && $0.endMs > startMs }
      .sorted { ($0.startMs, $0.endMs, $0.id) < ($1.startMs, $1.endMs, $1.id) }
  }

  // MARK: Disk

  /// Files are named for the deployment they came from, so rows cached from
  /// one backend never show while signed in to another.
  private static func cacheURL(_ name: String) -> URL? {
    let deployment = Bundle.main.object(forInfoDictionaryKey: "QaliConvexDeployment") as? String ?? "unknown"
    return FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first?
      .appendingPathComponent("\(name)-\(deployment).json")
  }

  private static var fileURL: URL? { cacheURL("event-windows") }

  private static var calendarsURL: URL? { cacheURL("calendars") }

  private static func readDisk() -> [Window] {
    guard let url = fileURL, let data = try? Data(contentsOf: url) else { return [] }
    return (try? JSONDecoder().decode([Window].self, from: data)) ?? []
  }

  /// Writes a second after the last change, off the main thread, so a burst
  /// of sync updates is one write.
  private func scheduleSave() {
    saveTask?.cancel()
    let snapshot = windows
    saveTask = Task.detached(priority: .utility) {
      try? await Task.sleep(for: .seconds(1))
      guard !Task.isCancelled, let url = Self.fileURL,
        let data = try? JSONEncoder().encode(snapshot)
      else { return }
      try? data.write(to: url, options: .atomic)
    }
  }

  /// Forgets everything, on disk too (sign-out: the next account must not
  /// see this one's events).
  static func clear() {
    for url in [fileURL, calendarsURL].compactMap(\.self) { try? FileManager.default.removeItem(at: url) }
  }
}
