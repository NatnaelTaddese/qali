//! The signed-in home (direction C): the toolbar, then the page for the current view. Day and
//! week draw the same strip (`time-strip.tsx`) with one or seven columns; month draws the 6×7
//! grid (`month-panel.tsx`). Pages slide in from the side the user travelled toward while the
//! old one fades, a two-finger horizontal swipe turns the page, and changing view blurs across.

use std::time::{Duration as StdDuration, Instant};

use std::rc::Rc;

use chrono::{Duration, NaiveDate};
use rune::{Cx, Edge, El, GesturePhase, ScrollSpec, Transition, WheelEvent, col, el, row, text};

use super::day_column::day_column;
use super::gutter::{gutter_body, gutter_header};
use super::month_view::month_view;
use super::panel_header::panel_header;
use super::toolbar::{self, toolbar};
use super::{BOTTOM_SPACER, DAY_H, EVENT_LEFT_GUTTER, GUTTER_W, HEADER_DATE_H, HOUR_H, SCROLL_KEY, clock};
use crate::app::State;
use crate::data::days::{start_of_day_ms, working_zone};
use crate::data::page::{self, View};
use crate::data::week::{self, ALLDAY_COLLAPSED_LANES, DAY_TILE_MAX_STAGGER_MS, WEEK_TILE_MAX_STAGGER_MS};
use crate::data::colors;
use crate::data::models::CalendarEvent;
use crate::data::permissions::capabilities;
use crate::ui::components::{Elevation, EventCard};
use crate::ui::theme::{self, Paint, fade, rem};

/// How far down the viewport the now line lands when the week opens (the web's 35%).
pub const NOW_SCROLL_FRACTION: f32 = 0.35;
/// Horizontal trackpad travel that turns the page, and the pause before the next swipe counts,
/// so a fling's momentum doesn't turn several pages.
const SWIPE_PAGE: f32 = 90.0;
const SWIPE_COOLDOWN: StdDuration = StdDuration::from_millis(450);

pub fn home(s: &State, p: &Paint, cx: &mut Cx<State>, leading: f32, window: [f32; 2]) -> El {
    let body = match s.view {
        View::Day | View::Week => strip(s, p, cx, window),
        View::Month => month(s, p, cx, window),
    };
    col()
        .key("home")
        .w_full()
        .h_full()
        .fill(p.background)
        .child(toolbar(s, p, leading))
        .child(
            col()
                .key(format!("view-{}", s.view.label()))
                .w_full()
                .grow(1.0)
                .min_h(0.0)
                .on_wheel(swipe)
                // A click on the calendar that no event or day claims closes an open panel. It's
                // not a control of its own, so assistive tech skips it to the calendar inside.
                .role("none")
                .on_press(|s: &mut State| s.close_island())
                .child(body)
                .transition(Transition::blur_replace()),
        )
        .child(crate::ui::island::island(s, p, cx))
}

/// The incoming page slides in from the side travel went toward and fades in; the outgoing one
/// only fades, so a page that leaves after a change of direction never slides the wrong way.
fn page_transition(dir: i8) -> Transition {
    let edge = if dir < 0 { Edge::Leading } else { Edge::Trailing };
    Transition::asymmetric(Transition::push(edge), Transition::opacity())
}

/// Two-finger horizontal swipes turn the page; vertical scrolling is left to the scroll view.
fn swipe(s: &mut State, e: WheelEvent, _: &mut rune::Tx) -> bool {
    if e.dx.abs() <= e.dy.abs() {
        return false;
    }
    if s.swipe_resume.is_some_and(|t| Instant::now() < t) {
        return true;
    }
    if e.phase == GesturePhase::Began {
        s.swipe = 0.0;
    }
    s.swipe += e.dx;
    if s.swipe.abs() >= SWIPE_PAGE {
        // Content follows the fingers: swiping left (negative dx) brings in the next page.
        s.step(if s.swipe < 0.0 { 1 } else { -1 });
        s.swipe = 0.0;
        s.swipe_resume = Some(Instant::now() + SWIPE_COOLDOWN);
    }
    true
}

fn strip(s: &State, p: &Paint, cx: &mut Cx<State>, window: [f32; 2]) -> El {
    let zone = working_zone(s.prefs.time_zone.as_deref());
    let use_24h = s.prefs.use_24h();
    let start = s.page_start();
    let days = page::page_days(s.view, start, s.prefs.week_starts_on());
    let today_date = s.today();
    let today = days.iter().position(|d| *d == today_date);
    let (now_top, _) = week::now_layout(&days, s.now_ms, zone);
    let lanes = s.view == View::Day;
    let page_key = format!("page-{start}");

    // Equal day columns: the strip right of the gutter, split between the page's days. Before
    // the first layout the window's own width stands in.
    let strip_w = cx.layout_size("strip-days").map_or(window[0] - GUTTER_W, |[w, _]| w);
    let col_w = (strip_w / days.len() as f32).max(1.0);

    let events = s.shown_events();
    let (all_day, timed) = week::bucket(&days, zone, &events);
    let all_day = week::layout_all_day(&days, &all_day);
    let lane_count = all_day.iter().map(|a| a.lane + 1).max().unwrap_or(0);
    let hidden = all_day.iter().filter(|a| a.lane >= ALLDAY_COLLAPSED_LANES).count();
    let all_day_h = week::all_day_band_height(lane_count, s.all_day_expanded);

    let header = row()
        .key("strip-header")
        .w_full()
        .child(gutter_header(p, &zone_label(zone), HEADER_DATE_H + all_day_h, hidden, s.all_day_expanded))
        .child(
            el().key("strip-header-days").grow(1.0).min_w(0.0).h(HEADER_DATE_H + all_day_h).clip_rounded(0.0).child(
                panel_header(p, &days, today, &all_day, all_day_h, s.all_day_expanded, &s.calendar_colors, col_w)
                    .key(page_key.clone())
                    .transition(page_transition(s.page_dir)),
            ),
        );

    let mut columns = row().key(page_key).h(DAY_H);
    // Every day's start and the midnight after the last, for dragging across the page.
    let day_starts: Rc<Vec<f64>> = Rc::new(days.iter().map(|d| start_of_day_ms(*d, zone)).chain([start_of_day_ms(*days.last().unwrap() + Duration::days(1), zone)]).collect());
    let editable = |e: &CalendarEvent| {
        let calendar = s.calendars.iter().find(|c| Some(&c.id) == e.local_calendar_id.as_ref());
        e.user_id.is_some() && capabilities(e, calendar).can_edit
    };
    let dragging = s.drag.as_ref().filter(|d| d.moved).map(|d| d.grip.event_id.as_str());
    for (i, day) in days.iter().enumerate() {
        let (day_start, day_end) = (day_starts[i], day_starts[i + 1]);
        let stagger = if lanes { DAY_TILE_MAX_STAGGER_MS } else { WEEK_TILE_MAX_STAGGER_MS };
        let positioned = week::layout_day(&timed[i], day_start, day_end, stagger);
        columns = columns.child(day_column(
            p,
            format!("day-{day}"),
            &positioned,
            &s.calendar_colors,
            col_w,
            today == Some(i),
            lanes,
            zone,
            use_24h,
            Some((day_starts.clone(), i)),
            &editable,
            dragging,
        ));
    }
    if let Some(ghost) = drag_ghost(s, p, &day_starts, col_w, zone, use_24h) {
        columns = columns.child(ghost);
    }
    // `NowIndicator`: a faint line across the page, bright over today's column.
    if let Some(i) = today {
        let y = now_top * DAY_H;
        columns = columns
            .child(el().key("now-faint").h(1.0).fill(fade(p.now, 0.25)).pin(Some(0.0), Some(y - 0.5), Some(0.0), None))
            .child(el().key("now-today").w(col_w).h(2.0).fill(p.now).absolute(i as f32 * col_w, y - 1.0));
    }

    let mut grid = el().key("strip-days").grow(1.0).min_w(0.0).h(DAY_H).clip_rounded(0.0);
    // Hour rules (`color-mix(in oklab, var(--border) 55%, transparent)`), behind the page.
    let rule = fade(p.border, 0.55);
    for hour in 0..24 {
        grid = grid.child(el().key(format!("rule-{hour}")).h(1.0).fill(rule).pin(Some(0.0), Some(hour as f32 * HOUR_H), Some(0.0), None));
    }
    grid = grid.child(columns.transition(page_transition(s.page_dir)));

    let now_pill = today.map(|_| (now_top, clock(s.now_ms, zone, use_24h, false)));
    let hours = col()
        .key("hours")
        .w_full()
        .child(row().key("hours-row").w_full().child(gutter_body(p, use_24h, now_pill)).child(grid))
        .child(el().key("bottom-spacer").w_full().h(BOTTOM_SPACER));
    let body = hours
        .scroll(ScrollSpec { stick_bottom: false })
        .key(SCROLL_KEY)
        .grow(1.0)
        .shrink()
        .min_h(0.0)
        .on_layout(|s: &mut State, r: [f32; 4]| s.hours_h = r[3]);

    col().key("strip").w_full().h_full().child(header).child(body)
}

fn month(s: &State, p: &Paint, cx: &mut Cx<State>, window: [f32; 2]) -> El {
    let zone = working_zone(s.prefs.time_zone.as_deref());
    let start = s.page_start();
    let days = page::page_days(View::Month, start, s.prefs.week_starts_on());
    let size = cx.layout_size("month-page").unwrap_or([window[0], window[1] - toolbar::HEIGHT]);
    el().key("month-page").w_full().h_full().clip_rounded(0.0).child(
        month_view(p, start, &days, s.today(), zone, &s.shown_events(), &s.calendar_colors, size)
            .key(format!("month-{start}"))
            .transition(page_transition(s.page_dir)),
    )
}

/// Where to scroll so the now line sits `NOW_SCROLL_FRACTION` down a viewport this tall.
pub fn now_scroll_y(s: &State, viewport_h: f32) -> f32 {
    let zone = working_zone(s.prefs.time_zone.as_deref());
    let days: Vec<NaiveDate> = vec![s.today()];
    let (top, _) = week::now_layout(&days, s.now_ms, zone);
    (top * DAY_H - viewport_h * NOW_SCROLL_FRACTION).clamp(0.0, DAY_H + BOTTOM_SPACER)
}

/// `zoneShortLabel`: the last part of the IANA name, underscores as spaces.
fn zone_label(zone: chrono_tz::Tz) -> String {
    zone.name().rsplit('/').next().unwrap_or(zone.name()).replace('_', " ")
}

/// Where a dragged event would land: its card at the new time, lifted, with the web's
/// `ring-2 ring-primary/60`, over the page.
fn drag_ghost(s: &State, p: &Paint, day_starts: &[f64], col_w: f32, zone: chrono_tz::Tz, use_24h: bool) -> Option<El> {
    let drag = s.drag.as_ref().filter(|d| d.moved)?;
    let event = s.events.iter().find(|e| e.id == drag.grip.event_id)?;
    let column = day_starts.windows(2).position(|w| drag.start_ms >= w[0] && drag.start_ms < w[1])?;
    let (day_start, day_end) = (day_starts[column], day_starts[column + 1]);
    let day = (day_end - day_start) as f32;
    let top = (drag.start_ms - day_start) as f32 / day * DAY_H;
    let height = ((drag.end_ms.min(day_end) - drag.start_ms) as f32 / day * DAY_H).max(20.0);
    let hue = theme::event_color(colors::event_swatch(event, &s.calendar_colors));
    let when = format!("{} – {}", clock(drag.start_ms, zone, use_24h, false), clock(drag.end_ms, zone, use_24h, true));
    let body = col()
        .key("ghost-body")
        .w_full()
        .h_full()
        .pt(rem(0.25))
        .pr(rem(0.5))
        .pl(rem(0.75))
        .child(text(event.title().to_string()).font(theme::TEXT_SM_MEDIUM).color(p.foreground).max_lines(1))
        .child(text(when).key("ghost-time").font(theme::TEXT_XS).color(p.muted_foreground).truncate());
    let left = EVENT_LEFT_GUTTER + 2.0;
    Some(
        EventCard::new("drag-ghost", hue)
            .radius(theme::RADIUS_LG)
            .pill_inset(rem(0.25))
            .elevation(Elevation::Lg)
            .build(p, body)
            .outline(2.0, 0.0, fade(p.primary, 0.6))
            .w(col_w - left - 4.0)
            .h(height)
            .absolute(column as f32 * col_w + left, top),
    )
}
