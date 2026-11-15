import QaliDomain
import SwiftUI

/// The toolbar title: the page's name, plus the "W46" chip in week view.
/// Pressing it opens the month picker (the web's `MonthPicker`).
struct MonthPickerButton: View {
  let navigation: CalendarNavigation
  @State private var isOpen = false

  var body: some View {
    Button {
      isOpen.toggle()
    } label: {
      HStack(spacing: 8) {
        Text(navigation.title)
          .font(.sans(TextSize.base, .medium))
          .foregroundStyle(Palette.foreground)
          .contentTransition(.numericText())
        if navigation.view == .week {
          HStack(spacing: 3) {
            Text("W\(navigation.isoWeek)")
              .contentTransition(.numericText())
            Image(systemName: "chevron.down")
              .font(.system(size: 8, weight: .bold))
          }
          .font(.sans(TextSize.xs, .medium))
          .foregroundStyle(Palette.foreground)
          .padding(.horizontal, 7)
          .padding(.vertical, 2)
          .background(Palette.accent, in: .rect(cornerRadius: 6))
        }
      }
      .padding(.horizontal, 4)
      .animation(.snappy(duration: 0.25), value: navigation.anchor)
    }
    .accessibilityLabel("Choose week of \(navigation.zone.format(navigation.weekStart, "MMMM d, yyyy"))")
    .help("Choose a week")
    .popover(isPresented: $isOpen, arrowEdge: .bottom) {
      MonthPicker(navigation: navigation) { isOpen = false }
    }
  }
}

/// A month of days; picking one jumps the calendar to its page. The week on
/// screen is highlighted and today is filled.
private struct MonthPicker: View {
  let navigation: CalendarNavigation
  let close: () -> Void
  @State private var month: Date

  private static let cell: CGFloat = 32

  init(navigation: CalendarNavigation, close: @escaping () -> Void) {
    self.navigation = navigation
    self.close = close
    _month = State(initialValue: navigation.zone.startOfMonth(navigation.weekStart))
  }

  private var zone: WorkingZone { navigation.zone }

  /// Whole weeks covering the month, in the user's week order.
  private var days: [Date] {
    let first = zone.startOfWeek(month, weekStartsOn: navigation.weekStartsOn)
    let lastDay = zone.addingDays(-1, to: zone.addingMonths(1, to: month))
    let lastWeek = zone.startOfWeek(lastDay, weekStartsOn: navigation.weekStartsOn)
    let weeks = (zone.calendar.dateComponents([.day], from: first, to: lastWeek).day ?? 0) / 7 + 1
    return (0..<(weeks * 7)).map { zone.addingDays($0, to: first) }
  }

  var body: some View {
    VStack(spacing: 8) {
      HStack {
        Text(zone.format(month, "MMMM yyyy"))
          .font(.sans(TextSize.sm, .semibold))
        Spacer()
        Button("Previous month", systemImage: "chevron.up") {
          month = zone.addingMonths(-1, to: month)
        }
        Button("Next month", systemImage: "chevron.down") {
          month = zone.addingMonths(1, to: month)
        }
      }
      .labelStyle(.iconOnly)
      .buttonStyle(.borderless)
      .padding(.horizontal, 4)

      LazyVGrid(columns: Array(repeating: GridItem(.fixed(Self.cell), spacing: 0), count: 7), spacing: 4) {
        // Keyed by position: the same dates key the day cells below.
        ForEach(Array(days.prefix(7).enumerated()), id: \.offset) { _, day in
          Text(zone.format(day, "EEEEE"))
            .font(.sans(TextSize.xs, .medium))
            .foregroundStyle(Palette.mutedForeground)
            .frame(width: Self.cell, height: Self.cell)
        }
        ForEach(days, id: \.self) { day in
          dayButton(day)
        }
      }
    }
    .padding(12)
    .foregroundStyle(Palette.foreground)
  }

  private func dayButton(_ day: Date) -> some View {
    let today = navigation.isToday(day)
    let weekStart = navigation.weekStart
    let inWeek = day >= weekStart && day < zone.addingDays(7, to: weekStart)
    let inMonth = zone.isSameMonth(day, month)
    return Button {
      navigation.jump(to: day)
      close()
    } label: {
      Text(zone.format(day, "d"))
        .font(.sans(TextSize.sm, today ? .semibold : .regular))
        .monospacedDigit()
        .foregroundStyle(today ? Palette.primaryForeground : Palette.foreground)
        .opacity(inMonth || today ? 1 : 0.35)
        .frame(width: Self.cell, height: Self.cell)
        .background {
          if today {
            RoundedRectangle(cornerRadius: 8).fill(Palette.primary)
          } else if inWeek {
            // `accent` is the popover's own grey in dark mode, so the band
            // is cut from the text colour instead.
            Rectangle().fill(Palette.foreground.opacity(0.1))
          }
        }
        .contentShape(.rect)
    }
    .buttonStyle(.plain)
    .accessibilityLabel(zone.format(day, "EEEE, MMMM d, yyyy"))
    .accessibilityAddTraits(inWeek ? .isSelected : [])
  }
}
