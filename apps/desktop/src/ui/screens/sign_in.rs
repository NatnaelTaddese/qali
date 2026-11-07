//! The sign-in screen, after `apps/web/src/routes/_auth/login.tsx`: the calendar backdrop, a
//! `--event-6` event card holding the welcome and the Google button, and the terms line.
//!
//! Desktop differences: Google finishes in the browser, so while it does the button spins and
//! the terms line becomes a Cancel button; errors read in the card's subtitle instead of a toast.

use rune::{El, col, el, row, text};

use crate::app::{self, Phase, State};
use crate::ui::components::{Button, ButtonSize, ButtonVariant, Elevation, EventCard, calendar_backdrop, text_link};
use crate::ui::theme::{self, Paint, rem};

const MARKETING_URL_TERMS: &str = "https://myqali.com/terms";
const MARKETING_URL_PRIVACY: &str = "https://myqali.com/privacy";

/// `max-w-[400px]`.
const CARD_MAX_W: f32 = 400.0;

pub fn sign_in(s: &State, p: &Paint, size: [f32; 2]) -> El {
    let waiting = s.phase == Phase::Waiting;

    let subtitle = match (&s.error, waiting) {
        (Some(error), _) => text(error.clone()).key("error").font(theme::TEXT_XS).color(p.destructive).wrap(),
        (None, true) => text("Finish signing in with Google in your browser").key("subtitle").font(theme::TEXT_XS).color(p.muted_foreground),
        (None, false) => text("Sign in with Google to continue").key("subtitle").font(theme::TEXT_XS).color(p.muted_foreground),
    };
    let heading = col()
        .key("heading")
        .w_full()
        .child(text("Welcome to Qali").key("title").font(theme::DISPLAY_2XL_BOLD).color(p.foreground))
        .child(subtitle);

    let mut button = Button::new("google", "Continue with Google")
        .size(ButtonSize::Lg)
        .radius(theme::RADIUS_XL)
        .full_width()
        .loading(waiting, "Waiting for your browser…");
    if let Some(mark) = google_mark(s) {
        button = button.icon(mark);
    }
    let button = button.build(p).on_press(|s: &mut State| {
        s.phase = Phase::Waiting;
        s.error = None;
        app::sign_in();
    });

    // `flex flex-col gap-10 pt-6 pr-5 pb-5 pl-6`
    let body = col()
        .key("card-body")
        .w_full()
        .gap(rem(2.5))
        .pt(rem(1.5))
        .pr(rem(1.25))
        .pb(rem(1.25))
        .pl(rem(1.5))
        .child(heading)
        .child(button);
    let card = EventCard::new("sign-in-card", theme::event(6))
        .radius(theme::RADIUS_XL)
        .pill_inset(rem(0.5))
        .elevation(Elevation::Lg)
        .build(p, body)
        .w_full()
        .max_w(CARD_MAX_W);

    let footer = if waiting {
        Button::new("cancel", "Cancel")
            .variant(ButtonVariant::Ghost)
            .size(ButtonSize::Xs)
            .build(p)
            .on_press(|s: &mut State| s.signed_out(None))
    } else {
        terms(p)
    };

    let content = col()
        .key("sign-in")
        .w_full()
        .h_full()
        .center()
        .gap(rem(0.75))
        .px(rem(1.0))
        .child(card)
        .child(footer);

    el().key("sign-in-screen")
        .w_full()
        .h_full()
        .fill(p.background)
        .child(calendar_backdrop(p, size, true))
        .child(content)
}

/// "By signing in, you agree to our Terms of Service and Privacy Policy." (`text-xs
/// leading-snug text-muted-foreground`).
fn terms(p: &Paint) -> El {
    let style = theme::TEXT_XS.lh(rem(0.75) * 1.375);
    let plain = |key: &str, s: &str| text(s.to_string()).key(key.to_string()).font(style).color(p.muted_foreground);
    row()
        .key("terms")
        .max_w(CARD_MAX_W)
        .center()
        .child(plain("terms-lead", "By signing in, you agree to our "))
        .child(text_link("terms-link", "Terms of Service", MARKETING_URL_TERMS, style, p.muted_foreground))
        .child(plain("terms-and", " and "))
        .child(text_link("privacy-link", "Privacy Policy", MARKETING_URL_PRIVACY, style, p.muted_foreground))
        .child(plain("terms-end", "."))
}

/// Google's "G", rasterized from its SVG once the app's image cache has it.
fn google_mark(s: &State) -> Option<El> {
    let image = s.images.as_ref()?.google.as_ref()?;
    Some(el().key("google-mark").pixels(image.pixels()))
}
