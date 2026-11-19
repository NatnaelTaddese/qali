#!/usr/bin/env python3
"""Generate Qali/Resources/Assets.xcassets/Colors/*.colorset from the web
design tokens (packages/ui/src/styles/globals.css), so the Mac app and the web
app share one palette.

Run from apps/macos after changing the tokens:  python3 scripts/gen-colors.py
"""
import json, math, re, shutil
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CSS = ROOT.parent.parent / "packages" / "ui" / "src" / "styles" / "globals.css"
OUT = ROOT / "Qali" / "Resources" / "Assets.xcassets" / "Colors"

# Asset names are the camelCased token (`muted-foreground` -> `mutedForeground`).
TOKENS = [
    "background", "foreground", "card", "card-foreground", "popover",
    "primary", "primary-foreground", "secondary", "muted", "muted-foreground",
    "accent", "calendar-header", "destructive", "border", "input", "ring",
    "link", "event-neutral",
] + [f"event-{i}" for i in range(1, 9)] + [f"chroma-{i}" for i in range(1, 6)]


def block(css: str, selector: str) -> dict[str, str]:
    """The custom properties declared in the first `selector { … }` rule."""
    start = re.search(rf"^{re.escape(selector)} \{{", css, flags=re.M).end()
    body = re.sub(r"/\*.*?\*/", "", css[start : css.index("\n}", start)], flags=re.S)
    return dict(re.findall(r"--([\w-]+):\s*([^;]+);", body))


def oklch_to_srgb(l: float, c: float, h: float) -> tuple[float, float, float]:
    a, b = c * math.cos(math.radians(h)), c * math.sin(math.radians(h))
    l_ = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3
    m_ = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3
    s_ = (l - 0.0894841775 * a - 1.2914855480 * b) ** 3
    lin = (
        4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_,
        -1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_,
        -0.0041960863 * l_ - 0.7034186147 * m_ + 1.7076147010 * s_,
    )

    def gamma(x: float) -> float:
        x = min(max(x, 0.0), 1.0)
        return 12.92 * x if x <= 0.0031308 else 1.055 * x ** (1 / 2.4) - 0.055

    return tuple(gamma(x) for x in lin)


def parse(value: str) -> tuple[float, float, float, float]:
    value = value.strip()
    if value.startswith("#"):
        h = value[1:]
        return (*(int(h[k : k + 2], 16) / 255 for k in (0, 2, 4)), 1.0)
    m = re.fullmatch(r"(oklch|rgb)\(([^)]*)\)", value)
    if not m:
        raise ValueError(f"unsupported colour {value!r}")
    parts = m.group(2).replace("/", " / ").split()
    alpha = float(parts[parts.index("/") + 1]) if "/" in parts else 1.0
    nums = parts[: parts.index("/")] if "/" in parts else parts
    if m.group(1) == "rgb":
        return (*(float(n) / 255 for n in nums), alpha)
    l = float(nums[0].rstrip("%")) / (100 if nums[0].endswith("%") else 1)
    return (*oklch_to_srgb(l, float(nums[1]), float(nums[2])), alpha)


def component(rgba: tuple[float, float, float, float]) -> dict:
    r, g, b, a = rgba
    return {
        "color-space": "srgb",
        "components": {"red": f"{r:.4f}", "green": f"{g:.4f}", "blue": f"{b:.4f}", "alpha": f"{a:.3f}"},
    }


def main() -> None:
    css = CSS.read_text()
    light = block(css, ":root")
    # `.dark` only redeclares what changes; everything else inherits :root.
    dark = {**light, **block(css, ".dark")}
    shutil.rmtree(OUT, ignore_errors=True)
    OUT.mkdir(parents=True)
    (OUT / "Contents.json").write_text(json.dumps({"info": {"author": "xcode", "version": 1}, "properties": {"provides-namespace": False}}, indent=2) + "\n")
    for token in TOKENS:
        name = re.sub(r"-(\w)", lambda m: m.group(1).upper(), token)
        colorset = OUT / f"{name}.colorset"
        colorset.mkdir()
        colorset.joinpath("Contents.json").write_text(json.dumps({
            "colors": [
                {"idiom": "universal", "color": component(parse(light[token]))},
                {"idiom": "universal", "appearances": [{"appearance": "luminosity", "value": "dark"}], "color": component(parse(dark[token]))},
            ],
            "info": {"author": "xcode", "version": 1},
        }, indent=2) + "\n")
    print(f"wrote {len(TOKENS)} colorsets to {OUT.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
