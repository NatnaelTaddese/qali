import AppKit
import QaliDomain
import SwiftUI

/// The booking link's settings (the web's availability panel): the link it
/// lives at, the weekly hours it offers and how they are cut into slots.
///
/// Everything is one local draft saved by an explicit Save, as on the web:
/// half-entered hours would otherwise be live on a public page.
struct BookingPane: View {
  let data: CalendarData
  @Environment(AppModel.self) private var model

  /// What the form shows and edits.
  @State private var draft: BookingPageDraft?
  /// The saved page as a draft, to tell whether anything has changed.
  @State private var baseline: BookingPageDraft?
  @State private var saving = false
  @State private var error: String?
  @State private var copied = false

  private var booking: BookingData { data.booking }
  private var zone: WorkingZone { data.preferences?.zone ?? .resolve(preference: nil) }
  private var use24h: Bool { data.preferences?.use24h ?? false }

  /// The saved page, or nil while loading or before the first save.
  private var page: BookingPage? { booking.page ?? nil }
  /// True once both the page and (for a first save) the defaults are in.
  private var loaded: Bool {
    switch booking.page {
    case .none: false
    case .some(.some): true
    case .some(.none): booking.defaults != nil
    }
  }

  var body: some View {
    Group {
      if let draft, loaded {
        form(draft)
      } else {
        ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
      }
    }
    .saveErrors($error)
    .onChange(of: loaded ? Fresh(page: page, defaults: booking.defaults) : nil, initial: true) { _, fresh in
      guard let fresh else { return }
      let next = BookingPageDraft(page: fresh.page, defaults: fresh.defaults)
      // Adopt a newer saved page only while the form is untouched.
      if draft == nil || draft == baseline { draft = next }
      baseline = next
    }
    .onChange(of: slugToCheck, initial: true) { _, slug in booking.checkSlug(slug) }
    .onDisappear { booking.checkSlug(nil) }
  }

  private struct Fresh: Equatable {
    var page: BookingPage?
    var defaults: BookingDefaults?
  }

  private var binding: Binding<BookingPageDraft> {
    Binding(get: { draft ?? BookingPageDraft(page: nil, defaults: nil) }, set: { draft = $0 })
  }

  // MARK: Validation

  private var normalized: String { normalizeSlug(draft?.slug ?? "") }
  private var slugUnchanged: Bool { page.map { $0.slug == normalized } ?? false }

  /// The slug the server is asked about: only a new, well-formed one.
  private var slugToCheck: String? {
    guard draft != nil, slugError(normalized) == nil, !slugUnchanged else { return nil }
    return normalized
  }

  private var slugReady: Bool {
    slugError(normalized) == nil && (slugUnchanged || booking.slugCheck?.available == true)
  }

  /// Why Save can't run, in the host's terms (the web's
  /// `bookingSaveBlockedReason`), or nil when nothing blocks it.
  private var blockedReason: String? {
    guard let draft, !saving else { return nil }
    if draft.rules.isEmpty { return "Open at least one day" }
    if let problem = slugError(normalized) { return problem }
    if slugUnchanged { return nil }
    guard let check = booking.slugCheck else { return "Checking that link name…" }
    return check.available ? nil : (check.reason ?? "That link name is taken")
  }

  private var canSave: Bool { draft != nil && !saving && blockedReason == nil }
  private var dirty: Bool { draft != baseline || page == nil }
  /// Saving re-bases the hours into the working zone; say so first.
  private var zoneChanged: Bool { page.map { $0.timeZone != zone.identifier } ?? false }

  // MARK: Form

  @ViewBuilder private func form(_ draft: BookingPageDraft) -> some View {
    Form {
      Section {
        Toggle(isOn: binding.enabled) {
          Text(draft.enabled ? "Live" : "Paused")
          Text(draft.enabled ? "People can request a time" : "Hidden, not taking requests")
        }

        TextField(text: binding.slug, prompt: Text("your-name")) {
          Text("Link name")
          Text(BookingData.publicPrefix + (normalized.isEmpty ? "your-name" : normalized))
        }
        .autocorrectionDisabled()

        if let problem = slugProblem {
          Label(problem, systemImage: "exclamationmark.circle")
            .foregroundStyle(.red)
            .font(.callout)
        }

        LabeledContent {
          HStack {
            Button(copied ? "Copied" : "Copy Link", systemImage: copied ? "checkmark" : "doc.on.doc", action: copyLink)
            ShareLink(
              "Share…",
              item: BookingData.publicURL(slug: normalized),
              subject: Text(draft.title.isEmpty ? "Book a time with me" : draft.title),
              message: Text("Pick a time that works for you:")
            )
            // Only the saved link: an unsaved name isn't live yet.
            .disabled(page == nil || !slugUnchanged)
          }
          .disabled(!slugReady)
        } label: {
          Text("Share")
          Text("Anyone with the link can request a time")
        }
      }

      Section("Meeting") {
        TextField(text: binding.title, prompt: Text("What the meeting is called")) {
          Text("Title")
        }

        Picker(selection: binding.slotMinutes) {
          ForEach(BookingPageDraft.slotChoices, id: \.self) { minutes in
            Text("\(minutes) min").tag(minutes)
          }
          if !BookingPageDraft.slotChoices.contains(draft.slotMinutes) {
            Text("\(draft.slotMinutes) min").tag(draft.slotMinutes)
          }
        } label: {
          Text("Length")
          Text("Each slot people can pick")
        }

        NumberRow(title: "Minimum notice", detail: "How soon before a slot it can still be booked", unit: "hours", value: binding.noticeHours, range: 0...720)
        NumberRow(title: "Days ahead", detail: "How far ahead people can book", unit: "days", value: binding.horizonDays, range: 1...365)
      }

      Section {
        ForEach(BookingPageDraft.weekdayOrder, id: \.self) { weekday in
          WeekdayRow(
            weekday: weekday,
            day: binding.days[weekday],
            use24h: use24h,
            canCopy: draft.days[weekday].enabled && draft.days.filter(\.enabled).count > 1
          ) {
            self.draft?.copyHoursToOpenDays(from: weekday)
          }
        }
      } header: {
        Text("Weekly hours")
      } footer: {
        Text(zoneChanged
          ? "Your working time zone changed. Saving moves these hours and any specific dates to \(zoneLabel) time."
          : "In \(zoneLabel) time, your working time zone.")
          .font(.callout)
          .foregroundStyle(zoneChanged ? AnyShapeStyle(.orange) : AnyShapeStyle(.secondary))
      }

      Section("Specific dates") {
        LabeledContent {
          Button("Paint on Calendar…", action: paint)
            .disabled(page == nil || !canSave)
            .help(page == nil ? "Save your booking link first, then you can change single days" : blockedReason ?? "")
        } label: {
          Text("Change single days")
          Text("Drag on the calendar to set a day's own hours")
        }
        ForEach(booking.upcomingOverrides(zone: zone), id: \.key) { override in
          LabeledContent {
            Button("Use Weekly Hours") { booking.resetDate(key: override.key) }
              .buttonStyle(.link)
          } label: {
            Text(dateLabel(override.key))
            Text(override.intervals.isEmpty ? "Unavailable" : intervalsLabel(override.intervals))
          }
        }
      }

      Section {
        HStack {
          Text(statusLine)
            .foregroundStyle(.secondary)
            .lineLimit(1)
          Spacer()
          Button("Revert") { self.draft = baseline }
            .disabled(!dirty || saving || page == nil)
          Button {
            save()
          } label: {
            HStack(spacing: 6) {
              if saving { ProgressView().controlSize(.small) }
              Text(saving ? "Saving…" : "Save")
            }
          }
          .keyboardShortcut(.defaultAction)
          .disabled(!canSave || !dirty)
          .help(blockedReason ?? "")
        }
      }
    }
    .formStyle(.grouped)
    #if DEBUG
      // `-QaliScrollBottom YES` opens the form at its foot, for captures.
      .defaultScrollAnchor(UserDefaults.standard.bool(forKey: "QaliScrollBottom") ? .bottom : .top)
    #endif
  }

  /// A slug problem worth showing as it is typed: format rules once three
  /// characters are in, and a taken name once the server says so.
  private var slugProblem: String? {
    guard normalized.count >= 3 else { return nil }
    if let problem = slugError(normalized) { return problem }
    if !slugUnchanged, let check = booking.slugCheck, !check.available {
      return check.reason ?? "That link name is taken"
    }
    return nil
  }

  private var statusLine: String {
    if saving { return "" }
    if let reason = blockedReason, dirty { return reason }
    if page == nil { return "Not saved yet" }
    return dirty ? "Unsaved changes" : "All changes saved"
  }

  private var zoneLabel: String { zone.identifier.replacingOccurrences(of: "_", with: " ") }

  // MARK: Actions

  private func copyLink() {
    NSPasteboard.general.clearContents()
    NSPasteboard.general.setString(BookingData.publicURL(slug: normalized).absoluteString, forType: .string)
    copied = true
    Task {
      try? await Task.sleep(for: .seconds(1.5))
      copied = false
    }
  }

  @discardableResult
  private func persist() async -> Bool {
    guard canSave, var next = draft else { return false }
    next.slug = normalized
    next.title = next.title.trimmingCharacters(in: .whitespacesAndNewlines)
    draft = next
    saving = true
    defer { saving = false }
    do {
      try await booking.savePage(next, zone: zone)
      // A later edit made while this saved stays unsaved.
      if draft == next { baseline = next }
      return true
    } catch {
      self.error = "Couldn't save your booking link. \(bookingErrorMessage(error))"
      return false
    }
  }

  private func save() {
    Task { await persist() }
  }

  /// Saves the page in the working zone (the grid authors date keys and
  /// minutes against it), then hands over to the calendar for painting.
  private func paint() {
    Task {
      guard await persist() else { return }
      booking.startPainting()
      model.showCalendar?()
    }
  }

  // MARK: Labels

  private func dateLabel(_ key: String) -> String {
    let parts = key.split(separator: "-").compactMap { Int($0) }
    guard parts.count == 3,
      let date = zone.calendar.date(from: DateComponents(year: parts[0], month: parts[1], day: parts[2]))
    else { return key }
    return zone.format(date, "EEE, MMM d")
  }

  private func intervalsLabel(_ intervals: [DayInterval]) -> String {
    intervals
      .map { "\(formatWallClockMinutes($0.startMin, use24h: use24h)) – \(formatWallClockMinutes($0.endMin, use24h: use24h))" }
      .joined(separator: ", ")
  }
}

/// A whole number with its unit, a field and a stepper (System Settings'
/// numeric rows).
private struct NumberRow: View {
  let title: String
  let detail: String
  let unit: String
  @Binding var value: Int
  let range: ClosedRange<Int>

  var body: some View {
    LabeledContent {
      HStack(spacing: 6) {
        TextField(title, value: clamped, format: .number)
          .labelsHidden()
          .multilineTextAlignment(.trailing)
          .frame(width: 54)
        Text(unit).foregroundStyle(.secondary)
        Stepper(title, value: $value, in: range)
          .labelsHidden()
      }
    } label: {
      Text(title)
      Text(detail)
    }
  }

  private var clamped: Binding<Int> {
    Binding(get: { value }, set: { value = min(max($0, range.lowerBound), range.upperBound) })
  }
}

/// One weekday: open or closed, and its single span of hours.
private struct WeekdayRow: View {
  let weekday: Int
  @Binding var day: BookingPageDraft.Day
  let use24h: Bool
  let canCopy: Bool
  let copyToAll: () -> Void

  @State private var hovering = false

  private static let names = Calendar(identifier: .gregorian).weekdaySymbols

  var body: some View {
    HStack(spacing: 10) {
      Toggle(Self.names[weekday], isOn: $day.enabled)
        .toggleStyle(.switch)
        .controlSize(.mini)
        .labelsHidden()
      Text(Self.names[weekday])
        .foregroundStyle(day.enabled ? .primary : .secondary)
      Spacer(minLength: 8)
      if day.enabled {
        if day.endMin <= day.startMin {
          Image(systemName: "exclamationmark.circle")
            .foregroundStyle(.red)
            .help("Ends before it starts, so this day is left closed")
        }
        TimeOfDayField(minutes: $day.startMin, use24h: use24h, isEnd: false)
        Text("to").foregroundStyle(.secondary)
        TimeOfDayField(minutes: $day.endMin, use24h: use24h, isEnd: true)
        Button("Copy to All Open Days", systemImage: "doc.on.doc", action: copyToAll)
          .labelStyle(.iconOnly)
          .buttonStyle(.borderless)
          .help("Copy these hours to all open days")
          .opacity(canCopy && hovering ? 1 : 0)
          .disabled(!canCopy)
      } else {
        Text("Unavailable").foregroundStyle(.secondary)
      }
    }
    .contentShape(.rect)
    .onHover { hovering = $0 }
    .contextMenu {
      Button("Copy Hours to All Open Days", action: copyToAll).disabled(!canCopy)
    }
  }
}

/// A time of day as minutes from midnight, in a stock hour-and-minute field.
/// An end at midnight reads as the end of the day (24:00), as on the web.
struct TimeOfDayField: View {
  @Binding var minutes: Double
  let use24h: Bool
  let isEnd: Bool

  private static var utc: Calendar {
    var calendar = Calendar(identifier: .gregorian)
    calendar.timeZone = TimeZone(identifier: "UTC")!
    return calendar
  }

  private static let reference = Date(timeIntervalSince1970: 0)

  var body: some View {
    DatePicker(
      "Time",
      selection: Binding(
        get: { Self.reference.addingTimeInterval(minutes.truncatingRemainder(dividingBy: 1440) * 60) },
        set: { date in
          let parts = Self.utc.dateComponents([.hour, .minute], from: date)
          let next = Double((parts.hour ?? 0) * 60 + (parts.minute ?? 0))
          minutes = isEnd && next == 0 ? 1440 : next
        }
      ),
      displayedComponents: .hourAndMinute
    )
    .labelsHidden()
    .datePickerStyle(.field)
    .environment(\.timeZone, TimeZone(identifier: "UTC")!)
    .environment(\.calendar, Self.utc)
    .environment(\.locale, Locale(identifier: use24h ? "en_GB" : "en_US"))
    .fixedSize()
  }
}
