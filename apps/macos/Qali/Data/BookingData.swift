import ConvexMobile
import Foundation
import Observation
import QaliDomain

/// The booking domain's functions (packages/backend/convex/domains/booking).
extension ConvexAPI {
  static let getMyBookingPage = "domains/booking/queries:getMyBookingPage"
  static let bookingPageDefaults = "domains/booking/queries:bookingPageDefaults"
  static let checkSlugAvailable = "domains/booking/queries:checkSlugAvailable"
  static let listMyOverrides = "domains/booking/queries:listMyOverrides"
  static let listMyBookings = "domains/booking/queries:listMyBookings"
  static let listPendingBookings = "domains/booking/queries:listPendingBookings"
  static let upsertBookingPage = "domains/booking/mutations:upsertBookingPage"
  static let setOverride = "domains/booking/mutations:setOverride"
  static let rejectBooking = "domains/booking/mutations:rejectBooking"
  static let acceptBooking = "domains/booking/service:acceptBooking"
}

// MARK: - Models

/// Minutes from a day's midnight, `[startMin, endMin)`, in the page's zone.
nonisolated struct DayInterval: Codable, Hashable, Sendable {
  var startMin: Double
  var endMin: Double
}

/// One weekly opening: `weekday` is 0 (Sunday) through 6.
nonisolated struct WeeklyRule: Codable, Hashable, Sendable {
  var weekday: Double
  var startMin: Double
  var endMin: Double
}

/// The host's booking page (`bookingPages`), every field they can edit.
nonisolated struct BookingPage: Decodable, Hashable, Sendable {
  var id: String
  var slug: String
  var displayName: String
  /// The IANA zone the weekly rules and date overrides are written in.
  var timeZone: String
  var title: String?
  var description: String?
  var slotMinutes: Double
  var bufferMinutes: Double
  var minNoticeMinutes: Double
  var horizonDays: Double
  var rules: [WeeklyRule]
  /// False keeps the row and its slug while the page reads as missing.
  var enabled: Bool

  enum CodingKeys: String, CodingKey {
    case id = "_id"
    case slug, displayName, timeZone, title, description, slotMinutes, bufferMinutes
    case minNoticeMinutes, horizonDays, rules, enabled
  }
}

/// What a first-time host starts from (`bookingPageDefaults`).
nonisolated struct BookingDefaults: Decodable, Hashable, Sendable {
  var slotMinutes: Double
  var bufferMinutes: Double
  var minNoticeMinutes: Double
  var horizonDays: Double
  var rules: [WeeklyRule]
  var suggestedSlug: String
}

/// A single date's replacement for the weekly hours; empty blocks the day.
nonisolated struct AvailabilityOverride: Decodable, Hashable, Sendable, Identifiable {
  var id: String
  /// "yyyy-MM-dd" as the date reads in the page's zone.
  var dateKey: String
  var intervals: [DayInterval]

  enum CodingKeys: String, CodingKey {
    case id = "_id"
    case dateKey, intervals
  }
}

/// One appointment request made through the public page (`bookings`).
nonisolated struct Booking: Decodable, Hashable, Sendable, Identifiable {
  var id: String
  var startMs: Double
  var endMs: Double
  /// The requester's zone, display only.
  var timeZone: String
  var requesterName: String
  var requesterEmail: String
  /// Written by the visitor and not verified.
  var note: String?
  /// "pending" | "accepted" | "rejected" | "expired".
  var status: String
  var createdAt: Double

  enum CodingKeys: String, CodingKey {
    case id = "_id"
    case startMs, endMs, timeZone, requesterName, requesterEmail, note, status, createdAt
  }

  var isPending: Bool { status == "pending" }
}

nonisolated struct SlugCheck: Decodable, Hashable, Sendable {
  var available: Bool
  var reason: String?
}

private nonisolated struct SavedSlug: Decodable, Sendable {
  var slug: String
}

private nonisolated struct BookingIgnored: Decodable {
  init(from decoder: Decoder) throws {}
}

// MARK: - Store

/// The host's side of scheduling: their booking page, its date overrides,
/// and the requests waiting on them (the web's availability panel, its
/// edit context and the dock's pending list). Owned by `CalendarData`.
@Observable
final class BookingData {
  @ObservationIgnored let client: ConvexClient
  private let pageQuery: LiveQuery<BookingPage?>
  private let defaultsQuery: LiveQuery<BookingDefaults>
  private let pendingQuery: LiveQuery<[Booking]>
  private let overridesQuery: LiveQuery<[AvailabilityOverride]>
  private let slugQuery: LiveQuery<SlugCheck>

  /// Override writes not yet confirmed, by date key; a nil value is a reset
  /// back to the weekly hours. Drawn at once so a painted span never waits
  /// for the round trip.
  private var optimistic: [String: [DayInterval]?] = [:]
  /// Date keys with a write in flight, drawn as still saving.
  private(set) var savingDays: Set<String> = []

  /// True while the calendar is in availability-painting mode.
  private(set) var isPainting = false
  /// Bumped when a request's slot ends, so expired requests leave the grid
  /// and the badge without waiting for the server's sweep.
  private(set) var clock = Date.now
  @ObservationIgnored private var clockTask: Task<Void, Never>?

  init(client: ConvexClient) {
    self.client = client
    pageQuery = LiveQuery(client, ConvexAPI.getMyBookingPage)
    defaultsQuery = LiveQuery(client, ConvexAPI.bookingPageDefaults, args: nil)
    pendingQuery = LiveQuery(client, ConvexAPI.listPendingBookings)
    overridesQuery = LiveQuery(client, ConvexAPI.listMyOverrides)
    slugQuery = LiveQuery(client, ConvexAPI.checkSlugAvailable, args: nil)
    // The defaults only matter until a page exists.
    pageQuery.onChange = { [weak self] in
      guard let self, case .some(.none) = self.pageQuery.value else { return }
      self.defaultsQuery.setArgs([:])
    }
    pendingQuery.onChange = { [weak self] in self?.scheduleClock() }
  }

  deinit { clockTask?.cancel() }

  /// Nil while loading; `.some(nil)` when the host has never saved a page.
  var page: BookingPage?? {
    #if DEBUG
      if let fixture = BookingFixture.shared { return .some(fixture.page) }
    #endif
    return pageQuery.value
  }

  var defaults: BookingDefaults? { defaultsQuery.value }

  /// Requests still waiting, soonest first, whose slot has not ended.
  var pending: [Booking] {
    let now = clock.ms
    return pendingRows.filter { $0.endMs > now }
  }

  private var pendingRows: [Booking] {
    #if DEBUG
      if let fixture = BookingFixture.shared { return fixture.pending.filter { !decided.contains($0.id) } }
    #endif
    return pendingQuery.value ?? []
  }

  /// Fixture requests decided this run, so they leave the list as real ones do.
  private var decided: Set<String> = []

  var pendingLoaded: Bool { pendingQuery.value != nil || isFixture }

  /// True for the debug fixture, whose writes stay local.
  var isFixtureData: Bool { isFixture }

  private var isFixture: Bool {
    #if DEBUG
      BookingFixture.shared != nil
    #else
      false
    #endif
  }

  /// A request in flight, so its buttons can show which way it is going.
  struct Decision: Equatable {
    var bookingId: String
    var accept: Bool
  }

  private(set) var deciding: Decision?

  /// Confirms or declines a request and says how it went in the island.
  /// Returns whether it went through.
  @discardableResult
  func decide(_ booking: Booking, accept: Bool) async -> Bool {
    guard deciding == nil else { return false }
    deciding = Decision(bookingId: booking.id, accept: accept)
    defer { deciding = nil }
    do {
      if isFixture {
        try await Task.sleep(for: .milliseconds(600))
        decided.insert(booking.id)
      } else if accept {
        try await self.accept(booking)
      } else {
        try await reject(booking)
      }
      announce?(accept
        ? "Confirmed with \(booking.requesterName). Google is sending them the invitation."
        : "Declined \(booking.requesterName).")
      return true
    } catch {
      announce?("\(accept ? "Couldn't confirm this request." : "Couldn't decline this request.") \(bookingErrorMessage(error))")
      return false
    }
  }

  /// Wakes when the next pending slot ends, so it drops off on time.
  private func scheduleClock() {
    clockTask?.cancel()
    let now = Date.now.ms
    guard let next = (pendingQuery.value ?? []).map(\.endMs).filter({ $0 > now }).min() else { return }
    clockTask = Task { [weak self] in
      try? await Task.sleep(for: .milliseconds(Int(next - now) + 500))
      guard !Task.isCancelled, let self else { return }
      self.clock = .now
      self.scheduleClock()
    }
  }

  // MARK: Link

  /// The public address a slug is shared at.
  static func publicURL(slug: String) -> URL {
    AppConfig.webAppURL.appending(path: slug)
  }

  /// "calendar.myqali.com/" — the prefix the slug field sits after.
  static var publicPrefix: String {
    (AppConfig.webAppURL.host() ?? "") + "/"
  }

  /// The availability of `slug` for the caller, or nil while it loads.
  /// Pass nil to stop checking.
  func checkSlug(_ slug: String?) {
    slugQuery.setArgs(slug.map { ["slug": $0] })
  }

  var slugCheck: SlugCheck? { slugQuery.isLoading ? nil : slugQuery.value }

  // MARK: Saving the page

  /// Saves the whole page (`upsertBookingPage`). The weekly hours are
  /// written in `zone`, the working zone, like the web's panel.
  func savePage(_ draft: BookingPageDraft, zone: WorkingZone) async throws {
    if isFixture { return }
    let zoneId = zone.identifier
    let title = draft.title.trimmingCharacters(in: .whitespacesAndNewlines)
    let rules = draft.rules
    let slug = normalizeSlug(draft.slug)
    let slot = Double(draft.slotMinutes)
    let notice = Double(max(0, draft.noticeHours) * 60)
    let horizon = Double(draft.horizonDays)
    let enabled = draft.enabled
    let _: SavedSlug = try await Self.mutate(client, ConvexAPI.upsertBookingPage) {
        var args: [String: ConvexEncodable?] = [
          "slug": slug,
          "timeZone": zoneId,
          "rules": rules.map { rule -> ConvexEncodable? in
            ["weekday": rule.weekday, "startMin": rule.startMin, "endMin": rule.endMin] as [String: ConvexEncodable?]
          },
          "slotMinutes": slot,
          "bufferMinutes": 0.0,
          "minNoticeMinutes": notice,
          "horizonDays": horizon,
          "enabled": enabled,
        ]
        if !title.isEmpty { args["title"] = title }
        return args
    }
  }

  /// A Live switch flipped and not yet confirmed, drawn at once.
  private(set) var pendingLive: Bool?

  /// Whether the saved page is taking requests, with an unconfirmed flip
  /// on top; nil without a page.
  var isLive: Bool? {
    guard case .some(.some(let page)) = page else { return nil }
    return pendingLive ?? page.enabled
  }

  /// Turns the page on or off from the island. Everything else goes back
  /// exactly as saved, in the page's own zone and with all of its spans,
  /// so the switch never re-bases or trims the hours.
  func setLive(_ live: Bool) {
    guard case .some(.some(let page)) = page, pendingLive == nil || isFixture else { return }
    pendingLive = live
    if isFixture { return }
    Task {
      do {
        let _: SavedSlug = try await Self.mutate(client, ConvexAPI.upsertBookingPage) {
          var args: [String: ConvexEncodable?] = [
            "slug": page.slug,
            "timeZone": page.timeZone,
            "rules": page.rules.map { rule -> ConvexEncodable? in
              ["weekday": rule.weekday, "startMin": rule.startMin, "endMin": rule.endMin] as [String: ConvexEncodable?]
            },
            "slotMinutes": page.slotMinutes,
            "bufferMinutes": page.bufferMinutes,
            "minNoticeMinutes": page.minNoticeMinutes,
            "horizonDays": page.horizonDays,
            "enabled": live,
          ]
          if let title = page.title { args["title"] = title }
          if let description = page.description { args["description"] = description }
          return args
        }
        announce?(live ? "Your booking link is live." : "Your booking link is paused.")
      } catch {
        announce?("Couldn't \(live ? "turn on" : "pause") your booking link. \(bookingErrorMessage(error))")
      }
      pendingLive = nil
    }
  }

  // MARK: Requests

  /// Confirms a request: the server writes the event to the host's calendar
  /// with the requester as a guest, and the provider emails them.
  func accept(_ booking: Booking) async throws {
    let id = booking.id
    let _: BookingIgnored = try await Self.act(client, ConvexAPI.acceptBooking) { ["bookingId": id] }
  }

  /// Declines a request. Nothing reaches the provider; the requester sees it
  /// on their own confirmation link.
  func reject(_ booking: Booking) async throws {
    let id = booking.id
    let _: BookingIgnored = try await Self.mutate(client, ConvexAPI.rejectBooking) { ["bookingId": id] }
  }

  // MARK: Painting specific dates

  func startPainting() {
    isPainting = true
  }

  /// Painting from the island, where there is no draft: a page saved in
  /// another zone is first re-saved as it is in the working zone, which is
  /// what the web's panel does on its way into painting.
  func beginPainting(zone: WorkingZone) async {
    guard case .some(.some(let page)) = page else { return }
    if page.timeZone != zone.identifier {
      do {
        try await savePage(BookingPageDraft(page: page, defaults: nil), zone: zone)
      } catch {
        announce?("Couldn't move your hours to this time zone. \(bookingErrorMessage(error))")
        return
      }
    }
    startPainting()
  }

  func stopPainting() {
    isPainting = false
  }

  /// The saved overrides with any unconfirmed writes on top, by date key.
  var overrides: [String: [DayInterval]] {
    var map: [String: [DayInterval]] = [:]
    for row in overrideRows { map[row.dateKey] = row.intervals }
    for (key, value) in optimistic {
      if let value { map[key] = value } else { map.removeValue(forKey: key) }
    }
    return map
  }

  private var overrideRows: [AvailabilityOverride] {
    #if DEBUG
      if let fixture = BookingFixture.shared { return fixture.overrides }
    #endif
    return overridesQuery.value ?? []
  }

  /// Painting needs a saved page in the working zone (the grid's date keys
  /// and minutes are cut in it) and the overrides to build on.
  func paintingReady(zone: WorkingZone) -> Bool {
    guard case .some(.some(let page)) = page, overridesQuery.value != nil || isFixture else { return false }
    return page.timeZone == zone.identifier
  }

  /// "yyyy-MM-dd" for a grid day, as the page's zone reads it.
  static func dateKey(_ day: Date, zone: WorkingZone) -> String {
    zone.format(day, "yyyy-MM-dd")
  }

  /// A day's availability: its override when it has one, else the weekly
  /// hours for its weekday.
  func availability(on day: Date, zone: WorkingZone) -> (intervals: [DayInterval], isOverride: Bool) {
    let key = Self.dateKey(day, zone: zone)
    if let override = overrides[key] { return (override, true) }
    guard case .some(.some(let page)) = page else { return ([], false) }
    let weekday = Double(zone.calendar.component(.weekday, from: day) - 1)
    let weekly = page.rules
      .filter { $0.weekday == weekday }
      .map { DayInterval(startMin: $0.startMin, endMin: $0.endMin) }
      .sorted { $0.startMin < $1.startMin }
    return (weekly, false)
  }

  /// Paints a span onto a day; overlapping and touching spans merge.
  func addInterval(on day: Date, startMs: Double, endMs: Double, zone: WorkingZone) {
    let dayStart = zone.startOfDay(day).ms
    let start = ((startMs - dayStart) / 60_000).rounded()
    let end = ((endMs - dayStart) / 60_000).rounded()
    guard end > start else { return }
    let next = mergeDayIntervals(availability(on: day, zone: zone).intervals + [DayInterval(startMin: start, endMin: end)])
    commit(Self.dateKey(day, zone: zone), next)
  }

  /// Removes one span; an empty day stays blocked as an override.
  func removeInterval(at index: Int, on day: Date, zone: WorkingZone) {
    var intervals = availability(on: day, zone: zone).intervals
    guard intervals.indices.contains(index) else { return }
    intervals.remove(at: index)
    commit(Self.dateKey(day, zone: zone), intervals)
  }

  /// Hands a day back to the weekly hours.
  func resetDay(_ day: Date, zone: WorkingZone) {
    commit(Self.dateKey(day, zone: zone), nil)
  }

  /// Removes the override for a date key (the Settings list).
  func resetDate(key: String) {
    commit(key, nil)
  }

  /// Saved overrides from today on, soonest first, for the Settings list.
  func upcomingOverrides(zone: WorkingZone) -> [(key: String, intervals: [DayInterval])] {
    let today = Self.dateKey(.now, zone: zone)
    return overrides
      .filter { $0.key >= today }
      .sorted { $0.key < $1.key }
      .map { ($0.key, $0.value) }
  }

  private nonisolated static func mutate<T: Decodable>(
    _ client: ConvexClient,
    _ name: String,
    _ args: @Sendable () -> [String: ConvexEncodable?]
  ) async throws -> T {
    try await client.mutation(name, with: args())
  }

  private nonisolated static func act<T: Decodable>(
    _ client: ConvexClient,
    _ name: String,
    _ args: @Sendable () -> [String: ConvexEncodable?]
  ) async throws -> T {
    try await client.action(name, with: args())
  }

  /// Set by the calendar data so failures surface in the island.
  @ObservationIgnored var announce: ((String) -> Void)?

  private func commit(_ key: String, _ intervals: [DayInterval]?) {
    optimistic[key] = .some(intervals)
    // A fixture keeps its painting locally, as though it had saved.
    if isFixture { return }
    savingDays.insert(key)
    Task {
      do {
        let _: BookingIgnored = try await Self.mutate(client, ConvexAPI.setOverride) {
            var args: [String: ConvexEncodable?] = ["dateKey": key]
            if let intervals {
              args["intervals"] = intervals.map { interval -> ConvexEncodable? in
                ["startMin": interval.startMin, "endMin": interval.endMin] as [String: ConvexEncodable?]
              }
            }
            return args
        }
      } catch {
        announce?("Couldn't save availability. \(bookingErrorMessage(error))")
      }
      // A later write to the same day owns the optimistic value now.
      if optimistic[key] == .some(intervals) { optimistic.removeValue(forKey: key) }
      savingDays.remove(key)
    }
  }
}

// MARK: - Fixture

#if DEBUG
  /// `-QaliBookingFixture YES` stands a live booking page, three pending
  /// requests over the next few days and a painted date in for the server's, for
  /// captures on a deployment without a page (the local dev one has none).
  /// Decisions and painting stay local; Save does nothing.
  nonisolated struct BookingFixture: Sendable {
    var page: BookingPage
    var pending: [Booking]
    var overrides: [AvailabilityOverride]

    static let shared: BookingFixture? = {
      guard UserDefaults.standard.bool(forKey: "QaliBookingFixture") else { return nil }
      var local = Calendar(identifier: .gregorian)
      local.firstWeekday = 2
      // Days from today, so the requests are always still to come.
      let monday = local.startOfDay(for: .now)
      func at(_ day: Int, _ hour: Double) -> Double {
        local.date(byAdding: .day, value: day, to: monday)!.timeIntervalSince1970 * 1000 + hour * 3_600_000
      }
      func request(_ id: String, _ name: String, _ email: String, day: Int, _ hour: Double, zone: String, note: String?, ago: Double) -> Booking {
        Booking(
          id: id, startMs: at(day, hour), endMs: at(day, hour + 0.5), timeZone: zone,
          requesterName: name, requesterEmail: email, note: note, status: "pending",
          createdAt: Date.now.ms - ago * 3_600_000)
      }
      let key = { (day: Int) in
        let date = local.date(byAdding: .day, value: day, to: monday)!
        let parts = local.dateComponents([.year, .month, .day], from: date)
        return String(format: "%04d-%02d-%02d", parts.year!, parts.month!, parts.day!)
      }
      return BookingFixture(
        page: BookingPage(
          id: "page", slug: "nat", displayName: "Nat", timeZone: TimeZone.current.identifier,
          title: "Intro call", description: nil, slotMinutes: 30, bufferMinutes: 0, minNoticeMinutes: 120,
          horizonDays: 60,
          rules: [1, 2, 3, 4, 5].map { WeeklyRule(weekday: Double($0), startMin: 540, endMin: 1020) },
          enabled: true),
        pending: [
          request(
            "b1", "Maya Okafor", "maya@example.com", day: 1, 11, zone: "Europe/London",
            note: "Hi! I'd love to talk about the design system work and how your team handles calendar sync across accounts. I have a few questions about the API too.",
            ago: 3),
          request("b2", "Jonas Berg", "jonas.berg@example.com", day: 3, 16.5, zone: "Europe/Berlin", note: nil, ago: 20),
          request("b3", "Priya Raman", "priya@example.com", day: 4, 10, zone: "Asia/Kolkata", note: "Quick sync about the launch.", ago: 30),
        ],
        overrides: [
          AvailabilityOverride(id: "o1", dateKey: key(5), intervals: [DayInterval(startMin: 600, endMin: 720), DayInterval(startMin: 840, endMin: 960)])
        ])
    }()
  }
#endif

// MARK: - Draft

/// The Settings pane's editable copy of the page. Saved as a whole by an
/// explicit Save: half-entered hours must never go live on a public page.
nonisolated struct BookingPageDraft: Equatable, Sendable {
  struct Day: Equatable, Sendable {
    var enabled: Bool
    var startMin: Double
    var endMin: Double
  }

  var slug: String
  var title: String
  /// By weekday, 0 (Sunday) through 6.
  var days: [Day]
  var slotMinutes: Int
  var noticeHours: Int
  var horizonDays: Int
  var enabled: Bool

  /// Weekdays in the grid's Monday-first order.
  static let weekdayOrder = [1, 2, 3, 4, 5, 6, 0]
  static let slotChoices = [15, 30, 45, 60]

  init(page: BookingPage?, defaults: BookingDefaults?) {
    let rules = page?.rules ?? defaults?.rules ?? []
    slug = page?.slug ?? defaults?.suggestedSlug ?? ""
    title = page?.title ?? ""
    // The panel edits one span per day, which is also the shape it writes.
    days = (0..<7).map { weekday in
      if let rule = rules.first(where: { Int($0.weekday) == weekday }) {
        Day(enabled: true, startMin: rule.startMin, endMin: rule.endMin)
      } else {
        Day(enabled: false, startMin: 9 * 60, endMin: 17 * 60)
      }
    }
    slotMinutes = Int(page?.slotMinutes ?? defaults?.slotMinutes ?? 30)
    noticeHours = Int(((page?.minNoticeMinutes ?? defaults?.minNoticeMinutes ?? 120) / 60).rounded())
    horizonDays = Int(page?.horizonDays ?? defaults?.horizonDays ?? 60)
    enabled = page?.enabled ?? false
  }

  /// The open days, in display order, that end after they start.
  var rules: [WeeklyRule] {
    Self.weekdayOrder.compactMap { weekday in
      let day = days[weekday]
      guard day.enabled, day.endMin > day.startMin else { return nil }
      return WeeklyRule(weekday: Double(weekday), startMin: day.startMin, endMin: day.endMin)
    }
  }

  /// Copies one day's hours onto every other open day.
  mutating func copyHoursToOpenDays(from weekday: Int) {
    let source = days[weekday]
    for index in days.indices where index != weekday && days[index].enabled {
      days[index].startMin = source.startMin
      days[index].endMin = source.endMin
    }
  }
}

// MARK: - Helpers

/// The web's `normalizeSlug` (packages/domain/src/slug.ts): lowercased,
/// spaces and underscores folded to hyphens, anything else dropped, runs of
/// hyphens collapsed, 30 at most. Always follow with `slugError`.
func normalizeSlug(_ raw: String) -> String {
  let lowered = raw.lowercased().trimmingCharacters(in: .whitespacesAndNewlines)
  let folded = lowered.replacingOccurrences(of: "[\\s_]+", with: "-", options: .regularExpression)
  let kept = folded.replacingOccurrences(of: "[^a-z0-9-]", with: "", options: .regularExpression)
  let collapsed = kept.replacingOccurrences(of: "-{2,}", with: "-", options: .regularExpression)
  return String(collapsed.prefix(30))
}

private let reservedSlugs: Set<String> = [
  "about", "admin", "api", "app", "assets", "auth", "billing", "book", "booking", "bookings",
  "calendar", "contact", "dashboard", "docs", "help", "home", "login", "logout", "new", "pricing",
  "privacy", "public", "qali", "root", "settings", "signin", "signup", "static", "support", "terms",
  "user", "users",
]

/// The web's `slugError`: why a normalized slug can't be used, in the same
/// words the server rejects it with, or nil when it is fine.
func slugError(_ slug: String) -> String? {
  if slug.count < 3 { return "Use at least 3 characters" }
  if slug.count > 30 { return "Use at most 30 characters" }
  if slug.range(of: "^[a-z0-9-]+$", options: .regularExpression) == nil {
    return "Use lowercase letters, numbers and hyphens only"
  }
  if slug.hasPrefix("-") || slug.hasSuffix("-") { return "Can't start or end with a hyphen" }
  if reservedSlugs.contains(slug) { return "That name is reserved" }
  return nil
}

/// Merges overlapping and touching spans, sorted by start.
func mergeDayIntervals(_ intervals: [DayInterval]) -> [DayInterval] {
  var merged: [DayInterval] = []
  for interval in intervals.sorted(by: { $0.startMin < $1.startMin }) where interval.endMin > interval.startMin {
    if let last = merged.last, interval.startMin <= last.endMin {
      merged[merged.count - 1].endMin = max(last.endMin, interval.endMin)
    } else {
      merged.append(interval)
    }
  }
  return merged
}

/// The message a booking write failed with, in the server's words where it
/// gave some ("That link is already taken"), else a generic line.
func bookingErrorMessage(_ error: Error) -> String {
  switch error {
  case ClientError.ConvexError(let data):
    return data.trimmingCharacters(in: CharacterSet(charactersIn: "\""))
  case ClientError.ServerError(let message):
    // "[Request ID: …] Server Error\nUncaught Error: <message>\n    at …"
    if let range = message.range(of: "Uncaught Error: ") {
      let rest = message[range.upperBound...]
      let line = rest.split(separator: "\n", maxSplits: 1).first.map(String.init) ?? String(rest)
      return line.trimmingCharacters(in: .whitespaces)
    }
    return "Something went wrong on the server."
  default:
    return "Check your connection and try again."
  }
}
