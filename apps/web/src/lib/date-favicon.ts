import { format, getDate } from "date-fns";

// Rendered at a retina-friendly size, downscaled by the browser to tab size.
const SIZE = 64;
const RADIUS = 12;
const BAR_HEIGHT = Math.round(SIZE * 0.3);

// Fallback colors if the CSS custom properties can't be resolved.
const FALLBACK = {
  accent: "oklch(62% 0.22 25)", // --destructive (calendar red)
  card: "#1b1b1b",
  cardForeground: "oklch(96% 0 0)",
  barForeground: "#ffffff",
};

function cssVar(name: string, fallback: string): string {
  if (typeof window === "undefined") return fallback;
  const value = getComputedStyle(document.documentElement)
    .getPropertyValue(name)
    .trim();
  return value || fallback;
}

function roundedRectPath(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/**
 * Draws a macOS-Calendar-style favicon (accent bar with the month, big day
 * number) onto an offscreen canvas and points `<link rel="icon">` at it.
 * Colors are read from the app's CSS custom properties so the icon tracks the
 * active light/dark theme.
 */
export function renderDateFavicon(opts: { date?: Date } = {}): void {
  if (typeof document === "undefined") return;

  const date = opts.date ?? new Date();
  const canvas = document.createElement("canvas");
  canvas.width = SIZE;
  canvas.height = SIZE;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  const accent = cssVar("--destructive", FALLBACK.accent);
  const card = cssVar("--card", FALLBACK.card);
  const cardForeground = cssVar("--card-foreground", FALLBACK.cardForeground);

  // Card background.
  roundedRectPath(ctx, 0, 0, SIZE, SIZE, RADIUS);
  ctx.fillStyle = card;
  ctx.fill();

  // Accent bar across the top (clipped to the rounded card).
  ctx.save();
  roundedRectPath(ctx, 0, 0, SIZE, SIZE, RADIUS);
  ctx.clip();
  ctx.fillStyle = accent;
  ctx.fillRect(0, 0, SIZE, BAR_HEIGHT);
  ctx.restore();

  // Month abbreviation in the bar.
  ctx.fillStyle = FALLBACK.barForeground;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.font = `700 ${Math.round(SIZE * 0.19)}px system-ui, -apple-system, sans-serif`;
  ctx.fillText(format(date, "MMM").toUpperCase(), SIZE / 2, BAR_HEIGHT / 2 + 1);

  // Day number below.
  const day = String(getDate(date));
  ctx.fillStyle = cardForeground;
  ctx.font = `700 ${Math.round(SIZE * 0.52)}px system-ui, -apple-system, sans-serif`;
  ctx.fillText(day, SIZE / 2, BAR_HEIGHT + (SIZE - BAR_HEIGHT) / 2 + 2);

  const href = canvas.toDataURL("image/png");

  let link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
  if (!link) {
    link = document.createElement("link");
    link.rel = "icon";
    document.head.appendChild(link);
  }
  link.type = "image/png";
  link.href = href;
}
