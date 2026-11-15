import SwiftUI

/// The bundled faces: Lexend for UI copy (`font-sans`), Fraunces for display
/// headings (`font-display`). Static cuts, registered through
/// `ATSApplicationFontsPath`.
extension Font {
  enum QaliWeight {
    case regular, medium, semibold, bold, extraBold
  }

  static func sans(_ size: CGFloat, _ weight: QaliWeight = .regular) -> Font {
    let face =
      switch weight {
      case .regular: "Lexend-Regular"
      case .medium: "Lexend-Medium"
      case .semibold: "Lexend-SemiBold"
      case .bold, .extraBold: "Lexend-Bold"
      }
    return .custom(face, fixedSize: size)
  }

  /// Fraunces (SOFT 100, WONK 1 static cuts).
  static func display(_ size: CGFloat, _ weight: QaliWeight = .bold) -> Font {
    let face =
      switch weight {
      case .regular, .medium: "Fraunces-Medium"
      case .semibold, .bold: "Fraunces-Bold"
      case .extraBold: "Fraunces-ExtraBold"
      }
    return .custom(face, fixedSize: size)
  }
}

/// The web's text-* scale. The web sets a 14px root, which puts `text-sm` at
/// 12.25px and `text-xs` at 10.5px; these are the same steps rounded onto the
/// sizes macOS controls are drawn at (13pt body, 11pt small).
enum TextSize {
  static let xs: CGFloat = 11
  static let sm: CGFloat = 13
  static let base: CGFloat = 14
  static let lg: CGFloat = 16
  static let xl: CGFloat = 18
  static let xl2: CGFloat = 22
}
