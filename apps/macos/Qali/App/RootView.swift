import SwiftUI

/// Picks the top-level screen from the auth phase: the loader while the cached
/// session is tried, then sign-in or the signed-in home.
struct RootView: View {
  @Environment(AppModel.self) private var model

  var body: some View {
    ZStack {
      Palette.background.ignoresSafeArea()
      switch model.phase {
      case .launching:
        // The account-less screens draw under the transparent titlebar.
        ChromaLoader()
          .ignoresSafeArea()
          .transition(.opacity)
      case .signedOut:
        SignInView()
          .ignoresSafeArea()
          .transition(.opacity)
      case .signedIn:
        if let data = model.calendarData {
          CalendarScreen(data: data)
            .transition(.opacity)
        }
      }
    }
    .animation(.easeInOut(duration: 0.25), value: model.phase)
    .font(.sans(TextSize.sm))
    .foregroundStyle(Palette.foreground)
  }
}
