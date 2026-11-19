import QaliDomain
import SwiftUI

/// A one-day calendar for a popover (the web's `DayPicker`), drawn like the
/// toolbar's month picker: the month with up/down arrows, single-letter
/// weekdays in the user's week order, and the days. The picked day is filled,
/// today is bold, days outside the month fade, and days before `minDay` are
/// off.
struct DayPicker: View {
  let selected: Date
  let zone: WorkingZone
  let weekStartsOn: WeekStart
  /// Days before this one cannot be picked.
  var minDay: Date?
  let pick: (Date) -> Void

  @State private var month: Date

  private static let cell: CGFloat = 32

  init(selected: Date, zone: WorkingZone, weekStartsOn: WeekStart, minDay: Date? = nil, pick: @escaping (Date) -> Void) {
    self.selected = selected
    self.zone = zone
    self.weekStartsOn = weekStartsOn
    self.minDay = minDay
    self.pick = pick
    _month = State(initialValue: zone.startOfMonth(selected))
  }

  /// Whole weeks covering the month.
  private var days: [Date] {
    let first = zone.startOfWeek(month, weekStartsOn: weekStartsOn)
    let lastDay = zone.addingDays(-1, to: zone.addingMonths(1, to: month))
    let lastWeek = zone.startOfWeek(lastDay, weekStartsOn: weekStartsOn)
    let weeks = (zone.calendar.dateComponents([.day], from: first, to: lastWeek).day ?? 0) / 7 + 1
    return (0..<(weeks * 7)).map { zone.addingDays($0, to: first) }
  }

  var body: some View {
    VStack(spacing: 8) {
      HStack(spacing: 4) {
        Text(zone.format(month, "MMMM yyyy"))
          .font(.sans(TextSize.sm, .semibold))
          .contentTransition(.numericText())
        Spacer(minLength: 16)
        MonthStep(symbol: "chevron.up", label: "Previous month") {
          withAnimation(.snappy(duration: 0.2)) { month = zone.addingMonths(-1, to: month) }
        }
        MonthStep(symbol: "chevron.down", label: "Next month") {
          withAnimation(.snappy(duration: 0.2)) { month = zone.addingMonths(1, to: month) }
        }
      }
      .padding(.leading, 4)

      LazyVGrid(columns: Array(repeating: GridItem(.fixed(Self.cell), spacing: 0), count: 7), spacing: 4) {
        ForEach(Array(days.prefix(7).enumerated()), id: \.offset) { _, day in
          Text(zone.format(day, "EEEEE"))
            .font(.sans(TextSize.xs, .medium))
            .foregroundStyle(Palette.mutedForeground)
            .frame(width: Self.cell, height: Self.cell)
        }
        ForEach(days, id: \.self) { day in
          DayCell(
            label: zone.format(day, "d"),
            accessibility: zone.format(day, "EEEE, MMMM d, yyyy"),
            selected: zone.isSameDay(day, selected),
            today: zone.isSameDay(day, .now),
            inMonth: zone.isSameMonth(day, month),
            disabled: minDay.map { day < zone.startOfDay($0) } ?? false
          ) {
            pick(day)
          }
        }
      }
    }
    .padding(12)
    .foregroundStyle(Palette.foreground)
  }
}

private struct DayCell: View {
  let label: String
  let accessibility: String
  let selected: Bool
  let today: Bool
  let inMonth: Bool
  let disabled: Bool
  let action: () -> Void

  @State private var hovering = false

  var body: some View {
    Button(action: action) {
      Text(label)
        .font(.sans(TextSize.sm, today || selected ? .semibold : .regular))
        .monospacedDigit()
        .foregroundStyle(selected ? Palette.primaryForeground : Palette.foreground)
        .opacity(selected ? 1 : inMonth ? 1 : 0.4)
        .frame(width: 32, height: 32)
        .background {
          RoundedRectangle(cornerRadius: 8, style: .continuous)
            .fill(selected ? Palette.primary : Palette.foreground.opacity(hovering ? 0.08 : 0))
        }
        .contentShape(.rect)
    }
    .buttonStyle(.plain)
    .disabled(disabled)
    .opacity(disabled ? 0.3 : 1)
    .onHover { hovering = $0 && !disabled }
    .accessibilityLabel(accessibility + (today ? ", today" : ""))
    .accessibilityAddTraits(selected ? .isSelected : [])
  }
}

private struct MonthStep: View {
  let symbol: String
  let label: String
  let action: () -> Void
  @State private var hovering = false

  var body: some View {
    Button(action: action) {
      Image(systemName: symbol)
        .font(.system(size: 11, weight: .semibold))
        .foregroundStyle(hovering ? Palette.foreground : Palette.mutedForeground)
        .frame(width: 24, height: 24)
        .background(Palette.foreground.opacity(hovering ? 0.08 : 0), in: .rect(cornerRadius: 6))
        .contentShape(.rect)
    }
    .buttonStyle(.plain)
    .onHover { hovering = $0 }
    .accessibilityLabel(label)
    .help(label)
  }
}
