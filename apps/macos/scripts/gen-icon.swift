#!/usr/bin/env swift
// Draws the Mac app icon from the web icon's recipe (apps/web/public/icon.svg):
// a calendar tile with a red "QALI" header over a Fraunces "Q", set on the
// macOS icon grid (an 824pt tile inside a 1024pt canvas, with its own shadow).
//
// Run from apps/macos:  swift scripts/gen-icon.swift
import AppKit
import CoreText

let root = URL(fileURLWithPath: FileManager.default.currentDirectoryPath)
let fonts = root.appending(path: "Qali/Resources/Fonts")
let out = root.appending(path: "Qali/Resources/Assets.xcassets/AppIcon.appiconset")

CTFontManagerRegisterFontsForURL(fonts.appending(path: "Fraunces-ExtraBold.ttf") as CFURL, .process, nil)

/// Web icon units (a 512 square) to canvas points.
let tile: CGFloat = 824
let inset: CGFloat = 100
let unit = tile / 512

func glyphs(_ text: String, font: NSFont, tracking: CGFloat = 0) -> CGPath {
  let line = CTLineCreateWithAttributedString(
    NSAttributedString(string: text, attributes: [.font: font, .kern: tracking]))
  let path = CGMutablePath()
  for run in CTLineGetGlyphRuns(line) as! [CTRun] {
    let count = CTRunGetGlyphCount(run)
    var glyphs = [CGGlyph](repeating: 0, count: count)
    var positions = [CGPoint](repeating: .zero, count: count)
    CTRunGetGlyphs(run, CFRange(location: 0, length: count), &glyphs)
    CTRunGetPositions(run, CFRange(location: 0, length: count), &positions)
    for (glyph, position) in zip(glyphs, positions) {
      if let outline = CTFontCreatePathForGlyph(font, glyph, nil) {
        path.addPath(outline, transform: CGAffineTransform(translationX: position.x, y: position.y))
      }
    }
  }
  return path
}

/// Fills `path` centred on a point given in web icon units (y down from the tile top).
func fill(_ path: CGPath, centreX: CGFloat, centreY: CGFloat, color: NSColor, in context: CGContext) {
  let box = path.boundingBoxOfPath
  let x = inset + centreX * unit - box.midX
  let y = 1024 - inset - centreY * unit - box.midY
  context.saveGState()
  context.translateBy(x: x, y: y)
  context.addPath(path)
  context.setFillColor(color.cgColor)
  context.fillPath()
  context.restoreGState()
}

func master() -> NSBitmapImageRep {
  let rep = NSBitmapImageRep(
    bitmapDataPlanes: nil, pixelsWide: 1024, pixelsHigh: 1024, bitsPerSample: 8, samplesPerPixel: 4,
    hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
  let context = NSGraphicsContext(bitmapImageRep: rep)!.cgContext
  let frame = CGRect(x: inset, y: inset, width: tile, height: tile)
  let shape = CGPath(roundedRect: frame, cornerWidth: 185, cornerHeight: 185, transform: nil)

  context.saveGState()
  context.setShadow(offset: CGSize(width: 0, height: -10), blur: 24, color: NSColor.black.withAlphaComponent(0.3).cgColor)
  context.addPath(shape)
  context.setFillColor(NSColor(srgbRed: 0x1b / 255, green: 0x1b / 255, blue: 0x1b / 255, alpha: 1).cgColor)
  context.fillPath()
  context.restoreGState()

  context.saveGState()
  context.addPath(shape)
  context.clip()
  // --destructive, oklch(62% 0.22 25)
  context.setFillColor(NSColor(srgbRed: 0.9373, green: 0.2157, blue: 0.2392, alpha: 1).cgColor)
  context.fill(CGRect(x: inset, y: 1024 - inset - 154 * unit, width: tile, height: 154 * unit))
  fill(
    glyphs("QALI", font: .systemFont(ofSize: 77 * unit, weight: .bold), tracking: 2 * unit),
    centreX: 256, centreY: 77, color: .white, in: context)
  fill(
    glyphs("Q", font: NSFont(name: "Fraunces-ExtraBold", size: 297 * unit)!),
    centreX: 256, centreY: 333, color: NSColor(white: 0.95, alpha: 1), in: context)
  context.restoreGState()
  return rep
}

func png(_ source: NSBitmapImageRep, pixels: Int) -> Data {
  let rep = NSBitmapImageRep(
    bitmapDataPlanes: nil, pixelsWide: pixels, pixelsHigh: pixels, bitsPerSample: 8, samplesPerPixel: 4,
    hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
  NSGraphicsContext.saveGraphicsState()
  NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
  NSGraphicsContext.current?.imageInterpolation = .high
  source.draw(in: NSRect(x: 0, y: 0, width: pixels, height: pixels))
  NSGraphicsContext.restoreGraphicsState()
  return rep.representation(using: .png, properties: [:])!
}

let source = master()
var images: [[String: String]] = []
for points in [16, 32, 128, 256, 512] {
  for scale in [1, 2] {
    let name = "icon_\(points)x\(points)\(scale == 2 ? "@2x" : "").png"
    try png(source, pixels: points * scale).write(to: out.appending(path: name))
    images.append(["filename": name, "idiom": "mac", "scale": "\(scale)x", "size": "\(points)x\(points)"])
  }
}
let contents: [String: Any] = ["images": images, "info": ["author": "xcode", "version": 1]]
try JSONSerialization.data(withJSONObject: contents, options: [.prettyPrinted, .sortedKeys])
  .write(to: out.appending(path: "Contents.json"))
print("wrote \(images.count) icons to \(out.path)")
