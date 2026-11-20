import QaliDomain
import SwiftUI

/// The day and week views: a date row and an all-day band over a scrolling
/// 24-hour grid, with each day's timed events laid out by QaliDomain (the
/// same cascade and lane rules as the web's `layoutDayEvents`).
///
/// The day columns scroll sideways on a trackpad (see `StripScroller`): they
/// are a strip of the visible page plus a page of buffer on each side, drawn
/// from the navigation anchor and shifted by the scroller's offset, while the
/// hour gutter and the hour lines stay put.
struct TimeGrid: View {
  /// The visible page; its first day is the anchor.
  let days: [Date]
  let navigation: CalendarNavigation
  let data: CalendarData
  /// Shared with the month grid, whose dates start from the strip's.
  let zoom: Namespace.ID

  /// Whether the all-day band shows every lane. It stays as set while the
  /// days scroll or page, and across launches.
  @AppStorage("allDayExpanded") private var expanded = false
  @State private var scroll = ScrollPosition(edge: .top)
  @State private var scroller = StripScroller()
  /// A range being drawn on the grid for a new event.
  @State private var drawing = GridDrawing()
  /// A card being moved or resized, and saved times waiting for the sync.
  @State private var drag = EventDrag()
  /// Where the hours are scrolled, kept out of observation so scrolling does
  /// not re-render the grid.
  @State private var hoursScroll = HoursScroll()
  /// The hour body's row height and visible height, for scrolling to a time.
  @State private var body24 = (hour: CGFloat(0), viewport: CGFloat(0))

  @Environment(Island.self) private var island

  var body: some View {
    let zone = navigation.zone
    let columns = days.count
    let side = Self.side(columns: columns)
    let strip = stripDays(anchor: days[0], columns: columns, side: side, zone: zone)
    let visible = side..<(side + columns)
    let buckets = bucketDayEvents(days: strip, events: drag.apply(to: data.events))
    let allDay = layoutAllDayEvents(days: strip, events: buckets.allDayEvents, zone: zone)
    let metrics = visibleAllDayMetrics(allDay, visibleStartIdx: side, visibleEndIdx: side + columns - 1)
    let ghost = allDayGhost(strip: strip, layouts: allDay, laneCount: metrics.laneCount)
    // A ghost on the page may need a row of its own, open or closed.
    let ghostLanes = ghost.flatMap { $0.endIdx >= visible.lowerBound && $0.startIdx < visible.upperBound ? $0.lane + 1 : nil } ?? 0
    let bandHeight = max(
      metrics.laneCount == 0 ? 0 : allDayBandHeight(laneCount: metrics.laneCount, expanded: expanded),
      ghostLanes == 0 ? 0 : allDayBandHeight(laneCount: ghostLanes, expanded: true)
    )

    GeometryReader { outer in
      let column = max(outer.size.width - GridMetrics.gutter, 1) / CGFloat(columns)
      let track = StripGeometry(column: column, side: side, count: strip.count)

      VStack(spacing: 0) {
        HeldBandHeight(scroller: scroller, height: bandHeight, settled: navigation.stripSettled) { height in
        HeaderBand {
          VStack(spacing: 0) {
            HStack(spacing: 0) {
              Color.clear.frame(width: GridMetrics.gutter)
              StripTrack(scroller: scroller, geometry: track) {
                HStack(spacing: 0) {
                  ForEach(Array(strip.enumerated()), id: \.element) { index, day in
                    DayHeader(day: day, navigation: navigation, zoom: zoom, onPage: visible.contains(index))
                      .frame(width: column, height: GridMetrics.headerHeight, alignment: .leading)
                  }
                }
              }
            }
            .frame(height: GridMetrics.headerHeight)

            AllDayBand(
              layouts: allDay,
              ghost: ghost,
              column: column,
              hiddenCount: metrics.hiddenEventCount,
              expanded: expanded,
              data: data,
              scroller: scroller,
              track: track
            ) {
              withAnimation(.snappy(duration: 0.2)) {
                expanded.toggle()
              }
            }
            // Animated frame by frame, not just drawn that way: the hours
            // below are cut from the height left over, so they must see every
            // step of it or they jump to the end while the band is still moving.
            .modifier(AnimatedHeight(height: height))
            .clipped()
          }
          // The day dividers run the full header height, through the date row
          // and the all-day band, fading in from its top edge (the web's
          // PanelHeader overlay), behind the dates and all-day cards.
          .background {
            HStack(spacing: 0) {
              Color.clear.frame(width: GridMetrics.gutter)
              StripTrack(scroller: scroller, geometry: track) {
                DayDividers(count: strip.count, column: column, fadeIn: GridMetrics.headerDividerFade)
              }
            }
            .allowsHitTesting(false)
          }
          .overlay { RailEdge(fadeIn: GridMetrics.headerDividerFade) }
        }
        .animation(.snappy(duration: 0.2), value: height)
        }

        GeometryReader { proxy in
          // The day fills the window above the runout when there is room, and
          // scrolls otherwise.
          let hour = max(GridMetrics.minHourHeight, (proxy.size.height - GridMetrics.bottomRunout) / 24)
          ScrollView {
            VStack(spacing: 0) {
            ZStack(alignment: .topLeading) {
              HourLines(hour: hour)
              HourLabels(hour: hour, use24h: navigation.use24h)
              HStack(spacing: 0) {
                Color.clear.frame(width: GridMetrics.gutter)
                StripTrack(scroller: scroller, geometry: track) {
                  ZStack(alignment: .topLeading) {
                    DayDividers(count: strip.count, column: column)
                      // The dividers carry on above midnight, out of sight
                      // until a pull past the top bounces the grid down; they
                      // then meet the header's own instead of stopping short.
                      .overlay(alignment: .top) {
                        DayDividers(count: strip.count, column: column)
                          .frame(height: GridMetrics.overscrollRoom)
                          .offset(y: -GridMetrics.overscrollRoom)
                      }
                    // Under the cards, so a drag that starts on one is
                    // the card's and not a new event.
                    CreateDragLayer(days: strip, firstVisible: side, column: column, dayHeight: hour * 24, drawing: drawing)
                    TimedEvents(
                      days: strip,
                      visible: visible,
                      timedByDay: buckets.timedByDay,
                      column: column,
                      dayHeight: hour * 24,
                      laneLayout: columns == 1,
                      navigation: navigation,
                      data: data,
                      drag: drag
                    )
                    CreateGhost(
                      days: strip,
                      column: column,
                      dayHeight: hour * 24,
                      drawing: drawing,
                      navigation: navigation,
                      reveal: reveal
                    )
                    NowLine(days: strip, column: column, navigation: navigation, hour: hour)
                  }
                  // What the card gestures report in: it moves with the strip
                  // and the hours, so a point maps straight to a day and time.
                  .coordinateSpace(.named(EventDrag.space))
                }
              }
              // Over the strip, so cards swiped past the rail slide under it;
              // carried on above midnight like the day dividers.
              RailEdge()
                .overlay(alignment: .top) {
                  RailEdge()
                    .frame(height: GridMetrics.overscrollRoom)
                    .offset(y: -GridMetrics.overscrollRoom)
                }
              NowMarker(hour: hour, navigation: navigation)
            }
            .frame(height: hour * 24)

            // Room below midnight where the day dividers carry on and dissolve,
            // so the grid trails off instead of stopping dead.
            HStack(spacing: 0) {
              Color.clear.frame(width: GridMetrics.gutter)
              StripTrack(scroller: scroller, geometry: track) {
                DayDividers(count: strip.count, column: column)
              }
            }
            .frame(height: GridMetrics.bottomRunout)
            .overlay { RailEdge() }
            .mask(LinearGradient(colors: [.black, .clear], startPoint: .top, endPoint: .bottom))
            .allowsHitTesting(false)
            }
            #if DEBUG
              // `-QaliOverscroll 60` opens at midnight and holds the hours that
              // far down, as a pull past the top bounces them, to capture what
              // it reveals.
              .offset(y: UserDefaults.standard.double(forKey: "QaliOverscroll"))
            #endif
          }
          .scrollPosition($scroll)
          .onScrollGeometryChange(for: CGRect.self) { geometry in
            CGRect(
              x: 0,
              y: geometry.contentOffset.y,
              width: 0,
              height: max(geometry.contentSize.height - geometry.containerSize.height, 0)
            )
          } action: { _, next in
            hoursScroll.y = next.minY
            hoursScroll.maxY = next.height
          }
          .onGeometryChange(for: CGFloat.self) { $0.frame(in: .global).minY } action: { hoursScroll.top = $0 }
          .onChange(of: hour, initial: true) { _, hour in body24 = (hour, proxy.size.height) }
          .onChange(of: proxy.size.height) { _, height in body24.viewport = height }
          // Open with the current time in the middle of the window.
          .onAppear {
            scroll.scrollTo(y: nowScrollY(hour: hour, viewport: proxy.size.height))
            #if DEBUG
              if UserDefaults.standard.double(forKey: "QaliOverscroll") != 0 { scroll.scrollTo(y: 0) }
            #endif
          }
        }
      }
      .background { StripScrollCatcher(scroller: scroller) }
      .onChange(of: column, initial: true) { _, column in
        scroller.columnWidth = column
        hoursScroll.column = column
      }
      .onChange(of: side, initial: true) { _, side in
        // The strip runs into its buffer before handing days over to the
        // anchor, which rebuilds the grid: every few days of a swipe rather
        // than every one, and the rest on landing.
        scroller.handOver = CGFloat(side) - 0.5
      }
      .onGeometryChange(for: CGFloat.self) { $0.frame(in: .global).minX } action: { hoursScroll.left = $0 }
    }
    .onChange(of: navigation.view, initial: true) { _, view in
      scroller.isEnabled = view != .month
      scroller.maxFlingDays = view == .day ? 7 : 14
    }
    // The toolbar, a shortcut or a view switch moved the page: start the
    // strip afresh there. The scroller's own day steps keep their glide.
    .onChange(of: days[0]) { _, anchor in
      if anchor != scroller.ownAnchor { scroller.reset() }
    }
    .onAppear {
      scroller.shiftAnchor = { [navigation, scroller] days in
        navigation.scroll(days: days)
        scroller.ownAnchor = navigation.anchor
      }
      // The toolbar names the page in view, not the anchor's.
      scroller.reportVisibleSteps = { [navigation] days in navigation.setStripScroll(days: days) }
      navigation.strip = .init(
        step: { [scroller] days in scroller.step(days: days) },
        glide: { [navigation, scroller] day in
          let days = navigation.days(to: day)
          // Far away, scrolling through every day between would be a blur:
          // land a page short, on the side the strip is coming from, and
          // glide the last page, so the motion still says which way it went.
          let page = viewColumns(navigation.view)
          if abs(days) > 2 * page {
            let lead = days > 0 ? page : -page
            scroller.reset()
            navigation.scroll(days: days - lead)
            scroller.ownAnchor = navigation.anchor
            scroller.glide(toDay: lead)
          } else {
            scroller.glide(toDay: days)
          }
        },
        revealNow: {
          let (hour, viewport) = body24
          withAnimation(.smooth(duration: 0.45)) {
            scroll.scrollTo(y: nowScrollY(hour: hour, viewport: viewport))
          }
        },
        revealHour: { at in
          let (hour, viewport) = body24
          // A third of the way down, so the island opening over the lower
          // half leaves the card in view.
          let limit = max(hour * 24 + GridMetrics.bottomRunout - viewport, 0)
          let y = min(max(at * hour - viewport * 0.3, 0), limit)
          withAnimation(.smooth(duration: 0.45)) { scroll.scrollTo(y: y) }
        },
        isMoving: { [scroller] in scroller.isMoving }
      )
    }
    .onDisappear { navigation.strip = nil }
    .onChange(of: data.events) { _, events in drag.reconcile(events) }
    .environment(\.reveal, navigation.reveal)
    #if DEBUG
      // `-QaliFling 2400` lets the strip go at that many points per second
      // (negative goes back) three seconds after launch, for captures of the
      // glide without a trackpad.
      // `-QaliToday YES` presses Today.
      // `-QaliStep 2` presses Next twice in quick succession (negative presses
      // Previous), to watch the arrows' glide and steps adding up.
      .task {
        let defaults = UserDefaults.standard
        let velocity = defaults.double(forKey: "QaliFling")
        let presses = defaults.integer(forKey: "QaliStep")
        let today = defaults.bool(forKey: "QaliToday")
        if defaults.bool(forKey: "QaliBandToggle") {
          // `-QaliBandToggle YES` opens the all-day band three seconds after
          // launch and closes it again a second later, as its gutter control does.
          for _ in 0..<2 {
            try? await Task.sleep(for: .seconds(expanded ? 1 : 3))
            withAnimation(.snappy(duration: 0.2)) { expanded.toggle() }
          }
        }
        guard velocity != 0 || presses != 0 || today else { return }
        try? await Task.sleep(for: .seconds(3))
        if velocity != 0 { scroller.debugFling(velocity) }
        for _ in 0..<abs(presses) {
          navigation.step(presses > 0 ? 1 : -1)
          try? await Task.sleep(for: .milliseconds(120))
        }
        if today { navigation.goToToday() }
      }
    #endif
  }
}

/// The all-day band's height, held where it was while the strip is moving
/// so the hours don't shift under a scroll; it catches up once the strip
/// lands. Its own view, so that a swipe starting and landing re-renders
/// only the header and not the whole grid.
private struct HeldBandHeight<Content: View>: View {
  let scroller: StripScroller
  /// The height the page's events need.
  let height: CGFloat
  /// Called when the strip lands.
  let settled: () -> Void
  @ViewBuilder let content: (CGFloat) -> Content

  /// Captured from the render where the strip set off, before any day moved.
  @State private var held: CGFloat?

  var body: some View {
    content(scroller.isMoving ? (held ?? height) : height)
      .onChange(of: scroller.isMoving) { _, moving in
        held = moving ? height : nil
        if !moving { settled() }
      }
  }
}

/// A frame height that is laid out at every step of its animation, so what
/// is sized from the space around it follows along instead of jumping.
private struct AnimatedHeight: ViewModifier, Animatable {
  var height: CGFloat

  var animatableData: CGFloat {
    get { height }
    set { height = newValue }
  }

  func body(content: Content) -> some View {
    content.frame(height: max(height, 0))
  }
}

/// Where the strip's columns sit: their width, the buffered days before the
/// anchor, and how many there are in all.
private struct StripGeometry: Equatable {
  var column: CGFloat
  var side: Int
  var count: Int
}

/// The hour body's scroll state, read when a ghost needs moving into view.
private final class HoursScroll {
  var y: CGFloat = 0
  var maxY: CGFloat = 0
  /// The scroll view's top edge in global coordinates.
  var top: CGFloat = 0
  /// The grid's leading edge in global coordinates, and its column width.
  var left: CGFloat = 0
  var column: CGFloat = 0
  /// The last offset a reveal scrolled to, so the frames of its own
  /// animation do not ask for it again.
  var revealTarget: CGFloat?
}

/// Where a new all-day event being created sits in the all-day band.
private struct AllDayGhost: Equatable {
  var startIdx: Int
  var endIdx: Int
  var lane: Int
  var label: String
}

extension TimeGrid {
  /// Days drawn off the page on each side, for the strip to scroll into
  /// before it hands them over: a page in week view, a few days in day view.
  static func side(columns: Int) -> Int { max(columns, 3) }

  /// The create form's all-day event, as a bar in the band: on the days it
  /// covers, in the first row the band shows that is free across them, or a
  /// row of its own below them, so it is never hidden by the band being
  /// closed.
  fileprivate func allDayGhost(strip: [Date], layouts: [AllDayEventLayout<CalendarEvent>], laneCount: Int) -> AllDayGhost? {
    guard let draft = island.ghostDraft, draft.allDay, draft.isValid else { return nil }
    let zone = navigation.zone
    let startMs = utcMidnight(draft.startMs, zone: zone)
    let endMs = utcMidnight(draft.endMs, zone: zone) + msPerDay
    // Off the strip altogether: nothing to draw.
    guard let first = strip.first, let last = strip.last,
      endMs > utcMidnight(first.ms, zone: zone), startMs <= utcMidnight(last.ms, zone: zone)
    else { return nil }
    let span = allDayColumnSpan(startMs: startMs, endMs: endMs, days: strip, zone: zone)
    let shown = expanded ? min(laneCount, allDayMaxExpandedLanes) : min(laneCount, allDayCollapsedLanes)
    let taken = Set(
      layouts
        .filter { $0.lane < shown && $0.endIdx >= span.startIdx && $0.startIdx <= span.endIdx }
        .map(\.lane)
    )
    let lane = (0..<shown).first { !taken.contains($0) } ?? shown
    let title = draft.summary.trimmingCharacters(in: .whitespaces)
    return AllDayGhost(startIdx: span.startIdx, endIdx: span.endIdx, lane: lane, label: title.isEmpty ? "All day" : title)
  }

  /// Scrolls the hours so a ghost at `frame` (global) clears `obstacle`,
  /// keeping its top on screen.
  fileprivate func reveal(_ local: CGRect, above obstacle: CGRect) {
    // Strip coordinates to the window's: the strip starts a buffer of
    // columns before the gutter's edge and moves with the trackpad offset;
    // the hours move with their scroll.
    let side = CGFloat(Self.side(columns: days.count))
    let frame = local.offsetBy(
      dx: hoursScroll.left + GridMetrics.gutter - side * hoursScroll.column - scroller.offset,
      dy: hoursScroll.top - hoursScroll.y
    )
    guard frame.maxX > obstacle.minX, frame.minX < obstacle.maxX, frame.maxY > obstacle.minY - 16 else { return }
    let wanted = frame.maxY - (obstacle.minY - 16)
    let room = frame.minY - (hoursScroll.top + 8)
    let delta = min(wanted, room)
    guard delta > 1 else { return }
    let target = min(hoursScroll.y + delta, hoursScroll.maxY)
    guard target - hoursScroll.y > 1 else { return }
    if let last = hoursScroll.revealTarget, abs(last - target) < 2 { return }
    hoursScroll.revealTarget = target
    withAnimation(.smooth(duration: 0.4)) {
      scroll.scrollTo(y: target)
    } completion: { [hoursScroll] in
      hoursScroll.revealTarget = nil
    }
  }

  /// The hour body's scroll offset that puts the current time in the middle
  /// of the window, as far as the day's ends allow.
  fileprivate func nowScrollY(hour: CGFloat, viewport: CGFloat) -> CGFloat {
    let now = Date.now.timeIntervalSince(navigation.zone.startOfDay(.now)) / 3600
    let limit = max(hour * 24 + GridMetrics.bottomRunout - viewport, 0)
    return min(max(now * hour - viewport / 2, 0), limit)
  }
}

/// The scrolling layer of the time grid: the strip's columns, laid out from
/// the first buffered day and shifted so the anchor sits at the leading edge,
/// less the scroller's offset. It alone reads the offset, so a scroll frame
/// re-renders this wrapper and not the grid around it.
private struct StripTrack<Content: View>: View {
  let scroller: StripScroller
  let geometry: StripGeometry
  @ViewBuilder var content: Content
  /// Made with the grid's render: see `ScrollContent`.
  private let render = ScrollContent<Content>.Render()

  var body: some View {
    ScrollContent(render: render, content: content)
      .equatable()
      .frame(width: geometry.column * CGFloat(geometry.count), alignment: .topLeading)
      .offset(x: -CGFloat(geometry.side) * geometry.column - scroller.offset)
      // Scrolling is never animated by SwiftUI; the band's height animation
      // must not catch the strip mid-scroll and make it lag the body.
      .animation(nil, value: scroller.offset)
      // A zero minimum, or the frame would report the whole strip's width
      // and stretch the grid around it; it is the viewport onto the strip.
      .frame(minWidth: 0, maxWidth: .infinity, minHeight: 0, maxHeight: .infinity, alignment: .topLeading)
      // Clipped sideways only (to the area right of the gutter): what the
      // strip draws above or below itself, like the dividers an overscroll
      // reveals, stays visible.
      // (A clip, not a mask: a mask renders offscreen every frame.)
      .clipShape(StripClip())
      // A clip only cuts the drawing: without this, a card running in from
      // a buffered day still takes clicks meant for the rail beside it.
      .contentShape(StripClip())
  }
}

/// The strip's viewport: its own width, and far enough above and below
/// for anything an overscroll reveals.
nonisolated private struct StripClip: Shape {
  func path(in rect: CGRect) -> Path {
    Path(rect.insetBy(dx: 0, dy: -GridMetrics.overscrollRoom))
  }
}

// MARK: - Header

private struct DayHeader: View {
  let day: Date
  let navigation: CalendarNavigation
  let zoom: Namespace.ID
  /// On the visible page: only those numbers lead the month's into place.
  let onPage: Bool

  var body: some View {
    let today = navigation.isToday(day)
    let zoomID = ZoomID.date(day, zone: navigation.zone)
    // While zooming, the month's copies of this page's label and number
    // stand in for them, travelling to and from the month.
    let handedOver = onPage && navigation.zooming
    HStack(alignment: .firstTextBaseline, spacing: 6) {
      Text(navigation.zone.format(day, "EEE").uppercased())
        .font(.sans(TextSize.xs, .medium))
        .tracking(0.3)
        .foregroundStyle(today ? Palette.foreground : Palette.mutedForeground)
        .matchedGeometryEffect(id: onPage ? ZoomID.weekday(day, zone: navigation.zone) : "strip-\(zoomID)-wd", in: zoom)
        .opacity(handedOver ? 0 : 1)
      Text(navigation.zone.format(day, "d"))
        .font(.sans(TextSize.lg, .semibold))
        .foregroundStyle(today ? Palette.primaryForeground : Palette.foreground)
        .frame(minWidth: 28, minHeight: 28)
        .background { if today { Circle().fill(Palette.primary) } }
        // Where this day's number in the month grid sets out from.
        .matchedGeometryEffect(id: onPage ? zoomID : "strip-\(zoomID)", in: zoom)
        .opacity(handedOver ? 0 : 1)
    }
    .padding(.horizontal, 8)
    .accessibilityElement(children: .combine)
    .accessibilityLabel(navigation.zone.format(day, "EEEE, MMMM d") + (today ? ", today" : ""))
  }
}

/// All-day and multi-day events, packed into lanes across the strip's day
/// columns. Two lanes show by default; the gutter control reveals the rest.
private struct AllDayBand: View {
  let layouts: [AllDayEventLayout<CalendarEvent>]
  let ghost: AllDayGhost?
  let column: CGFloat
  let hiddenCount: Int
  let expanded: Bool
  let data: CalendarData
  let scroller: StripScroller
  let track: StripGeometry
  let toggle: () -> Void

  var body: some View {
    HStack(alignment: .top, spacing: 0) {
      ZStack(alignment: .topTrailing) {
        if hiddenCount > 0 || expanded {
          Button(action: toggle) {
            HStack(spacing: 2) {
              if !expanded { Text("+\(hiddenCount)") }
              Image(systemName: expanded ? "chevron.up" : "chevron.down")
                .font(.system(size: 8, weight: .bold))
            }
            .font(.sans(TextSize.xs, .medium))
            .foregroundStyle(Palette.mutedForeground)
            .frame(width: GridMetrics.gutter - 10, height: allDayEventHeight, alignment: .trailing)
            .contentShape(.rect)
          }
          .buttonStyle(.plain)
          .padding(.top, allDayBandPadding)
          .accessibilityLabel(expanded ? "Show fewer all-day events" : "Show \(hiddenCount) more all-day events")
        }
      }
      .frame(width: GridMetrics.gutter, alignment: .topLeading)
      // Above the strip, so the toggle stays the rail's to click.
      .zIndex(1)

      StripTrack(scroller: scroller, geometry: track) {
        ZStack(alignment: .topLeading) {
          ForEach(layouts, id: \.event.id) { layout in
            if expanded || layout.lane < allDayCollapsedLanes {
              let width = max(column * CGFloat(layout.endIdx - layout.startIdx + 1) - 8, 0)
              AllDayCard(
                event: layout.event,
                hue: Palette.event(data.colorKey(for: layout.event)),
                width: width,
                // The card's leading edge on the strip, for the sticky title.
                minX: column * CGFloat(layout.startIdx) + 4,
                viewport: { [scroller, track] in CGFloat(track.side) * track.column + scroller.offset }
              )
                .frame(width: width, height: allDayEventHeight)
                .offset(
                  x: column * CGFloat(layout.startIdx) + 4,
                  y: allDayBandPadding + Double(layout.lane) * (allDayEventHeight + allDayEventGap)
                )
            }
          }
          if let ghost {
            GhostPiece(label: ghost.label, cornerRadius: 6)
              .frame(
                width: max(column * CGFloat(ghost.endIdx - ghost.startIdx + 1) - 8, 0),
                height: allDayEventHeight
              )
              .offset(
                x: column * CGFloat(ghost.startIdx) + 4,
                y: allDayBandPadding + Double(ghost.lane) * (allDayEventHeight + allDayEventGap)
              )
              .allowsHitTesting(false)
              .accessibilityHidden(true)
          }
        }
      }
    }
  }
}

/// An all-day bar. When it starts before the visible days, its colour rail
/// and title stay pinned to the grid's left edge while the strip scrolls
/// (the web clamps the card to the page instead, once a scroll settles).
private struct AllDayCard: View {
  let event: CalendarEvent
  let hue: Color
  let width: CGFloat
  let minX: CGFloat
  /// Where the visible days begin on the strip, read live.
  let viewport: () -> CGFloat

  private let shape = RoundedRectangle(cornerRadius: 6, style: .continuous)

  var body: some View {
    // The flash sits under the label, as on the web.
    EventTint(hue: hue)
      .revealFlash([event.id])
      .overlay(alignment: .leading) {
        StickyLabel(title: event.title, hue: hue, width: width, minX: minX, viewport: viewport)
      }
      .clipShape(shape)
      .overlay { shape.strokeBorder(Palette.border) }
      .help(event.title)
      .opensEvent(event)
  }
}

/// The rail and title of an all-day bar, shifted to stay in view. Its own
/// view so that only it, not the band, follows each scroll frame.
private struct StickyLabel: View {
  let title: String
  let hue: Color
  let width: CGFloat
  let minX: CGFloat
  let viewport: () -> CGFloat

  /// What stays of the card when the label is pushed to its end: the rail
  /// and a few letters.
  private static let minimumRoom: CGFloat = 48

  var body: some View {
    // How far the visible edge has cut into the card, up to its last stretch.
    // Pinned, it lines up with a card starting on the first visible day,
    // which sits 4pt in from the column's edge.
    let inset = min(max(viewport() + 4 - minX, 0), max(width - Self.minimumRoom, 0))
    HStack(spacing: 0) {
      Capsule().fill(hue).frame(width: 3).padding(.vertical, 4).padding(.leading, 4)
      Text(title)
        .font(.sans(TextSize.xs, .medium))
        .lineLimit(1)
        .padding(.leading, 4)
        .padding(.trailing, 8)
      Spacer(minLength: 0)
    }
    .frame(width: max(width - inset, 0), alignment: .leading)
    .offset(x: inset)
    .animation(nil, value: inset)
  }
}

// MARK: - Grid

/// Hour rows, in the border colour at 55% (the web's
/// `color-mix(in oklab, var(--border) 55%, transparent)`), softer than the
/// day dividers. They stay put while the days scroll.
private struct HourLines: View {
  let hour: CGFloat

  var body: some View {
    Canvas { context, size in
      var path = Path()
      for index in 1..<24 {
        let y = (CGFloat(index) * hour).rounded() + 0.5
        path.move(to: CGPoint(x: GridMetrics.gutter, y: y))
        path.addLine(to: CGPoint(x: size.width, y: y))
      }
      context.stroke(path, with: .color(Palette.border.opacity(0.55)), lineWidth: 1)
    }
    .accessibilityHidden(true)
  }
}

/// The line on each day column's leading edge, scrolling with the strip.
/// With `fadeIn`, the lines start transparent at the top and reach full
/// strength that far down.
private struct DayDividers: View {
  let count: Int
  let column: CGFloat
  var fadeIn: CGFloat = 0

  var body: some View {
    Canvas { context, size in
      var path = Path()
      for index in 0..<count {
        let x = (CGFloat(index) * column).rounded() + 0.5
        path.move(to: CGPoint(x: x, y: 0))
        path.addLine(to: CGPoint(x: x, y: size.height))
      }
      if fadeIn > 0, size.height > 0 {
        let gradient = Gradient(stops: [
          .init(color: Palette.border.opacity(0), location: 0),
          .init(color: Palette.border, location: min(fadeIn / size.height, 1)),
          .init(color: Palette.border, location: 1),
        ])
        context.stroke(
          path,
          with: .linearGradient(gradient, startPoint: .zero, endPoint: CGPoint(x: 0, y: size.height)),
          lineWidth: 1
        )
      } else {
        context.stroke(path, with: .color(Palette.border), lineWidth: 1)
      }
    }
    .accessibilityHidden(true)
  }
}

/// The time rail's trailing edge: a 1pt line in the system separator colour,
/// as AppKit draws a split view's divider. It sits on the first day column's
/// leading divider and stays put while the days scroll, so the rail keeps its
/// edge mid-swipe. With `fadeIn`, it fades in from the top like the header's
/// day dividers.
private struct RailEdge: View {
  var fadeIn: CGFloat = 0

  var body: some View {
    Rectangle()
      .fill(GridEdge.separator)
      .frame(width: 1)
      .mask {
        VStack(spacing: 0) {
          LinearGradient(colors: [.clear, .black], startPoint: .top, endPoint: .bottom)
            .frame(height: fadeIn)
          Color.black
        }
      }
      .padding(.leading, GridMetrics.gutter)
      .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
      .allowsHitTesting(false)
      .accessibilityHidden(true)
  }
}

/// The gutter's hour labels, as on the web's `TimeGutter`: "1am" … "11pm"
/// (or "1" … "23" on a 24-hour clock) in 10pt tabular figures, centred on
/// their lines and 6pt in from the gutter's edge, where the time pill sits.
private struct HourLabels: View {
  let hour: CGFloat
  let use24h: Bool

  var body: some View {
    ZStack(alignment: .topLeading) {
      ForEach(1..<24, id: \.self) { index in
        Text(label(index))
          .font(.sans(10))
          .monospacedDigit()
          .foregroundStyle(Palette.mutedForeground)
          .frame(width: GridMetrics.gutter - 6, height: 16, alignment: .trailing)
          .offset(y: CGFloat(index) * hour - 8)
      }
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    .accessibilityHidden(true)
  }

  private func label(_ hour: Int) -> String {
    if use24h { return "\(hour)" }
    return "\(hour % 12 == 0 ? 12 : hour % 12)\(hour < 12 ? "am" : "pm")"
  }
}

/// Where the current time sits in the 24-hour body.
private func nowY(_ date: Date, hour: CGFloat, zone: WorkingZone) -> CGFloat {
  date.timeIntervalSince(zone.startOfDay(date)) / 3600 * hour
}

/// The fixed part of the current-time marker, as on the web (`NowIndicator`
/// and the gutter's time pill): a faint line across the whole grid on every
/// page, and in the gutter a pill with the time, tied to the line by a short
/// stub. It stays put while the days scroll.
private struct NowMarker: View {
  let hour: CGFloat
  let navigation: CalendarNavigation

  var body: some View {
    TimelineView(.everyMinute) { timeline in
      let y = nowY(timeline.date, hour: hour, zone: navigation.zone)
      ZStack(alignment: .topLeading) {
        Rectangle()
          .fill(Palette.now.opacity(0.25))
          .frame(height: 1)
          .padding(.leading, GridMetrics.gutter)
          .offset(y: y - 0.5)

        HStack(spacing: 0) {
          Text(navigation.zone.format(timeline.date, timePattern(use24h: navigation.use24h, withDayPeriod: false)))
            .font(.sans(TextSize.xs, .semibold))
            .monospacedDigit()
            .foregroundStyle(.white)
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background(Capsule().fill(Palette.now))
            // Tailwind's shadow-sm.
            .shadow(color: .black.opacity(0.1), radius: 1.5, y: 1)
          Rectangle()
            .fill(Palette.now)
            .frame(width: 6, height: 2)
        }
        // A box centred on the line, the pill at its trailing edge.
        .frame(width: GridMetrics.gutter, height: 20, alignment: .trailing)
        .offset(y: y - 10)
      }
      .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }
    .allowsHitTesting(false)
    .accessibilityHidden(true)
  }
}

/// The scrolling part of the current-time marker: the solid line over today's
/// column, when today is on the strip.
private struct NowLine: View {
  let days: [Date]
  let column: CGFloat
  let navigation: CalendarNavigation
  let hour: CGFloat

  var body: some View {
    if let index = days.firstIndex(where: navigation.isToday) {
      TimelineView(.everyMinute) { timeline in
        Rectangle()
          .fill(Palette.now)
          .frame(width: column, height: 2)
          .offset(x: CGFloat(index) * column, y: nowY(timeline.date, hour: hour, zone: navigation.zone) - 1)
          .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
      }
      .allowsHitTesting(false)
      .accessibilityHidden(true)
    }
  }
}

// MARK: - Timed events

/// Every strip column's timed events, positioned inside the 24-hour body.
/// Editable cards can be dragged to another time or day, or stretched by an
/// edge (`EventDrag`).
private struct TimedEvents: View {
  let days: [Date]
  let visible: Range<Int>
  let timedByDay: [[CalendarEvent]]
  let column: CGFloat
  let dayHeight: CGFloat
  /// Day view fans overlaps into lanes; week columns are too narrow to fan
  /// and cascade instead, tiling only when starts are too close to stagger.
  let laneLayout: Bool
  let navigation: CalendarNavigation
  let data: CalendarData
  let drag: EventDrag

  /// One card: an event's piece in one day column. An event past midnight
  /// has a piece in each day it covers, numbered from its first on the strip.
  private struct Piece: Identifiable {
    let id: String
    let dayIndex: Int
    let item: PositionedEvent<CalendarEvent>
  }

  var body: some View {
    let geometry = EventDrag.Geometry(
      days: days,
      visible: visible,
      column: column,
      dayHeight: dayHeight,
      zone: navigation.zone
    )
    // One flat list keyed by event, not a list per day: a card dragged to
    // another day keeps its identity, and so its gesture.
    ZStack(alignment: .topLeading) {
      ForEach(pieces()) { piece in
        let item = piece.item
        let box = Self.box(for: item, column: column, dayHeight: dayHeight, laneLayout: laneLayout)
        let dragging = drag.draggingId == item.event.id
        let editable = data.canReschedule(item.event)
        EventCard(
          event: item.event,
          hue: Palette.event(data.colorKey(for: item.event)),
          time: timeText(item.event),
          size: box.size,
          lifted: dragging
        )
        .frame(width: box.width, height: box.height)
        .overlay {
          if editable {
            ResizeHandles(height: box.height) { mode in
              gesture(item.event, mode, geometry)
            }
          }
        }
        .gesture(gesture(item.event, .move, geometry), including: editable ? .all : .subviews)
        .pointerStyle(editable ? (dragging ? .grabActive : .grabIdle) : nil)
        .offset(x: CGFloat(piece.dayIndex) * column + box.minX, y: box.minY)
        .zIndex(dragging ? 900 : Double(10 + item.elevation))
      }
    }
    // The dragged card steps from snap to snap and the cards it passes make
    // room, briefly animated rather than jumping.
    .animation(.snappy(duration: 0.16), value: drag.overrides)
    #if DEBUG
      // `-QaliMove 2,1.5` picks up the page's first timed event three seconds
      // after launch, holds it two days on and 1.5 hours later for four
      // seconds, then drops it there, as a drag across the grid does.
      .task {
        let parts = (UserDefaults.standard.string(forKey: "QaliMove") ?? "")
          .split(separator: ",").compactMap { Double($0) }
        guard parts.count == 2 else { return }
        try? await Task.sleep(for: .seconds(3))
        guard let piece = pieces().first(where: { visible.contains($0.dayIndex) }) else { return }
        let box = Self.box(for: piece.item, column: column, dayHeight: dayHeight, laneLayout: laneLayout)
        let from = CGPoint(x: CGFloat(piece.dayIndex) * column + box.midX, y: box.midY)
        let to = CGPoint(x: from.x + parts[0] * column, y: from.y + parts[1] / 24 * dayHeight)
        drag.begin(piece.item.event, mode: .move, at: from, in: geometry)
        drag.move(to: to, in: geometry)
        try? await Task.sleep(for: .seconds(4))
        drag.end(at: to, in: geometry, save: { _, _ in }, failed: { _ in })
      }
    #endif
  }

  private func pieces() -> [Piece] {
    var seen: [String: Int] = [:]
    var pieces: [Piece] = []
    for (index, pair) in zip(days, timedByDay).enumerated() {
      let positioned = layoutDayEvents(
        pair.1,
        dayStartMs: pair.0.ms,
        tileMaxStaggerMs: laneLayout ? laneTileMaxStaggerMs : weekLaneTileMaxStaggerMs
      )
      for item in positioned {
        let number = seen[item.event.id, default: 0]
        seen[item.event.id] = number + 1
        pieces.append(Piece(id: "\(item.event.id)#\(number)", dayIndex: index, item: item))
      }
    }
    return pieces
  }

  /// A drag on a card (or one of its edges), in the strip's coordinates.
  /// Below the 4pt threshold it is a click, and the card's tap opens it.
  private func gesture(_ event: CalendarEvent, _ mode: EventDrag.Mode, _ geometry: EventDrag.Geometry) -> some Gesture {
    DragGesture(minimumDistance: 4, coordinateSpace: .named(EventDrag.space))
      .onChanged { value in
        drag.begin(event, mode: mode, at: value.startLocation, in: geometry)
        drag.move(to: value.location, in: geometry)
      }
      .onEnded { value in
        drag.end(
          at: value.location,
          in: geometry,
          save: { [data, navigation] event, times in
            try await data.updateEventTime(event, startMs: times.startMs, endMs: times.endMs, zone: navigation.zone)
          },
          failed: { [data] error in
            print("updateEventTime failed:", error)
            data.announce("Couldn't reschedule \(event.title).")
          }
        )
      }
  }

  /// The card's frame inside its day column (the web's `EventCard` geometry).
  private static func box(
    for item: PositionedEvent<CalendarEvent>,
    column: CGFloat,
    dayHeight: CGFloat,
    laneLayout: Bool
  ) -> CGRect {
    // A strip on the left of every column stays free, so there is always
    // somewhere to click to start a new event beside an existing one.
    let available = column - eventLeftGutter
    let x: CGFloat
    let width: CGFloat
    if laneLayout || item.laneAdvance == 1 {
      let lane = laneBox(
        columnIndex: item.columnIndex,
        columnCount: item.columnCount,
        columnSpan: item.columnSpan,
        advance: item.laneAdvance
      )
      x = eventLeftGutter + lane.left * available + 2
      width = lane.width * available - 4
    } else {
      let indent = stackIndent(item.stackIndex)
      x = eventLeftGutter + indent + 2
      width = available - indent - 4
    }
    return CGRect(
      x: x,
      y: item.topPct / 100 * dayHeight,
      width: max(width, 0),
      // Short events are drawn a little taller than their true length so the
      // title still reads, the trade every calendar makes.
      height: max(item.heightPct / 100 * dayHeight, 20)
    )
  }

  private func timeText(_ event: CalendarEvent) -> String {
    let zone = navigation.zone
    let start = zone.format(Date(ms: event.startMs), timePattern(use24h: navigation.use24h, withDayPeriod: false))
    let end = zone.format(Date(ms: event.endMs), timePattern(use24h: navigation.use24h))
    return "\(start) – \(end)"
  }
}

/// A timed event on the grid: tinted fill, the 3pt colour rail, title and
/// time. Like the web card, it sheds detail as it gets shorter: two title
/// lines, then one, then the title alone in small type.
private struct EventCard: View {
  let event: CalendarEvent
  let hue: Color
  let time: String
  let size: CGSize
  /// Being dragged: drawn raised, with the web's primary ring.
  var lifted = false

  private let shape = RoundedRectangle(cornerRadius: 9, style: .continuous)

  var body: some View {
    let height = size.height
    let compact = height <= 38
    VStack(alignment: .leading, spacing: 0) {
      Text(event.title)
        .font(.sans(compact ? TextSize.xs : TextSize.sm, .medium))
        // A second line only where it can break between words: in a narrow
        // tiled card it would split a word in the middle.
        .lineLimit(height > 52 && size.width >= 110 ? 2 : 1)
      if !compact {
        Text(time)
          .font(.sans(TextSize.xs))
          .foregroundStyle(Palette.mutedForeground)
          .lineLimit(1)
      }
      if height >= 80, event.conferenceUrl != nil {
        Spacer(minLength: 0)
        Image(systemName: "video")
          .font(.system(size: 11))
          .foregroundStyle(Palette.mutedForeground.opacity(0.6))
          .frame(maxWidth: .infinity, alignment: .trailing)
          .accessibilityLabel("Video call attached")
      }
    }
    .padding(.leading, 12)
    .padding(.trailing, 8)
    .padding(.vertical, compact ? 0 : 4)
    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: compact ? .leading : .topLeading)
    // The flash sits under the text, as on the web.
    .background { EventTint(hue: hue).revealFlash([event.id]) }
    .overlay(alignment: .leading) {
      Capsule().fill(hue).frame(width: 3).padding(.vertical, 4).padding(.leading, 4)
    }
    .clipShape(shape)
    .overlay { shape.strokeBorder(.primary.opacity(0.1)) }
    .overlay { if lifted { shape.strokeBorder(Palette.primary.opacity(0.6), lineWidth: 2) } }
    .shadow(color: .black.opacity(lifted ? 0.18 : 0.08), radius: lifted ? 8 : 1.5, y: lifted ? 4 : 1)
    .help("\(event.title)\n\(time)")
    .opensEvent(event)
    .accessibilityElement(children: .ignore)
    .accessibilityLabel("\(event.title), \(time)")
  }
}

/// The top and bottom edges of an editable card, which stretch it instead
/// of moving it (the web's `data-resize-top`/`-bottom` strips).
private struct ResizeHandles<G: Gesture>: View {
  let height: CGFloat
  let gesture: (EventDrag.Mode) -> G

  var body: some View {
    // Thin enough on a short card to leave the middle for moving it.
    let edge = min(6, height / 4)
    VStack(spacing: 0) {
      handle(.resizeStart, edge)
      Spacer(minLength: 0)
      handle(.resizeEnd, edge)
    }
  }

  private func handle(_ mode: EventDrag.Mode, _ edge: CGFloat) -> some View {
    Color.clear
      .frame(height: edge)
      .contentShape(.rect)
      .gesture(gesture(mode))
      .pointerStyle(.rowResize)
  }
}

// MARK: - Creating

/// A new event's range while it is being drawn: which column and the span,
/// fixed to the day the drag started on.
@Observable
private final class GridDrawing {
  struct Range: Equatable {
    var dayStartMs: Double
    var startMs: Double
    var endMs: Double
  }

  var range: Range?
  /// Where the drag set out: its day and the snapped time under the press.
  @ObservationIgnored var anchor: (dayStartMs: Double, ms: Double)?
}

/// Snaps a point in a day column to the grid's quarter hours.
private func snappedMs(y: CGFloat, dayStartMs: Double, dayHeight: CGFloat) -> Double {
  let steps = (Double(y / max(dayHeight, 1)) * (24 * 60 / snapMinutes)).rounded()
  return min(max(dayStartMs + steps * snapMs, dayStartMs), dayStartMs + msPerDay)
}

/// The empty grid under the cards: a drag down a day column draws a range
/// and opens the create form on it, as on the web. A plain click makes
/// nothing, and sideways movement belongs to the trackpad, not to this.
private struct CreateDragLayer: View {
  let days: [Date]
  /// The page's first day on the strip.
  let firstVisible: Int
  let column: CGFloat
  let dayHeight: CGFloat
  let drawing: GridDrawing

  @Environment(Island.self) private var island

  var body: some View {
    Color.clear
      .contentShape(.rect)
      .gesture(
        DragGesture(minimumDistance: 4)
          .onChanged { value in
            if drawing.anchor == nil {
              let index = Int(value.startLocation.x / max(column, 1))
              guard days.indices.contains(index) else { return }
              let dayStart = days[index].ms
              let pressed = snappedMs(y: value.startLocation.y, dayStartMs: dayStart, dayHeight: dayHeight)
              // A press at the very bottom still leaves room for a range.
              drawing.anchor = (dayStart, min(pressed, dayStart + msPerDay - snapMs))
            }
            guard let anchor = drawing.anchor else { return }
            let cursor = snappedMs(y: value.location.y, dayStartMs: anchor.dayStartMs, dayHeight: dayHeight)
            let start = min(anchor.ms, cursor)
            let end = min(max(max(anchor.ms, cursor), start + snapMs), anchor.dayStartMs + msPerDay)
            let next = GridDrawing.Range(dayStartMs: anchor.dayStartMs, startMs: start, endMs: end)
            if drawing.range != next { drawing.range = next }
          }
          .onEnded { _ in finish() }
      )
      .accessibilityHidden(true)
      #if DEBUG
        // `-QaliDraw 3,14,16` draws 14:00–16:00 on the page's fourth day three
        // seconds after launch, then lets go, as a drag down the grid does.
        .task {
          let parts = (UserDefaults.standard.string(forKey: "QaliDraw") ?? "")
            .split(separator: ",").compactMap { Double($0) }
          guard parts.count == 3 else { return }
          try? await Task.sleep(for: .seconds(3))
          let dayStart = days[firstVisible + Int(parts[0])].ms
          drawing.anchor = (dayStart, dayStart + parts[1] * msPerHour)
          drawing.range = .init(dayStartMs: dayStart, startMs: dayStart + parts[1] * msPerHour, endMs: dayStart + parts[2] * msPerHour)
          try? await Task.sleep(for: .seconds(1))
          finish()
        }
      #endif
  }

  /// Hands the drawn range to the create form. The form opens first and the
  /// drawn range is cleared after, so the ghost never has a frame with
  /// neither: `Island.open` animates, which renders whatever is pending
  /// first, and a gap there removes the ghost and re-inserts it, which could
  /// leave it gone.
  private func finish() {
    drawing.anchor = nil
    if let range = drawing.range {
      island.openCreate(startMs: range.startMs, endMs: range.endMs)
    }
    drawing.range = nil
  }
}

/// A new event's dashed outline (the web's `GhostEvent`), on the hours or
/// in the all-day band.
private struct GhostPiece: View {
  let label: String
  var cornerRadius: CGFloat = 7

  var body: some View {
    let shape = RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
    Text(label)
      .font(.sans(TextSize.xs, .medium))
      .foregroundStyle(Palette.primary)
      .lineLimit(1)
      .padding(.horizontal, 8)
      .padding(.vertical, 3)
      .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
      .background(Palette.primary.opacity(0.1), in: shape)
      .overlay { shape.strokeBorder(Palette.primary.opacity(0.4), style: StrokeStyle(lineWidth: 1, dash: [4, 3])) }
      .clipShape(shape)
  }
}

/// The new event's outline on the grid (the web's `GhostEvent`): the range
/// being drawn, then the create form's times, followed as they are edited.
private struct CreateGhost: View {
  let days: [Date]
  let column: CGFloat
  let dayHeight: CGFloat
  let drawing: GridDrawing
  let navigation: CalendarNavigation
  /// Scrolls the hours so the ghost's first piece (in strip coordinates)
  /// clears the island.
  let reveal: (CGRect, CGRect) -> Void

  @Environment(Island.self) private var island

  var body: some View {
    let range: (start: Double, end: Double)? =
      if let drawn = drawing.range {
        (drawn.startMs, drawn.endMs)
      } else if let draft = island.ghostDraft, !draft.allDay, draft.isValid {
        (draft.startMs, draft.endMs)
      } else {
        nil
      }
    ZStack(alignment: .topLeading) {
      if let range {
        // A timed range past midnight shows a piece in each day it covers.
        ForEach(Array(days.enumerated()), id: \.element) { index, day in
          let dayStart = day.ms
          let dayEnd = navigation.zone.addingDays(1, to: day).ms
          let start = max(range.start, dayStart)
          let end = min(range.end, dayEnd)
          if end > start {
            GhostPiece(label: label(range.start, range.end, pending: drawing.range == nil))
              .frame(
                width: max(column - 8, 0),
                height: max(CGFloat((end - start) / msPerDay) * dayHeight, 14)
              )
              .offset(
                x: CGFloat(index) * column + 4,
                y: CGFloat((start - dayStart) / msPerDay) * dayHeight
              )
          }
        }
      }
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    .zIndex(1000)
    .allowsHitTesting(false)
    .accessibilityHidden(true)
    .animation(.snappy(duration: 0.18), value: range.map { [$0.start, $0.end] })
    .onChange(of: lead(range)) { revealIfCovered(range) }
    .onChange(of: island.shellFrame) { revealIfCovered(range) }
  }

  /// The ghost's first piece in strip coordinates. Computed, not measured:
  /// a measured frame leaves out the offsets the pieces are placed with.
  private func lead(_ range: (start: Double, end: Double)?) -> CGRect? {
    guard let range else { return nil }
    let zone = navigation.zone
    guard let index = days.firstIndex(where: { range.start >= $0.ms && range.start < zone.addingDays(1, to: $0).ms })
    else { return nil }
    let dayStart = days[index].ms
    let end = min(range.end, zone.addingDays(1, to: days[index]).ms)
    return CGRect(
      x: CGFloat(index) * column + 4,
      y: CGFloat((range.start - dayStart) / msPerDay) * dayHeight,
      width: max(column - 8, 0),
      height: CGFloat((end - range.start) / msPerDay) * dayHeight
    )
  }

  /// The create form opens over the bottom of the grid: when it covers the
  /// event being created, the hours scroll it into the clear above.
  private func revealIfCovered(_ range: (start: Double, end: Double)?) {
    guard island.view?.holdsDraft == true, drawing.range == nil, let lead = lead(range) else { return }
    reveal(lead, island.shellFrame)
  }

  /// "9:00 – 9:30 AM" while drawing; the title once the form has one.
  private func label(_ start: Double, _ end: Double, pending: Bool) -> String {
    if pending, let title = island.draft?.summary.trimmingCharacters(in: .whitespaces), !title.isEmpty {
      return title
    }
    let zone = navigation.zone
    let use24h = navigation.use24h
    return "\(zone.format(Date(ms: start), timePattern(use24h: use24h, withDayPeriod: false))) – \(zone.format(Date(ms: end), timePattern(use24h: use24h)))"
  }
}

