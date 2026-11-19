import QaliDomain
import SwiftUI

/// The toolbar's calendar picker (the web's `CalendarPicker`): the colours of
/// the calendars on the grid and "3 of 5 calendars", opening a checklist that
/// shows or hides each one.
struct CalendarsButton: View {
  let data: CalendarData
  @State private var isOpen = false

  private var calendars: [CalendarListItem] { data.calendarGroups.flatMap(\.calendars) }

  private var summary: String {
    let all = calendars
    guard !all.isEmpty else { return "No calendars" }
    let selected = all.count { $0.selected ?? false }
    return "\(selected) of \(all.count) calendar\(all.count == 1 ? "" : "s")"
  }

  var body: some View {
    Button {
      isOpen.toggle()
    } label: {
      HStack(spacing: 7) {
        HStack(spacing: -5) {
          ForEach(calendars.filter { $0.selected ?? false }.prefix(8)) { calendar in
            Circle()
              .fill(Palette.event(calendar.colorKey))
              .frame(width: 12, height: 12)
              .overlay { Circle().strokeBorder(.background, lineWidth: 1.5) }
          }
        }
        Text(summary)
      }
      .padding(.horizontal, 2)
    }
    .accessibilityLabel("Choose calendars, \(summary)")
    .help("Choose which calendars to show")
    .popover(isPresented: $isOpen, arrowEdge: .bottom) {
      CalendarChecklist(data: data)
    }
  }
}

private struct CalendarChecklist: View {
  let data: CalendarData

  private static let row: CGFloat = 28

  /// Rows the list shows before it scrolls: eight calendars and their account
  /// headings, as on the web.
  private static func visibleRows(_ groups: [CalendarGroup]) -> Int {
    min(groups.flatMap(\.calendars).count, 8) + groups.count { $0.label != nil }
  }

  var body: some View {
    let groups = data.calendarGroups
    VStack(alignment: .leading, spacing: 0) {
      Text("Calendars")
        .font(.sans(TextSize.xs, .medium))
        .foregroundStyle(Palette.mutedForeground)
        .frame(height: 26)
      if groups.isEmpty {
        Text("Your calendars appear here once the first sync finishes.")
          .font(.sans(TextSize.xs))
          .foregroundStyle(Palette.mutedForeground)
          .fixedSize(horizontal: false, vertical: true)
          .padding(.bottom, 6)
      }
      ScrollView {
        VStack(alignment: .leading, spacing: 0) {
          ForEach(groups) { group in
            if let label = group.label {
              Text(label)
                .font(.sans(TextSize.xs, .medium))
                .foregroundStyle(Palette.mutedForeground)
                .lineLimit(1)
                .truncationMode(.middle)
                .frame(height: Self.row, alignment: .bottom)
                .padding(.bottom, 3)
                .frame(height: Self.row)
            }
            ForEach(group.calendars) { calendar in
              Toggle(
                isOn: Binding(
                  get: { calendar.selected ?? false },
                  set: { data.setCalendar(calendar, selected: $0) }
                )
              ) {
                HStack(spacing: 8) {
                  Circle()
                    .fill(Palette.event(calendar.colorKey))
                    .frame(width: 10, height: 10)
                  Text(calendar.displayName)
                    .font(.sans(TextSize.sm))
                    .lineLimit(1)
                }
                .padding(.leading, 2)
              }
              .toggleStyle(.checkbox)
              .frame(height: Self.row)
            }
          }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
      }
      .frame(height: CGFloat(Self.visibleRows(groups)) * Self.row)
    }
    .padding(EdgeInsets(top: 8, leading: 14, bottom: 12, trailing: 14))
    .frame(width: 256, alignment: .leading)
    .foregroundStyle(Palette.foreground)
  }
}
