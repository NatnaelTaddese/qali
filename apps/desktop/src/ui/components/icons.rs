//! Hugeicons the app draws, as Rune icons (stroke icons at a 24 viewBox, `currentColor`).

use rune::Icon;

macro_rules! hugeicon {
    ($name:ident, $id:literal, $($d:literal),+) => {
        pub static $name: Icon = Icon {
            name: $id,
            view: 24.0,
            body: concat!($(r#"<path d=""#, $d, r#"" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" fill="none"/>"#),+),
        };
    };
}

hugeicon!(ARROW_LEFT_01, "hugeicons-arrow-left-01", "M15 6C15 6 9.00001 10.4189 9 12C8.99999 13.5812 15 18 15 18");
hugeicon!(ARROW_RIGHT_01, "hugeicons-arrow-right-01", "M9.00005 6C9.00005 6 15 10.4189 15 12C15 13.5812 9 18 9 18");
