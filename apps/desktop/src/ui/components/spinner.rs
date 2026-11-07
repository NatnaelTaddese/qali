//! `Spinner`, after `packages/ui/src/components/spinner.tsx`: Hugeicons' `Loading03Icon`
//! (stroke 1.5 at 24) turning once a second (`animate-spin`).

use rune::{Color, El, Icon, LoopSpec, icon};

static LOADING_03: Icon = Icon {
    name: "hugeicons-loading-03",
    view: 24.0,
    body: concat!(
        r#"<path d="M12 3V6" stroke="currentColor" stroke-linecap="round" stroke-width="1.5" fill="none"/>"#,
        r#"<path d="M12 18V21" stroke="currentColor" stroke-linecap="round" stroke-width="1.5" fill="none"/>"#,
        r#"<path d="M21 12L18 12" stroke="currentColor" stroke-linecap="round" stroke-width="1.5" fill="none"/>"#,
        r#"<path d="M6 12L3 12" stroke="currentColor" stroke-linecap="round" stroke-width="1.5" fill="none"/>"#,
        r#"<path d="M18.3635 5.63672L16.2422 7.75804" stroke="currentColor" stroke-linecap="round" stroke-width="1.5" fill="none"/>"#,
        r#"<path d="M7.75804 16.2422L5.63672 18.3635" stroke="currentColor" stroke-linecap="round" stroke-width="1.5" fill="none"/>"#,
        r#"<path d="M18.3635 18.3635L16.2422 16.2422" stroke="currentColor" stroke-linecap="round" stroke-width="1.5" fill="none"/>"#,
        r#"<path d="M7.75804 7.75804L5.63672 5.63672" stroke="currentColor" stroke-linecap="round" stroke-width="1.5" fill="none"/>"#,
    ),
};

pub fn spinner(size: f32, color: Color) -> El {
    icon(&LOADING_03, size)
        .key("spinner")
        .role("progressbar")
        .label("Loading")
        .color(color)
        .looping(LoopSpec::rotation(1.0))
}
