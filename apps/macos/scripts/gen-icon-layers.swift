#!/usr/bin/env swift
// Draws the Mac app icon's layers for Icon Composer (Qali/Resources/AppIcon.icon)
// from the web icon's recipe (apps/web/public/icon.svg): a calendar tile with a
// red "QALI" header over a Fraunces "Q", one SVG per layer on Composer's
// full-bleed 1024 canvas. Composer draws the
// rounded mask, the glass highlights and the shadow, so none are baked in here;
// text is outlined to paths, since Composer doesn't load the app's fonts.
//
// Run from apps/macos:  swift scripts/gen-icon-layers.swift
// Writes Icon/layers/{background,header,wordmark,q}.svg; drag them over the
// matching layers in AppIcon.icon.
import AppKit
import CoreText

let root = URL(fileURLWithPath: FileManager.default.currentDirectoryPath)
let fonts = root.appending(path: "Qali/Resources/Fonts")
let out = root.appending(path: "Icon/layers")
try FileManager.default.createDirectory(at: out, withIntermediateDirectories: true)

CTFontManagerRegisterFontsForURL(fonts.appending(path: "Fraunces-ExtraBold.ttf") as CFURL, .process, nil)

/// Web icon units (a 512 square, apps/web/public/icon.svg) to canvas points.
let canvas: CGFloat = 1024
let unit = canvas / 512

let dark = "#1B1B1B"
let red = "#EF373D"  // --destructive, oklch(62% 0.22 25)
let white = "#FFFFFF"
let qWhite = "#F2F2F2"

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

/// SVG path data for glyph outlines (y up) centred on a point in web icon
/// units (y down from the top).
func svgPath(_ path: CGPath, centreX: CGFloat, centreY: CGFloat) -> String {
  let box = path.boundingBoxOfPath
  let dx = centreX * unit - box.midX
  let dy = centreY * unit + box.midY
  func p(_ point: CGPoint) -> String {
    String(format: "%.2f %.2f", point.x + dx, dy - point.y)
  }
  var d = ""
  path.applyWithBlock { element in
    let e = element.pointee
    switch e.type {
    case .moveToPoint: d += "M\(p(e.points[0]))"
    case .addLineToPoint: d += "L\(p(e.points[0]))"
    case .addQuadCurveToPoint: d += "Q\(p(e.points[0])) \(p(e.points[1]))"
    case .addCurveToPoint: d += "C\(p(e.points[0])) \(p(e.points[1])) \(p(e.points[2]))"
    case .closeSubpath: d += "Z"
    @unknown default: break
    }
  }
  return d
}

func write(_ name: String, _ body: String) throws {
  let svg = """
    <svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
    \(body)
    </svg>

    """
  try svg.write(to: out.appending(path: "\(name).svg"), atomically: true, encoding: .utf8)
}

// Back to front.
try write("background", #"<rect width="1024" height="1024" fill="\#(dark)"/>"#)
try write("header", #"<rect width="1024" height="\#(154 * unit)" fill="\#(red)"/>"#)
let wordmark = glyphs("QALI", font: .systemFont(ofSize: 77 * unit, weight: .bold), tracking: 2 * unit)
try write("wordmark", #"<path fill="\#(white)" d="\#(svgPath(wordmark, centreX: 256, centreY: 77))"/>"#)
let q = glyphs("Q", font: NSFont(name: "Fraunces-ExtraBold", size: 297 * unit)!)
try write("q", #"<path fill="\#(qWhite)" d="\#(svgPath(q, centreX: 256, centreY: 333))"/>"#)

print("wrote 4 layers to \(out.path)")
