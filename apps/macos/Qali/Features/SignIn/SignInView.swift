import SwiftUI

/// Google sign-in, the Mac take on the web login page: the same event-6 card
/// with its 3pt colour rail, centred over the calendar grid, but cut from
/// Liquid Glass so the grid and the sample events show through it.
struct SignInView: View {
  @Environment(AppModel.self) private var model
  @Environment(\.colorScheme) private var colorScheme
  @Environment(\.controlActiveState) private var controlActiveState

  private let cardShape = RoundedRectangle(cornerRadius: 22, style: .continuous)

  var body: some View {
    ZStack {
      CalendarBackdrop()
      // There is no title bar, so the whole backdrop moves the window.
      Color.clear
        .contentShape(.rect)
        .gesture(WindowDragGesture())
        .allowsWindowActivationEvents(true)
      VStack(spacing: 14) {
        card
        legal
      }
      .padding(.horizontal, 16)
    }
  }

  private var card: some View {
    VStack(alignment: .leading, spacing: 36) {
      VStack(alignment: .leading, spacing: 3) {
        Text("Welcome to Qali")
          .font(.display(TextSize.xl2, .bold))
        Text("Sign in with Google to continue")
          .font(.sans(TextSize.xs))
          .foregroundStyle(Palette.mutedForeground)
      }
      VStack(alignment: .leading, spacing: 10) {
        signInButton
        if model.isSigningIn {
          cancelButton
            .transition(.opacity)
        }
        if let error = model.signInError {
          Text(error)
            .font(.sans(TextSize.xs))
            .foregroundStyle(Palette.destructive)
            .fixedSize(horizontal: false, vertical: true)
            .transition(.opacity)
        }
      }
    }
    .padding(EdgeInsets(top: 24, leading: 26, bottom: 20, trailing: 20))
    .frame(maxWidth: 400, alignment: .leading)
    .overlay(alignment: .leading) {
      Capsule()
        .fill(Palette.event(6))
        .frame(width: 3)
        .padding(.vertical, 10)
        .padding(.leading, 10)
    }
    .glassEffect(.regular.tint(Palette.event(6).opacity(0.22)), in: cardShape)
    .animation(.easeInOut(duration: 0.2), value: model.signInError)
    .animation(.easeInOut(duration: 0.2), value: model.isSigningIn)
  }

  private var signInButton: some View {
    Button {
      Task { await model.signIn() }
    } label: {
      HStack(spacing: 8) {
        if model.isSigningIn {
          ProgressView()
            .controlSize(.small)
            // The button is the inverse of the window (black on light, white
            // on dark), so the spinner is drawn for the opposite scheme.
            .environment(\.colorScheme, buttonIsTinted == (colorScheme == .dark) ? .light : .dark)
        } else {
          Image("Google")
            .resizable()
            .frame(width: 16, height: 16)
        }
        Text(model.isSigningIn ? "Waiting for Google…" : "Continue with Google")
          .font(.sans(TextSize.sm, .medium))
      }
      .foregroundStyle(buttonIsTinted ? Palette.primaryForeground : Palette.foreground)
      .frame(maxWidth: .infinity)
    }
    .buttonStyle(.glassProminent)
    .buttonBorderShape(.roundedRectangle(radius: 12))
    .controlSize(.extraLarge)
    .tint(Palette.primary)
    .keyboardShortcut(.defaultAction)
    // Not `.disabled`: a disabled prominent button greys out, and this one is
    // still the focus of the card while the browser is open.
    .allowsHitTesting(!model.isSigningIn)
  }

  /// A prominent button drops its tint while its window is in the background
  /// (which is where this one is for as long as the browser is in front), and
  /// its label has to follow.
  private var buttonIsTinted: Bool {
    controlActiveState != .inactive
  }

  /// A way out while the browser has the sign-in: a browser other than Safari
  /// may not report that its window was closed.
  private var cancelButton: some View {
    Button("Cancel") {
      model.cancelSignIn()
    }
    .buttonStyle(.plain)
    .font(.sans(TextSize.xs))
    .foregroundStyle(Palette.mutedForeground)
    .keyboardShortcut(.cancelAction)
    .frame(maxWidth: .infinity)
  }

  private var legal: some View {
    Text(Self.legalCopy)
      .font(.sans(TextSize.xs))
      .foregroundStyle(Palette.mutedForeground)
      .tint(Palette.mutedForeground)
      .multilineTextAlignment(.center)
      .frame(maxWidth: 400)
  }

  /// Links open in the default browser, as they open a new tab on the web.
  private static let legalCopy: AttributedString = {
    func link(_ title: String, _ path: String) -> AttributedString {
      var text = AttributedString(title)
      text.link = AppConfig.marketingURL.appending(path: path)
      text.underlineStyle = .single
      return text
    }
    return AttributedString("By signing in, you agree to our ")
      + link("Terms of Service", "terms")
      + AttributedString(" and ")
      + link("Privacy Policy", "privacy")
      + AttributedString(".")
  }()
}
