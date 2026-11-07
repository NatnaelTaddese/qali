//! Rune versions of the web's components (`packages/ui/src/components`,
//! `apps/web/src/components`). Each takes the theme `Paint` and returns an `El`, so screens
//! compose them the way the web's routes compose React components.
//!
//! They carry the web's whole variant set, used or not yet, so screens can reach for any of it.
#![allow(dead_code)]

pub mod avatar;
pub mod button;
pub mod calendar_backdrop;
pub mod chroma_loader;
pub mod event_card;
pub mod icons;
pub mod icons_gen;
pub mod segmented;
pub mod spinner;
pub mod switch;
pub mod text_link;
pub mod wheel_picker;

pub use button::{Button, Size as ButtonSize, Variant as ButtonVariant};
pub use calendar_backdrop::calendar_backdrop;
pub use chroma_loader::chroma_loader;
pub use event_card::{Elevation, EventCard};
pub use segmented::segmented;
pub use spinner::spinner;
pub use text_link::text_link;
