import SwiftUI

/// The island's account face (the web's `AccountPanel`): who is signed in, the
/// theme, and the way out.
struct AccountPanel: View {
  let island: Island
  @Environment(AppModel.self) private var model

  @State private var theme = AppTheme.stored
  @State private var isSigningOut = false
  /// The thumb that slides between the theme's segments.
  @Namespace private var thumb

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
        // The same Mac segmented look as the RSVP and Where switches.
        HStack(spacing: 2) {
          ForEach(AppTheme.allCases, id: \.self) { option in
            ThemeButton(option: option, selected: theme == option, thumb: thumb) {
              withAnimation(.snappy(duration: 0.2)) { theme = option }
              option.apply()
            }
          }
        }
        .padding(3)
        .background(Palette.foreground.opacity(0.06), in: .rect(cornerRadius: 10, style: .continuous))
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Theme")
      }

      // Settings and Sign out share one card, a hairline apart, as on the web.
      VStack(spacing: 0) {
        AccountRow(hoverTint: Palette.foreground.opacity(0.05)) {
          // The window is the place to work now; the panel steps aside.
          island.close()
          model.openSettings?()
        } label: {
          Image(systemName: "gearshape")
            .font(.system(size: 13, weight: .medium))
            .foregroundStyle(Palette.mutedForeground)
            .frame(width: 16)
          Text("Settings")
            .font(.sans(TextSize.sm, .medium))
          Spacer(minLength: 0)
        }
        .help("Settings (⌘,)")

        Rectangle()
          .fill(Palette.foreground.opacity(0.08))
          .frame(height: 1)
          .padding(.horizontal, 12)

        AccountRow(hoverTint: Palette.destructive.opacity(0.1)) {
          guard !isSigningOut else { return }
          isSigningOut = true
          Task { await model.signOut() }
        } label: {
          Group {
            if isSigningOut {
              ProgressView().controlSize(.small)
            } else {
              Image(systemName: "rectangle.portrait.and.arrow.right")
                .font(.system(size: 13, weight: .medium))
            }
          }
          .frame(width: 16)
          Text(isSigningOut ? "Signing out…" : "Sign out")
            .font(.sans(TextSize.sm, .medium))
          Spacer(minLength: 0)
        }
        .foregroundStyle(Palette.destructive)
        .disabled(isSigningOut)
      }
      .background(Palette.foreground.opacity(0.05))
      .clipShape(.rect(cornerRadius: 10, style: .continuous))
    }
    .foregroundStyle(Palette.foreground)
  }
}

/// One row of the account card: a full-width button that tints on hover.
private struct AccountRow<Label: View>: View {
  let hoverTint: Color
  let action: () -> Void
  @ViewBuilder let label: Label

  @State private var hovering = false

  var body: some View {
    Button(action: action) {
      HStack(spacing: 10) { label }
        .padding(.horizontal, 12)
        .frame(height: 38)
        .background { if hovering { hoverTint } }
        .contentShape(.rect)
    }
    .buttonStyle(.plain)
    .onHover { hovering = $0 }
  }
}

private struct ThemeButton: View {
  let option: AppTheme
  let selected: Bool
  let thumb: Namespace.ID
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
      .foregroundStyle(selected || hovering ? Palette.foreground : Palette.mutedForeground)
      .frame(maxWidth: .infinity)
      .frame(height: 26)
      .background {
        if selected {
          SegmentThumb(cornerRadius: 7)
            .matchedGeometryEffect(id: "thumb", in: thumb)
        } else if hovering {
          RoundedRectangle(cornerRadius: 7, style: .continuous).fill(Palette.foreground.opacity(0.04))
        }
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
