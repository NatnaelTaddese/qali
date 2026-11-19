#!/usr/bin/env swift
// Draws the installer DMG's window background: the sign-in screen's calendar
// backdrop (Qali/Features/SignIn/CalendarBackdrop.swift: a faint hour grid
// fading toward the edges, with sample events resting on it, here more
// muted), an arrow from where Qali.app sits to the Applications link, and a
// caption. 1x and 2x go in one TIFF so Retina screens get the sharp one.
// Icon positions must match scripts/dmg-settings.py.
//
// Run from apps/macos:  swift scripts/gen-dmg-background.swift
import AppKit
import CoreText

let root = URL(fileURLWithPath: FileManager.default.currentDirectoryPath)
let fonts = root.appending(path: "Qali/Resources/Fonts")
let out = root.appending(path: "Packaging/dmg-background.tiff")
for font in ["Lexend-Regular", "Lexend-Medium"] {
  CTFontManagerRegisterFontsForURL(fonts.appending(path: "\(font).ttf") as CFURL, .process, nil)
}

/// The Finder window's content size and the icon centres, in points.
let size = CGSize(width: 800, height: 440)
let appIcon = CGPoint(x: 270, y: 170)
let applications = CGPoint(x: 530, y: 170)

// Palette (Assets.xcassets/Colors, light).
let background = NSColor(white: 0.9868, alpha: 1)
let foreground = NSColor(white: 0.0284, alpha: 1)
let muted = NSColor(white: 0.3556, alpha: 1)
let card = NSColor(white: 0.9606, alpha: 1)
/// `border` (foreground at 6%) at the backdrop's 55%.
let gridLine = NSColor(white: 0.0284, alpha: 0.06 * 0.55)
let events: [Int: NSColor] = [
  2: NSColor(red: 0.9590, green: 0.5466, blue: 0.2952, alpha: 1),
  4: NSColor(red: 0.3660, green: 0.7842, blue: 0.4762, alpha: 1),
  5: NSColor(red: 0.1925, green: 0.7861, blue: 0.7865, alpha: 1),
  6: NSColor(red: 0.2469, green: 0.6851, blue: 0.9520, alpha: 1),
  8: NSColor(red: 0.8124, green: 0.4706, blue: 0.8334, alpha: 1),
]

// The backdrop's grid: 200pt day columns anchored to the centre, 64pt hours.
let column: CGFloat = 200
let row: CGFloat = 64
let cellGap: CGFloat = 4
/// The sign-in screen shows its cards at 55%; the installer sits further back.
let ghostOpacity: CGFloat = 0.33

/// `column` counts day columns from the centre (negative is left), `row` hour
/// rows from the top. At 800pt the outer two columns are whole; the cards stay
/// in them, clear of the icons.
struct Ghost {
  let hue: Int, title: String, time: String, column: Int, row: Int, rowSpan: Int
}
let ghosts = [
  Ghost(hue: 4, title: "Standup", time: "9:00 – 9:15 AM", column: -2, row: 0, rowSpan: 1),
  Ghost(hue: 6, title: "Deep work", time: "10:00 – 12:00 PM", column: -2, row: 2, rowSpan: 2),
  Ghost(hue: 5, title: "1:1", time: "4:00 – 4:30 PM", column: -2, row: 4, rowSpan: 1),
  Ghost(hue: 8, title: "Lunch", time: "12:30 – 1:30 PM", column: 1, row: 1, rowSpan: 1),
  Ghost(hue: 2, title: "Design review", time: "2:00 – 3:00 PM", column: 1, row: 3, rowSpan: 2),
]

func font(_ name: String, _ size: CGFloat) -> NSFont {
  NSFont(name: name, size: size) ?? .systemFont(ofSize: size)
}

/// The hour grid, fading out toward the edges like the web's
/// `radial-gradient(120% 100% at 50% 45%, black 35%, transparent 92%)`.
func drawGrid(_ context: CGContext) {
  context.beginTransparencyLayer(auxiliaryInfo: nil)
  let path = CGMutablePath()
  var y: CGFloat = 0.5
  while y < size.height {
    path.move(to: CGPoint(x: 0, y: y))
    path.addLine(to: CGPoint(x: size.width, y: y))
    y += row
  }
  var x = (size.width / 2).truncatingRemainder(dividingBy: column) + 0.5
  while x < size.width {
    path.move(to: CGPoint(x: x, y: 0))
    path.addLine(to: CGPoint(x: x, y: size.height))
    x += column
  }
  context.addPath(path)
  context.setStrokeColor(gridLine.cgColor)
  context.setLineWidth(1)
  context.strokePath()

  context.saveGState()
  context.setBlendMode(.destinationIn)
  context.translateBy(x: size.width * 0.5, y: size.height * 0.45)
  context.scaleBy(x: 1.2 * size.width / size.height, y: 1)
  let fade = CGGradient(
    colorsSpace: CGColorSpaceCreateDeviceGray(),
    colors: [CGColor(gray: 0, alpha: 1), CGColor(gray: 0, alpha: 0)] as CFArray,
    locations: [0.35, 0.92])!
  context.drawRadialGradient(
    fade, startCenter: .zero, startRadius: 0, endCenter: .zero, endRadius: size.height,
    options: [.drawsBeforeStartLocation, .drawsAfterEndLocation])
  context.restoreGState()
  context.endTransparencyLayer()
}

/// The calendar's event-card recipe: tinted fill, left accent pill, hairline.
func drawGhost(_ ghost: Ghost, _ context: CGContext) {
  let tint = events[ghost.hue]!
  let rect = CGRect(
    x: size.width / 2 + CGFloat(ghost.column) * column + cellGap,
    y: CGFloat(ghost.row) * row + cellGap,
    width: column - 2 * cellGap,
    height: CGFloat(ghost.rowSpan) * row - 2 * cellGap)

  context.saveGState()
  context.setAlpha(ghostOpacity)
  context.beginTransparencyLayer(auxiliaryInfo: nil)
  NSGraphicsContext.saveGraphicsState()
  NSBezierPath(roundedRect: rect, xRadius: 9, yRadius: 9).addClip()
  card.setFill()
  rect.fill()
  tint.withAlphaComponent(0.22).setFill()
  rect.fill(using: .sourceOver)
  tint.setFill()
  NSBezierPath(
    roundedRect: CGRect(x: rect.minX + 4, y: rect.minY + 4, width: 3, height: rect.height - 8),
    xRadius: 1.5, yRadius: 1.5
  ).fill()
  NSString(string: ghost.title).draw(
    at: CGPoint(x: rect.minX + 12, y: rect.minY + 5),
    withAttributes: [.font: font("Lexend-Medium", 13), .foregroundColor: foreground])
  NSString(string: ghost.time).draw(
    at: CGPoint(x: rect.minX + 12, y: rect.minY + 23),
    withAttributes: [.font: font("Lexend-Regular", 11), .foregroundColor: muted])
  NSGraphicsContext.restoreGraphicsState()
  NSColor(white: 0, alpha: 0.1).setStroke()
  let outline = NSBezierPath(roundedRect: rect.insetBy(dx: 0.5, dy: 0.5), xRadius: 8.5, yRadius: 8.5)
  outline.lineWidth = 1
  outline.stroke()
  context.endTransparencyLayer()
  context.restoreGState()
}

func draw(scale: CGFloat) -> NSBitmapImageRep {
  let rep = NSBitmapImageRep(
    bitmapDataPlanes: nil, pixelsWide: Int(size.width * scale), pixelsHigh: Int(size.height * scale),
    bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
    colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
  rep.size = size
  NSGraphicsContext.saveGraphicsState()
  let context = NSGraphicsContext(bitmapImageRep: rep)!.cgContext
  // Finder's coordinates run top-down; flip, and tell AppKit so text and
  // paths come out the right way up.
  context.translateBy(x: 0, y: size.height)
  context.scaleBy(x: 1, y: -1)
  NSGraphicsContext.current = NSGraphicsContext(cgContext: context, flipped: true)

  background.setFill()
  CGRect(origin: .zero, size: size).fill()
  drawGrid(context)
  for ghost in ghosts { drawGhost(ghost, context) }

  // A straight arrow between the icons, clear of both (128pt icons).
  let tail = CGPoint(x: appIcon.x + 86, y: appIcon.y)
  let tip = CGPoint(x: applications.x - 86, y: applications.y)
  muted.withAlphaComponent(0.5).setStroke()
  let shaft = NSBezierPath()
  shaft.move(to: tail)
  shaft.line(to: tip)
  let head = NSBezierPath()
  head.move(to: CGPoint(x: tip.x - 11, y: tip.y - 11))
  head.line(to: tip)
  head.line(to: CGPoint(x: tip.x - 11, y: tip.y + 11))
  for path in [shaft, head] {
    path.lineWidth = 3
    path.lineCapStyle = .round
    path.lineJoinStyle = .round
    path.stroke()
  }

  // Kept above the bottom 60pt, where Finder puts the path and status bars
  // when the user has them on (a DMG can't turn those off).
  let caption = NSAttributedString(
    string: "Drag Qali into Applications to install it",
    attributes: [.font: font("Lexend-Medium", 14), .foregroundColor: muted])
  let captionSize = caption.size()
  caption.draw(at: CGPoint(x: (size.width - captionSize.width) / 2, y: size.height - 96 - captionSize.height))

  NSGraphicsContext.restoreGraphicsState()
  return rep
}

let image = NSImage(size: size)
image.addRepresentation(draw(scale: 1))
image.addRepresentation(draw(scale: 2))
try FileManager.default.createDirectory(at: out.deletingLastPathComponent(), withIntermediateDirectories: true)
try image.tiffRepresentation(using: .lzw, factor: 1)!.write(to: out)
print("wrote \(out.path)")
