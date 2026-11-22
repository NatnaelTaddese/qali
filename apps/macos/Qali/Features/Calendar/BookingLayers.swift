import QaliDomain
import SwiftUI

/// Pending booking requests on the time grid (the web's `BookingBlock`): full
/// column width, dashed and tinted so they read as provisional next to the
/// solid event cards. Clicking one opens it in the island to confirm or
/// decline.
///
/// Full width is safe: the server only offers slots it has already taken the
/// host's busy time out of, so a request never lands on an existing event.
struct BookingBlocks: View {
  let days: [Date]
  let column: CGFloat
  let dayHeight: CGFloat
  let navigation: CalendarNavigation
  let data: CalendarData

  @Environment(Island.self) private var island

  private struct Piece: Identifiable {
    let id: String
    let dayIndex: Int
    let booking: Booking
    let startMs: Double
    let endMs: Double
    let dayStartMs: Double
  }

  var body: some View {
    ZStack(alignment: .topLeading) {
      ForEach(pieces()) { piece in
        let top = CGFloat((piece.startMs - piece.dayStartMs) / msPerDay) * dayHeight
        let height = max(CGFloat((piece.endMs - piece.startMs) / msPerDay) * dayHeight, 18)
        BookingBlock(
          booking: piece.booking,
          time: timeText(piece.booking),
          height: height
        ) {
          island.open(.bookingRequest(piece.booking))
        }
        .frame(width: max(column - eventLeftGutter - 4, 0), height: height)
        .offset(x: CGFloat(piece.dayIndex) * column + eventLeftGutter + 2, y: top)
      }
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
  }

  private func pieces() -> [Piece] {
    let zone = navigation.zone
    var out: [Piece] = []
    for booking in data.booking.pending {
      for (index, day) in days.enumerated() {
        let dayStart = day.ms
        let dayEnd = zone.addingDays(1, to: day).ms
        let start = max(booking.startMs, dayStart)
        let end = min(booking.endMs, dayEnd)
        guard end > start else { continue }
        out.append(Piece(id: "\(booking.id)#\(index)", dayIndex: index, booking: booking, startMs: start, endMs: end, dayStartMs: dayStart))
      }
    }
    return out
  }

  private func timeText(_ booking: Booking) -> String {
    let zone = navigation.zone
    let start = zone.format(Date(ms: booking.startMs), timePattern(use24h: navigation.use24h, withDayPeriod: false))
    let end = zone.format(Date(ms: booking.endMs), timePattern(use24h: navigation.use24h))
    return "\(start) – \(end)"
  }
}

private struct BookingBlock: View {
  let booking: Booking
  let time: String
  let height: CGFloat
  let open: () -> Void

  @State private var hovering = false

  private let shape = RoundedRectangle(cornerRadius: 6, style: .continuous)

  var body: some View {
    // Below an hour there is room for one line, as on the web.
    let compact = height < 40
    Button(action: open) {
      Group {
        if compact {
          (Text(booking.requesterName).font(.sans(TextSize.xs, .medium))
            + Text("  \(time)").font(.sans(TextSize.xs)).foregroundStyle(Palette.mutedForeground))
            .lineLimit(1)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
        } else {
          VStack(alignment: .leading, spacing: 0) {
            Text(booking.requesterName)
              .font(.sans(TextSize.sm, .medium))
              .lineLimit(1)
            Text("Request · \(time)")
              .font(.sans(TextSize.xs))
              .foregroundStyle(Palette.mutedForeground)
              .lineLimit(1)
          }
          .padding(.vertical, 4)
          .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        }
      }
      .foregroundStyle(Palette.foreground)
      .padding(.horizontal, 8)
      .background { shape.fill(Palette.primary.opacity(hovering ? 0.16 : 0.1)).revealFlash([booking.id], in: shape) }
      .overlay { shape.strokeBorder(Palette.primary.opacity(0.55), style: StrokeStyle(lineWidth: 1, dash: [4, 3])) }
      .clipShape(shape)
      .contentShape(shape)
    }
    .buttonStyle(.plain)
    .onHover { hovering = $0 }
    .help("Booking request from \(booking.requesterName)\n\(time)")
    .accessibilityLabel("Booking request from \(booking.requesterName), \(time)")
  }
}

/// The painted availability on each day while setting specific dates (the
/// web's `AvailabilityBlock`): green, so it reads as open next to the dimmed
/// events. Clicking a span removes it. Days before today are left alone.
struct AvailabilityLayer: View {
  let days: [Date]
  let column: CGFloat
  let dayHeight: CGFloat
  let navigation: CalendarNavigation
  let booking: BookingData

  var body: some View {
    let zone = navigation.zone
    let today = zone.startOfDay(.now).ms
    ZStack(alignment: .topLeading) {
      ForEach(Array(days.enumerated()), id: \.element) { index, day in
        if day.ms >= today {
          let key = BookingData.dateKey(day, zone: zone)
          let saving = booking.savingDays.contains(key)
          ForEach(Array(booking.availability(on: day, zone: zone).intervals.enumerated()), id: \.element) { slot, interval in
            AvailabilityBlock(interval: interval, use24h: navigation.use24h, saving: saving) {
              booking.removeInterval(at: slot, on: day, zone: zone)
            }
            .frame(
              width: max(column - 8, 0),
              height: max(CGFloat((interval.endMin - interval.startMin) / 1440) * dayHeight, 16)
            )
            .offset(x: CGFloat(index) * column + 4, y: CGFloat(interval.startMin / 1440) * dayHeight)
          }
        }
      }
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    .animation(.snappy(duration: 0.18), value: booking.overrides)
  }
}

private struct AvailabilityBlock: View {
  let interval: DayInterval
  let use24h: Bool
  let saving: Bool
  let remove: () -> Void

  @State private var hovering = false

  private let shape = RoundedRectangle(cornerRadius: 7, style: .continuous)

  private var label: String {
    "\(formatWallClockMinutes(interval.startMin, includeDayPeriod: false, use24h: use24h)) – \(formatWallClockMinutes(interval.endMin, use24h: use24h))"
  }

  var body: some View {
    Button(action: remove) {
      HStack(alignment: .top, spacing: 4) {
        Text(label)
          .font(.sans(TextSize.xs, .medium))
          .foregroundStyle(Palette.available)
          .lineLimit(1)
        Spacer(minLength: 0)
        Image(systemName: "xmark")
          .font(.system(size: 9, weight: .bold))
          .foregroundStyle(Palette.available)
          .opacity(hovering ? 1 : 0)
      }
      .padding(.horizontal, 6)
      .padding(.vertical, 3)
      .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
      .background(Palette.available.opacity(hovering ? 0.25 : 0.15), in: shape)
      .overlay { shape.strokeBorder(Palette.available.opacity(0.5)) }
      .opacity(saving ? 0.6 : 1)
      .animation(saving ? .easeInOut(duration: 0.5).repeatForever() : .default, value: saving)
      .contentShape(shape)
    }
    .buttonStyle(.plain)
    .onHover { hovering = $0 }
    .help("Open \(label). Click to remove.")
    .accessibilityLabel("Open \(label)")
    .accessibilityHint("Removes this span")
  }
}

/// "Use weekly" on a painted day's header: hands the day back to the
/// weekly hours.
struct UseWeeklyButton: View {
  let action: () -> Void

  var body: some View {
    Button(action: action) {
      // The pill is the label, so all of it takes the click, not just the
      // words.
      Text("Use Weekly")
        .font(.sans(TextSize.xs, .medium))
        .foregroundStyle(Palette.mutedForeground)
        .padding(.horizontal, 6)
        .frame(height: 20)
        .background(Palette.background.opacity(0.9), in: .rect(cornerRadius: 6, style: .continuous))
        .overlay { RoundedRectangle(cornerRadius: 6, style: .continuous).strokeBorder(Palette.border) }
        .contentShape(.rect(cornerRadius: 6, style: .continuous))
    }
    .buttonStyle(.plain)
    .help("This day has its own hours. Click to go back to your weekly hours.")
  }
}
