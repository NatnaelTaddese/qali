//! Qali for the desktop, drawn by Rune. `cargo run` opens the window (sign-in needs the app
//! bundle, see `scripts/mac-app.sh`); `-- --snap out.png --scene signed-in` renders headless.

mod app;
mod auth;
mod config;
mod data;
mod settings;
mod ui;

use rune::AppSpec;

use crate::app::State;

const FONTS: &[&[u8]] = &[
    include_bytes!("../assets/fonts/Lexend-Regular.ttf"),
    include_bytes!("../assets/fonts/Lexend-Medium.ttf"),
    include_bytes!("../assets/fonts/Lexend-SemiBold.ttf"),
    include_bytes!("../assets/fonts/Fraunces-Bold.ttf"),
    include_bytes!("../assets/fonts/Fraunces-ExtraBold.ttf"),
];

pub fn spec() -> AppSpec<State> {
    AppSpec {
        min_size: Some((420.0, 480.0)),
        scenes: ui::scenes::SCENES,
        fonts: FONTS,
        families: ("Lexend", "ui-monospace"),
        setup: Some(app::setup),
        poll: Some(app::poll),
        on_key: Some(app::on_key),
        ..AppSpec::new("Qali", ui::views::WINDOW, State::default, ui::views::view)
    }
}

fn main() {
    rune_mac::launch();
    let app = rune::App::new(spec())
        .titlebar(rune::Titlebar::new(ui::views::TITLEBAR_HEIGHT))
        .standard_menus()
        .compositor(ui::glass::GlassCompositor::default())
        .on_open_url(app::open_url);
    app::install(config::Config::from_env(), app.handle());
    // Network work starts after the first frame (and never in headless renders, which don't
    // call `on_ready`). It runs once per native window creation, so only the first counts.
    let mut started = false;
    app.on_ready(move |_| {
        if !std::mem::replace(&mut started, true) {
            app::restore();
        }
    })
    .run();
}

#[cfg(test)]
mod tests;
