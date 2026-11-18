import SwiftUI

/// The island's account face (the web's `AccountPanel`): who is signed in, the
/// theme, and the way out.
struct AccountPanel: View {
  let island: Island
  @Environment(AppModel.self) private var model

  @State private var theme = AppTheme.stored
  @State private var isSigningOut = false

  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      HStack(spacing: 10) {
        UserAvatar(size: 36)
        VStack(alignment: .leading, spacing: 1) {
          if let name = model.user?.name, !name.isEmpty {
            Text(name)
              .font(.sans(TextSize.sm, .medium))
          }
          Text(model.user?.email ?? " ")
            .font(.sans(TextSize.xs))
            .foregroundStyle(Palette.mutedForeground)
        }
        .lineLimit(1)
        .truncationMode(.middle)
        Spacer(minLength: 0)
        IslandCloseButton(action: island.close)
      }

      VStack(alignment: .leading, spacing: 6) {
        Text("Theme")
          .font(.sans(TextSize.xs, .medium))
          .foregroundStyle(Palette.mutedForeground)
          .padding(.horizontal, 8)
        HStack(spacing: 4) {
          ForEach(AppTheme.allCases, id: \.self) { option in
            ThemeButton(option: option, selected: theme == option) {
              theme = option
              option.apply()
            }
          }
        }
        .padding(4)
        .background(Palette.foreground.opacity(0.06), in: .rect(cornerRadius: 14, style: .continuous))
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Theme")
      }

      Button {
        guard !isSigningOut else { return }
        isSigningOut = true
        Task { await model.signOut() }
      } label: {
        HStack(spacing: 10) {
          if isSigningOut {
            ProgressView().controlSize(.small)
          } else {
            Image(systemName: "rectangle.portrait.and.arrow.right")
              .font(.system(size: 13, weight: .medium))
          }
          Text(isSigningOut ? "Signing out…" : "Sign out")
            .font(.sans(TextSize.sm, .medium))
          Spacer(minLength: 0)
        }
        .foregroundStyle(Palette.destructive)
        .padding(.horizontal, 12)
        .frame(height: 38)
        .background(Palette.foreground.opacity(0.05), in: .rect(cornerRadius: 14, style: .continuous))
        .contentShape(.rect)
      }
      .buttonStyle(.plain)
      .disabled(isSigningOut)
    }
    .foregroundStyle(Palette.foreground)
  }
}

private struct ThemeButton: View {
  let option: AppTheme
  let selected: Bool
  let action: () -> Void

  @State private var hovering = false

  var body: some View {
    Button(action: action) {
      HStack(spacing: 5) {
        Image(systemName: option.symbol)
          .font(.system(size: 12, weight: .medium))
        Text(option.label)
          .font(.sans(TextSize.xs, .medium))
      }
      .foregroundStyle(selected ? Palette.foreground : Palette.mutedForeground)
      .frame(maxWidth: .infinity)
      .frame(height: 28)
      .background {
        RoundedRectangle(cornerRadius: 10, style: .continuous)
          .fill(Palette.foreground.opacity(selected ? 0.14 : hovering ? 0.06 : 0))
      }
      .contentShape(.rect)
    }
    .buttonStyle(.plain)
    .onHover { hovering = $0 }
    .accessibilityAddTraits(selected ? .isSelected : [])
  }
}

/// The round close button every panel carries in its corner.
struct IslandCloseButton: View {
  let action: () -> Void
  @State private var hovering = false

  var body: some View {
    Button(action: action) {
      Image(systemName: "xmark")
        .font(.system(size: 11, weight: .semibold))
        .foregroundStyle(hovering ? Palette.foreground : Palette.mutedForeground)
        .frame(width: 28, height: 28)
        .background { Circle().fill(Palette.foreground.opacity(hovering ? 0.08 : 0)) }
        .contentShape(.circle)
    }
    .buttonStyle(.plain)
    .onHover { hovering = $0 }
    .accessibilityLabel("Close")
    .help("Close (Esc)")
  }
}
