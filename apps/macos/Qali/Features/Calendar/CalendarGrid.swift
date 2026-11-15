import QaliDomain
import SwiftUI

/// The calendar under the toolbar: the day and week time grids or the month
/// grid, following the toolbar's view and page, with the page's events.
struct CalendarGrid: View {
  let navigation: CalendarNavigation
  let data: CalendarData

  var body: some View {
    // Read the view and its days together and hand them down as values. A
    // grid that read `navigation.days` itself could be re-evaluated for the
    // other view's page (one day, seven, or forty-two) while it is being
    // swapped out, and index past the end.
    let view = navigation.view
    let days = navigation.days
    Group {
      if view == .month {
        MonthGrid(days: days, navigation: navigation, data: data)
      } else {
        TimeGrid(days: days, navigation: navigation, data: data)
      }
    }
    .background(Palette.background)
  }
}

/// Web grid metrics (components/calendar/lib.ts).
enum GridMetrics {
  static let gutter: CGFloat = 64
  static let headerHeight: CGFloat = 44
  static let minHourHeight: CGFloat = 40
}

/// The header band: the calendar-header colour, carried up under the toolbar
/// so the two read as one surface, as they do on the web.
struct HeaderBand<Content: View>: View {
  @ViewBuilder var content: Content

  var body: some View {
    content
      .background { Palette.calendarHeader.ignoresSafeArea(edges: .top) }
      .overlay(alignment: .bottom) { Palette.border.frame(height: 1) }
  }
}

/// The calendar's event fill: the event's hue mixed into the card colour
/// (`color-mix(in oklab, var(--event-n) 22%, var(--card))` on the web).
struct EventTint: View {
  let hue: Color
  var strength = 0.22

  var body: some View {
    ZStack {
      Palette.card
      hue.opacity(strength)
    }
  }
}

extension CalendarEvent {
  var title: String { summary ?? "(No title)" }
}
