//! The form's When section (`calendar/event-form.tsx`): Starts and Ends tabs, the selected
//! side's day ("Starts on" / "Ends on") opening a month day picker above it, the hour,
//! minute and AM/PM wheels under that, and the All day switch. Turning a wheel sets the time
//! as it goes; a later start drags the end along; an end before the start is flagged.

use chrono::{Datelike, Days, Months, NaiveDate};
use rune::tok::motion;
use rune::{Align, Cursor, El, Side, Tx, col, icon, row, text};

use super::event_create::setting_row;
use crate::app::{Draft, State, WheelId, WheelMotion};
use crate::data::days::{today, working_zone};
use crate::data::draft as steps;
use crate::data::wheel::{self, ITEM_H, Settle, WHEEL_SETTLE_MS};
use crate::ui::components::icons_gen::{ARROW_DOWN_01, ARROW_UP_01, CALENDAR_03, SUN_03};
use crate::ui::components::switch::switch;
use crate::ui::components::wheel_picker::wheel_picker;
use crate::ui::theme::{self, Paint, black, fade, rem};

/// The keyboard's and the wheel snap's glide (`glide(…, 240, easeOutBack)`).
const GLIDE_MS: f64 = 240.0;
/// Rows per point of trackpad travel (`WHEEL_SENS`).
const WHEEL_SENS: f32 = 0.012;
/// How far past either end a drag gives (the web's 0.3 rubber band).
const RUBBER: f32 = 0.3;
const DAY_KEY: &str = "draft-day-button";
const CELL: f32 = rem(2.0);

pub fn when(s: &State, p: &Paint, draft: &Draft) -> El {
    let zone = working_zone(s.prefs.time_zone.as_deref());
    let use_24h = s.prefs.use_24h();
    let tab = |key: &'static str, label: &str, ms: f64, end: bool| {
        let active = draft.editing_end == end;
        let day_ms = if draft.all_day && end { steps::last_day_ms(draft.start_ms, draft.end_ms) } else { ms };
        let day = steps::day_of(day_ms, day_ms, false, draft.all_day, zone);
        let value = if draft.all_day { "All day".to_string() } else { crate::ui::calendar::clock(ms, zone, use_24h, true) };
        col()
            .key(key)
            .role("button")
            .label(format!("{label} {value}"))
            .checked(active)
            .focusable(true)
            .grow(1.0)
            .min_w(0.0)
            .px(rem(0.75))
            .py(rem(0.375))
            .radius(theme::RADIUS_LG)
            .fill(if active { p.background } else { rune::Color::TRANSPARENT })
            .shadow(1.0, 2.0, black(if active { 0.08 } else { 0.0 }))
            .motion(motion::SNAPPY)
            .press_scale(0.98)
            .cursor(Cursor::Pointer)
            .child(text(format!("{label} · {}", day.format("%a %-d"))).font(rune::tok::TextStyle::new(rem(0.75), 500.0)).color(p.muted_foreground).truncate())
            .child(text(value).font(rune::tok::TextStyle::new(rem(0.875), 600.0)).color(if active { p.foreground } else { p.muted_foreground }))
            .on_press(move |s: &mut State| {
                s.wheel = None;
                if let Some(d) = s.draft.as_mut() {
                    d.editing_end = end;
                    d.picking_day = None;
                }
            })
    };
    // `flex gap-1 rounded-xl bg-muted p-1`.
    let tabs = row()
        .key("draft-tabs")
        .w_full()
        .gap(rem(0.25))
        .padding(rem(0.25))
        .radius(theme::RADIUS_XL)
        .fill(fade(p.foreground, 0.05))
        .child(tab("tab-start", "Starts", draft.start_ms, false))
        .child(tab("tab-end", "Ends", draft.end_ms, true));

    let day = steps::day_of(draft.start_ms, draft.end_ms, draft.editing_end, draft.all_day, zone);
    let open = draft.picking_day.is_some();
    let day_button = row()
        .key(DAY_KEY)
        .role("button")
        .label("Pick a day")
        .focusable(true)
        .px(rem(0.5))
        .py(rem(0.25))
        .radius(theme::RADIUS_LG)
        .fill(if open { p.accent } else { rune::Color::TRANSPARENT })
        .hover(p.accent)
        .cursor(Cursor::Pointer)
        .child(text(day.format("%a, %b %-d, %Y").to_string()).font(theme::TEXT_SM_MEDIUM).color(p.foreground))
        .on_press(move |s: &mut State| {
            if let Some(d) = s.draft.as_mut() {
                d.picking_day = if d.picking_day.is_some() { None } else { Some(day.with_day(1).unwrap_or(day)) };
                d.menu = None;
            }
        });
    let day_row = setting_row(p, "draft-day", &CALENDAR_03, if draft.editing_end { "Ends on" } else { "Starts on" }, day_button);

    let mut section = col().key("draft-when").w_full().gap(rem(0.5)).child(tabs).child(day_row);
    if !draft.all_day {
        section = section.child(wheels(s, p, draft, use_24h));
    }
    let all_day = row()
        .key("draft-all-day")
        .role("switch")
        .label("All day")
        .checked(draft.all_day)
        .focusable(true)
        .cursor(Cursor::Pointer)
        .child(switch(p, "draft-all-day-switch", draft.all_day))
        .on_press(|s: &mut State| {
            let zone = working_zone(s.prefs.time_zone.as_deref());
            s.wheel = None;
            if let Some(d) = s.draft.as_mut() {
                (d.start_ms, d.end_ms) = if d.all_day { steps::to_timed(d.start_ms, zone) } else { steps::to_all_day(d.start_ms, d.end_ms, zone) };
                d.all_day = !d.all_day;
            }
        });
    section = section.child(setting_row(p, "draft-all-day-row", &SUN_03, "All day", all_day));
    if !draft.all_day && draft.end_ms <= draft.start_ms {
        section = section.child(text("End time must be after the start.").key("draft-invalid").font(theme::TEXT_XS).color(p.destructive));
    }
    section
}

fn wheel_rows(id: WheelId, use_24h: bool) -> Vec<String> {
    match id {
        WheelId::Hour => steps::hour_labels(use_24h),
        WheelId::Minute => steps::minute_labels(),
        WheelId::Meridiem => steps::MERIDIEM.iter().map(|m| m.to_string()).collect(),
    }
}

fn slot(id: WheelId) -> usize {
    match id {
        WheelId::Hour => 0,
        WheelId::Minute => 1,
        WheelId::Meridiem => 2,
    }
}

fn wheels(s: &State, p: &Paint, draft: &Draft, use_24h: bool) -> El {
    let zone = working_zone(s.prefs.time_zone.as_deref());
    let active = if draft.editing_end { draft.end_ms } else { draft.start_ms };
    let parts = steps::parts_of(active, use_24h, zone);
    let mut ids = vec![(WheelId::Hour, "draft-hour", "Hour"), (WheelId::Minute, "draft-minute", "Minute")];
    if !use_24h {
        ids.push((WheelId::Meridiem, "draft-meridiem", "AM or PM"));
    }
    let mut out = row().key("draft-wheels").w_full().gap(rem(0.5));
    for (id, key, label) in ids {
        let rows = wheel_rows(id, use_24h);
        let scroll = s.wheel.as_ref().filter(|w| w.id == id).map_or(parts[slot(id)] as f32, |w| w.scroll);
        out = out.child(turnable(wheel_picker(p, key, label, &rows, scroll), id, rows.len() - 1));
    }
    out
}

/// The time the wheels show, set from wheel `id` resting on row `index`.
fn emit(s: &mut State, id: WheelId, index: usize) {
    let zone = working_zone(s.prefs.time_zone.as_deref());
    let use_24h = s.prefs.use_24h();
    let Some(d) = s.draft.as_mut() else { return };
    let active = if d.editing_end { d.end_ms } else { d.start_ms };
    let mut parts = steps::parts_of(active, use_24h, zone);
    if parts[slot(id)] == index {
        return;
    }
    parts[slot(id)] = index;
    let next = steps::with_parts(active, parts, use_24h, zone);
    (d.start_ms, d.end_ms) = steps::set_time(d.start_ms, d.end_ms, d.editing_end, next);
}

fn rest(s: &State, id: WheelId) -> f32 {
    let zone = working_zone(s.prefs.time_zone.as_deref());
    let Some(d) = s.draft.as_ref() else { return 0.0 };
    let active = if d.editing_end { d.end_ms } else { d.start_ms };
    steps::parts_of(active, s.prefs.use_24h(), zone)[slot(id)] as f32
}

/// Where the wheel is now: in motion, or resting on its value.
fn position(s: &State, id: WheelId) -> f32 {
    s.wheel.as_ref().filter(|w| w.id == id).map_or_else(|| rest(s, id), |w| w.scroll)
}

fn glide(s: &mut State, id: WheelId, to: usize, tx: &mut Tx) {
    let from = position(s, id);
    s.wheel = Some(WheelMotion { id, scroll: from, grab: None, samples: Vec::new(), settle: Some(Settle { from, to, start: s.clock, duration_ms: GLIDE_MS }), snap_at: None });
    tx.wake_after(std::time::Duration::ZERO);
}

/// Drag (with a flick's momentum), trackpad and arrow keys turn the drum.
fn turnable(drum: El, id: WheelId, last: usize) -> El {
    drum.on_drag(move |s: &mut State, d: &mut rune::Drag, tx: &mut Tx| match d.phase {
        rune::Phase::Down => {
            let at = position(s, id);
            s.wheel = Some(WheelMotion { id, scroll: at, grab: Some(at), samples: vec![(s.clock, at)], settle: None, snap_at: None });
        }
        rune::Phase::Move => {
            let clock = s.clock;
            let Some(w) = s.wheel.as_mut().filter(|w| w.id == id) else { return };
            let Some(grab) = w.grab else { return };
            // Dragging up brings later rows into the band.
            let mut next = grab - d.dy / ITEM_H;
            if next < 0.0 {
                next *= RUBBER;
            } else if next > last as f32 {
                next = last as f32 + (next - last as f32) * RUBBER;
            }
            w.scroll = next;
            w.samples.push((clock, next));
            if w.samples.len() > 8 {
                w.samples.remove(0);
            }
            emit(s, id, next.round().clamp(0.0, last as f32) as usize);
        }
        rune::Phase::Up => {
            let clock = s.clock;
            let Some(w) = s.wheel.as_mut().filter(|w| w.id == id) else { return };
            w.grab = None;
            let velocity = if d.cancelled() { 0.0 } else { wheel::velocity(&w.samples, clock) };
            w.settle = Some(wheel::fling(w.scroll, velocity, last, clock));
            tx.wake_after(std::time::Duration::ZERO);
        }
    })
    .on_wheel(move |s: &mut State, e: rune::WheelEvent, tx: &mut Tx| {
        if e.dy == 0.0 {
            return true;
        }
        let at = position(s, id);
        // Natural scrolling: fingers moving up bring later rows in; a notched wheel steps a row.
        let next = if e.precise { at - e.dy * WHEEL_SENS } else { at - e.dy.signum() };
        let next = next.clamp(0.0, last as f32);
        s.wheel = Some(WheelMotion { id, scroll: next, grab: None, samples: Vec::new(), settle: None, snap_at: Some(s.clock + WHEEL_SETTLE_MS / 1000.0) });
        emit(s, id, next.round() as usize);
        tx.instant();
        tx.wake_after(std::time::Duration::from_millis(WHEEL_SETTLE_MS as u64));
        true
    })
    .on_key(move |s: &mut State, e: &rune::KeyEvent, tx: &mut Tx| {
        let at = position(s, id).round() as i64;
        let to = match e.key {
            rune::Key::Up => at - 1,
            rune::Key::Down => at + 1,
            rune::Key::Home => 0,
            rune::Key::End => last as i64,
            _ => return false,
        };
        glide(s, id, to.clamp(0, last as i64) as usize, tx);
        true
    })
}

/// Called from `poll`: move a flung or snapping wheel along, and land it. Frames it drives
/// are instant, since the drum's rows are placed from the position directly.
pub fn step_wheel(s: &mut State, now: f64, tx: &mut Tx) -> bool {
    let Some(w) = s.wheel.as_mut() else { return false };
    let id = w.id;
    if w.settle.is_none() && w.grab.is_none() && w.snap_at.is_some_and(|at| now >= at) {
        let last = (wheel_rows(id, s.prefs.use_24h()).len() - 1) as f32;
        let to = w.scroll.round().clamp(0.0, last) as usize;
        w.settle = Some(Settle { from: w.scroll, to, start: now, duration_ms: GLIDE_MS });
        w.snap_at = None;
    }
    let Some(settle) = w.settle else { return false };
    let (at, done) = settle.at(now);
    w.scroll = at;
    let index = if done { settle.to } else { at.round().max(0.0) as usize };
    let last = wheel_rows(id, s.prefs.use_24h()).len() - 1;
    if done {
        s.wheel = None;
    } else {
        tx.wake_after(std::time::Duration::from_millis(16));
    }
    emit(s, id, index.min(last));
    tx.instant();
    true
}

/// The day picker (`DayPicker`): a month of days above the day button, the selected one
/// filled, today in the primary colour; the end can't go before the start's day. Picking a
/// day closes it, as does a click outside or Escape. Attached at the window's root, so the
/// island's clipping doesn't cut it.
pub fn day_picker(s: &State, p: &Paint) -> Option<El> {
    let draft = s.draft.as_ref().filter(|_| s.island == crate::app::Island::Create)?;
    let month = draft.picking_day?;
    let zone = working_zone(s.prefs.time_zone.as_deref());
    let selected = steps::day_of(draft.start_ms, draft.end_ms, draft.editing_end, draft.all_day, zone);
    let min = draft.editing_end.then(|| steps::day_of(draft.start_ms, draft.end_ms, false, draft.all_day, zone));
    let today = today(s.now_ms, zone);
    let week_start = s.prefs.week_starts_on();
    let first = crate::data::week::week_start(month, week_start);

    let nav = |key: &'static str, label: &'static str, glyph: &'static rune::Icon, months: i32| {
        row()
            .key(key)
            .role("button")
            .label(label)
            .focusable(true)
            .size(rem(1.5), rem(1.5))
            .center()
            .radius(theme::RADIUS_LG - 2.0)
            .hover(p.accent)
            .cursor(Cursor::Pointer)
            .child(icon(glyph, rem(1.0)).color(p.muted_foreground))
            .on_press(move |s: &mut State| {
                if let Some(d) = s.draft.as_mut().and_then(|d| d.picking_day.as_mut()) {
                    *d = if months < 0 { d.checked_sub_months(Months::new(1)) } else { d.checked_add_months(Months::new(1)) }.unwrap_or(*d);
                }
            })
    };
    let header = row()
        .key("month-header")
        .w_full()
        .center_y()
        .justify_between()
        .gap(rem(1.0))
        .px(rem(0.25))
        .pb(rem(0.5))
        .child(text(month.format("%B %Y").to_string()).font(rune::tok::TextStyle::new(rem(0.875), 600.0)).color(p.foreground))
        .child(row().key("month-nav").gap(rem(0.25)).child(nav("prev-month", "Previous month", &ARROW_UP_01, -1)).child(nav("next-month", "Next month", &ARROW_DOWN_01, 1)));

    let mut grid = col().key("day-grid").gap(rem(0.25));
    let mut letters = row().key("weekdays");
    for i in 0..7u64 {
        let d = first.checked_add_days(Days::new(i)).unwrap_or(first);
        let letter = d.format("%a").to_string().chars().next().unwrap_or(' ').to_string();
        letters = letters.child(row().key(format!("wd-{i}")).size(CELL, CELL).center().child(text(letter).font(rune::tok::TextStyle::new(rem(0.75), 500.0)).color(p.muted_foreground)));
    }
    grid = grid.child(letters);
    let mut day = first;
    // Whole weeks from the one holding the 1st through the one holding the month's end.
    let next_month = month.checked_add_months(Months::new(1)).unwrap_or(month);
    while day < next_month {
        let mut week = row().key(format!("week-{day}"));
        for _ in 0..7 {
            week = week.child(day_cell(p, day, month, selected, today, min));
            day = day.succ_opt().unwrap_or(day);
        }
        grid = grid.child(week);
    }

    Some(
        col()
            .key("day-picker")
            .role("dialog")
            .label("Pick a day")
            .padding(rem(0.75))
            .radius(rem(1.0))
            .fill(p.card)
            .border(1.0, p.border)
            .shadow(10.0, 30.0, black(if p.dark { 0.45 } else { 0.18 }))
            .child(header)
            .child(grid)
            .anchored(DAY_KEY, Side::Top, Align::Start, 8.0)
            .modal(true, |s: &mut State| {
                if let Some(d) = s.draft.as_mut() {
                    d.picking_day = None;
                }
            }),
    )
}

fn day_cell(p: &Paint, day: NaiveDate, month: NaiveDate, selected: NaiveDate, today: NaiveDate, min: Option<NaiveDate>) -> El {
    let in_month = day.month() == month.month();
    let is_selected = day == selected;
    let disabled = min.is_some_and(|m| day < m);
    let ink = if is_selected {
        p.primary_foreground
    } else if day == today {
        p.primary
    } else if in_month {
        p.foreground
    } else {
        fade(p.muted_foreground, 0.4)
    };
    let weight = if day == today && !is_selected { 600.0 } else { 400.0 };
    let mut cell = row()
        .key(format!("pick-{day}"))
        .role("button")
        .label(day.format("%A, %B %-d").to_string())
        .size(CELL, CELL)
        .center()
        .radius(theme::RADIUS_LG - 2.0)
        .fill(if is_selected { p.primary } else { rune::Color::TRANSPARENT })
        .opacity(if disabled { 0.3 } else { 1.0 })
        .child(text(day.day().to_string()).font(rune::tok::TextStyle::new(rem(0.875), weight)).color(ink));
    if !disabled {
        cell = cell.focusable(true).hover(if is_selected { p.primary } else { p.accent }).cursor(Cursor::Pointer).on_press(move |s: &mut State| {
            let zone = working_zone(s.prefs.time_zone.as_deref());
            s.wheel = None;
            if let Some(d) = s.draft.as_mut() {
                (d.start_ms, d.end_ms) = steps::set_day(d.start_ms, d.end_ms, d.editing_end, d.all_day, day, zone);
                d.picking_day = None;
            }
        });
    }
    cell
}
