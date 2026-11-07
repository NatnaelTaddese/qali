//! Liquid Glass inside the app's own content.
//!
//! macOS's own glass (`El::system_material(Glass)`) is a native view under the window's Metal
//! layer: it only shows what is behind the window. Glass over the app's own drawing is
//! `rune-fx`'s lens with `frost` (Liquid Glass "regular": refraction, a wide backdrop blur,
//! a saturation lift, rim light and grain), painted at `El::effect` slots by this compositor.
//!
//! A slot is a `glass_surface` element: its presented rect and corner radius are the glass's
//! shape, and its `effect_data` carries a `Glass` style. The lens's own tint multiplies (it
//! can darken a backdrop, never lighten it), so colour goes in as a fill under the slot.

use rune::compose::{Compositor, Frame};
use rune::render::{EffectPhase, EffectSite, KIND_EFFECT};
use rune::{El, el};
use rune_fx::{Fx, FxFrame, FxLayer, FxOptions, FxRenderer, FxSlot, LensParams, Shape};

use crate::app::State;

/// `El::effect` mark for glass slots.
pub const GLASS: u32 = 1;

/// How a piece of glass looks.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Glass {
    /// 0 is clear (refraction and rim light only), 1 is Liquid Glass "regular". Frost shades a
    /// light backdrop toward grey, so light surfaces keep it low.
    pub frost: f32,
    /// The rim light's strength: 1.4 is a bright, sculpted edge; a hairline is a few tenths.
    pub rim: f32,
    /// The widest the refracting bevel gets, in points (it's 28% of the height below that).
    pub bevel: f32,
    /// The lens's own inner shadow along the rim.
    pub shadow: f32,
}

impl Glass {
    /// A small control (the primary button): a pronounced, sculpted edge.
    pub const CONTROL: Glass = Glass { frost: 0.45, rim: 1.4, bevel: 12.0, shadow: 0.22 };
}

/// A glass layer filling its parent (put it first, under the content), rounded like it.
pub fn glass_surface(radius: f32, glass: Glass) -> El {
    el().key("glass")
        .pin(Some(0.0), Some(0.0), Some(0.0), Some(0.0))
        .radius(radius)
        .effect(GLASS)
        .effect_backdrop(true)
        .effect_data([glass.frost, glass.rim, glass.bevel, glass.shadow])
}

/// The lens for a piece of glass `h` tall, from the slot's `Glass` style.
fn lens(data: [f32; 4], h: f32) -> LensParams {
    let [frost, rim, bevel, shadow] = data;
    let bevel = (h * 0.28).min(bevel).max(1.0);
    LensParams {
        bevel,
        depth: bevel * 0.9,
        dispersion: 0.1 * (rim / 1.4).min(1.0),
        magnification: 1.02,
        presence: 1.0,
        frost: frost.clamp(0.0, 1.0),
        shadow: shadow.max(0.0),
        rim: rim.max(0.0),
        ..Default::default()
    }
}

/// Draws the frame as Rune would, and a frosted lens at every glass slot.
#[derive(Default)]
pub struct GlassCompositor {
    fx: Option<FxRenderer>,
}

impl Compositor<State> for GlassCompositor {
    fn render(&mut self, f: &mut Frame<'_, State>) {
        let (device, queue, size) = (f.device, f.queue, f.size);
        let t = f.rt.t as f32;
        let mut at: Vec<u32> = Vec::new();
        let mut layers: Vec<FxLayer> = Vec::new();
        let mut placements: Vec<FxSlot> = Vec::new();
        for (n, i) in f.rt.instances.iter().enumerate() {
            if i.params[1] != KIND_EFFECT || f.rt.marks.get(n).copied().unwrap_or(0) != GLASS {
                continue;
            }
            // Instances are in device pixels; fx shapes are in points at the slot's scale.
            let k = i.params[3];
            let [x, y, w, h] = i.rect.map(|v| v / k);
            let r = i.radii.iter().fold(0.0f32, |a, v| a.max(v.abs())) / k;
            at.push(n as u32);
            layers.push(Fx::lens(lens(i.uv, h)).on(Shape::rounded(x, y, w, h, r)).at(t));
            placements.push(FxSlot::default().scale(k).clip(i.clip, i.fade));
        }

        let fx = self.fx.get_or_insert_with(|| FxRenderer::new(device, f.format, FxOptions { dither: true }));
        fx.set_srgb_blend(f.srgb_blend());
        // Isolated layers (a disabled button's 50% opacity) draw into Rgba16Float targets.
        fx.add_format(device, wgpu::TextureFormat::Rgba16Float);
        fx.prepare_with_slots(
            device,
            queue,
            &FxFrame { viewport: [size.0, size.1], scale: 1.0, layers: &layers, backdrop: None, sources: &[] },
            &placements,
        );

        let clear = f.rt.clear_color();
        f.ui.prepare(device, queue, &mut f.rt.text.atlas, &f.rt.instances, size);
        f.ui.draw_with_backdrop(f.encoder, f.target, clear, &mut |phase, s: &EffectSite<'_>| {
            let Some(k) = at.iter().position(|n| *n == s.index) else { return };
            match phase {
                EffectPhase::Backdrop(encoder) => {
                    if let Some(backdrop) = s.backdrop {
                        fx.blur_backdrop(device, queue, encoder, backdrop, k);
                    }
                }
                EffectPhase::Draw(pass) => fx.draw_layer_in(pass, s.format, s.origin, k),
            }
        });
    }
}
