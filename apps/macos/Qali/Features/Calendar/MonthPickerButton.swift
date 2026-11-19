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
          Text("W\(navigation.isoWeek)")
            .contentTransition(.numericText())
          .font(.sans(TextSize.xs, .medium))
          .foregroundStyle(Palette.foreground)
          .padding(.horizontal, 7)
          .padding(.vertical, 2)
          .background(Palette.accent, in: .rect(cornerRadius: 6))
        }
      }
      .padding(.horizontal, 4)
      .animation(.snappy(duration: 0.25), value: navigation.shownAnchor)
    }
    .accessibilityLabel("Choose week of \(navigation.zone.format(navigation.weekStart, "MMMM d, yyyy"))")
    .help("Choose a week")
    .popover(isPresented: $isOpen, arrowEdge: .bottom) {
      MonthPicker(navigation: navigation) { isOpen = false }
    }
    #if DEBUG
      // `-QaliMonthPicker YES` opens the picker a moment after launch.
      .task {
        guard UserDefaults.standard.bool(forKey: "QaliMonthPicker") else { return }
        try? await Task.sleep(for: .seconds(1.5))
        isOpen = true
      }
    #endif
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

      VStack(spacing: 4) {
        HStack(spacing: 0) {
          // Keyed by position: the same dates key the day cells below.
          ForEach(Array(days.prefix(7).enumerated()), id: \.offset) { _, day in
            Text(zone.format(day, "EEEEE"))
              .font(.sans(TextSize.xs, .medium))
              .foregroundStyle(Palette.mutedForeground)
              .frame(width: Self.cell, height: Self.cell)
          }
        }
        ForEach(0..<(days.count / 7), id: \.self) { row in
          let week = Array(days[(row * 7)..<(row * 7 + 7)])
          HStack(spacing: 0) {
            ForEach(week, id: \.self) { day in
              dayButton(day)
            }
          }
          .background(alignment: .leading) { weekBand(week) }
        }
      }
    }
    .padding(12)
    .foregroundStyle(Palette.foreground)
  }

  private func inWeek(_ day: Date) -> Bool {
    let weekStart = navigation.weekStart
    return day >= weekStart && day < zone.addingDays(7, to: weekStart)
  }

  /// The week on screen, as one rounded band under the days it covers in
  /// this row (a scrolled week can straddle two rows).
  @ViewBuilder private func weekBand(_ week: [Date]) -> some View {
    if let first = week.firstIndex(where: inWeek), let last = week.lastIndex(where: inWeek) {
      // `accent` is the popover's own grey in dark mode, so the band is cut
      // from the text colour instead.
      RoundedRectangle(cornerRadius: Self.cell / 2, style: .continuous)
        .fill(Palette.foreground.opacity(0.08))
        .frame(width: CGFloat(last - first + 1) * Self.cell, height: Self.cell)
        .offset(x: CGFloat(first) * Self.cell)
    }
  }

  private func dayButton(_ day: Date) -> some View {
    DayCell(
      label: zone.format(day, "d"),
      today: navigation.isToday(day),
      inMonth: zone.isSameMonth(day, month),
      size: Self.cell
    ) {
      navigation.jump(to: day)
      close()
    }
    .accessibilityLabel(zone.format(day, "EEEE, MMMM d, yyyy"))
    .accessibilityAddTraits(inWeek(day) ? .isSelected : [])
  }
}

/// One day in the picker: today filled like the grid's date header, others
/// with a soft round hover.
private struct DayCell: View {
  let label: String
  let today: Bool
  let inMonth: Bool
  let size: CGFloat
  let action: () -> Void

  @State private var hovering = false

  var body: some View {
    Button(action: action) {
      Text(label)
        .font(.sans(TextSize.sm, today ? .semibold : .regular))
        .monospacedDigit()
        .foregroundStyle(today ? Palette.primaryForeground : Palette.foreground)
        .opacity(inMonth || today ? 1 : 0.35)
        .frame(width: size, height: size)
        .background {
          if today {
            Circle().fill(Palette.primary).padding(2)
          } else if hovering {
            Circle().fill(Palette.foreground.opacity(0.08)).padding(2)
          }
        }
        .contentShape(.rect)
    }
    .buttonStyle(.plain)
    .onHover { hovering = $0 }
  }
}
