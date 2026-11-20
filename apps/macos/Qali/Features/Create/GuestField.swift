import SwiftUI

/// The create form's guests (the web's `GuestPicker`): a field that searches
/// the people directory by name or address, with the matches listed under it,
/// and offers to invite whatever address is typed. ↑ ↓ pick a match, Return
/// adds it, and a comma adds a typed address. Added guests sit below as chips.
struct GuestField: View {
  @Binding var guests: [DraftGuest]
  @Binding var text: String
  let people: [PersonRow]
  /// Why the list can't be changed (the organiser keeps it), or nil when it
  /// can: the chips then stay, without the field or their remove buttons.
  var readOnlyReason: String? = nil

  @State private var active = 0
  @FocusState private var focused: Bool
  @Environment(Island.self) private var island

  /// The web's `MAX_SUGGESTIONS`.
  private static let maxSuggestions = 6

  /// One row per address not yet invited, matching the query. Nothing shows
  /// until something is typed: an open list would make the form too tall.
  private var suggestions: [PersonRow] {
    let query = text.trimmingCharacters(in: .whitespaces).lowercased()
    guard !query.isEmpty else { return [] }
    let added = Set(guests.map { $0.email.lowercased() })
    var seen = Set<String>()
    var out: [PersonRow] = []
    for person in people {
      let key = person.email.lowercased()
      guard !added.contains(key), !seen.contains(key) else { continue }
      let haystack = "\(person.displayName ?? "") \(person.email)".lowercased()
      guard haystack.contains(query) else { continue }
      seen.insert(key)
      out.append(person)
      if out.count == Self.maxSuggestions { break }
    }
    return out
  }

  /// The typed address as a guest, when it is plausible, new, and not already
  /// one of the suggestions.
  static func typedGuest(_ text: String, existing: [DraftGuest], shown: [PersonRow] = []) -> DraftGuest? {
    let email = text.trimmingCharacters(in: .whitespaces)
    guard
      email.wholeMatch(of: #/[^@\s]+@[^@\s]+\.[^@\s]+/#) != nil,
      !existing.contains(where: { $0.email.caseInsensitiveCompare(email) == .orderedSame }),
      !shown.contains(where: { $0.email.caseInsensitiveCompare(email) == .orderedSame })
    else { return nil }
    return DraftGuest(email: email)
  }

  var body: some View {
    let suggestions = suggestions
    let typed = Self.typedGuest(text, existing: guests, shown: suggestions)
    // The typed address is the last choice in the list.
    let count = suggestions.count + (typed == nil ? 0 : 1)
    let activeIndex = min(active, max(count - 1, 0))

    HStack(alignment: .firstTextBaseline, spacing: 10) {
      Image(systemName: "person.2")
        .font(.system(size: 12, weight: .medium))
        .foregroundStyle(Palette.mutedForeground)
        .frame(width: 16)
      VStack(alignment: .leading, spacing: 6) {
        if let readOnlyReason {
          Text(guests.isEmpty ? readOnlyReason : "\(guests.count) guest\(guests.count == 1 ? "" : "s")")
            .font(.sans(TextSize.sm))
            .foregroundStyle(Palette.mutedForeground)
            .help(readOnlyReason)
        } else {
        TextField("Add guests", text: $text)
          .textFieldStyle(.plain)
          .font(.sans(TextSize.sm, .medium))
          .focused($focused)
          .onSubmit {
            if activeIndex < suggestions.count {
              add(suggestions[activeIndex])
            } else if let typed {
              add(typed)
            }
            // Keep typing: several guests in a row.
            focused = true
          }
          .onKeyPress(.downArrow) {
            guard count > 0 else { return .ignored }
            active = (activeIndex + 1) % count
            return .handled
          }
          .onKeyPress(.escape) {
            // Escape closes the matches first; the form's own Escape is off
            // while they are up.
            guard count > 0 else { return .ignored }
            text = ""
            return .handled
          }
          .onKeyPress(.upArrow) {
            guard count > 0 else { return .ignored }
            active = (activeIndex - 1 + count) % count
            return .handled
          }
          .onChange(of: text) { _, next in
            active = 0
            // A comma ends an address.
            guard next.hasSuffix(",") else { return }
            let candidate = String(next.dropLast())
            if let guest = Self.typedGuest(candidate, existing: guests) {
              add(guest)
            } else {
              text = candidate
            }
          }
        }

        if !guests.isEmpty {
          let photos = photos
          FlowLayout(spacing: 4) {
            ForEach(guests, id: \.email) { guest in
              GuestChip(
                guest: guest,
                photoUrl: guest.photoUrl ?? photos[guest.email.lowercased()],
                remove: readOnlyReason == nil ? { guests.removeAll { $0.email == guest.email } } : nil
              )
            }
          }
        }
      }
    }
    .frame(minHeight: 24)
    .animation(Island.spring, value: guests)
    // The matches float over the form (drawn by the island, outside its
    // clip), so typing never changes the form's height.
    .anchorPreference(key: GuestMatchesKey.self, value: .bounds) { bounds in
      guard count > 0 else { return nil }
      var rows = suggestions.enumerated().map { index, person in
        GuestMatches.Row(id: person.email, name: person.displayName, email: person.email, photoUrl: person.photoUrl) {
          add(person)
          focused = true
        }
      }
      if let typed {
        rows.append(GuestMatches.Row(id: "invite", name: "Invite \(typed.email)", email: nil, photoUrl: nil, symbol: "envelope") {
          add(typed)
          focused = true
        })
      }
      return GuestMatches(anchor: bounds, rows: rows, active: activeIndex) { active = $0 }
    }
    .onChange(of: count > 0, initial: true) { _, open in island.guestMatchesOpen = open }
    .onDisappear { island.guestMatchesOpen = false }
  }

  /// Pictures from the people directory, for guests an event brought in
  /// without one.
  private var photos: [String: String] {
    Dictionary(
      people.compactMap { person in person.photoUrl.map { (person.email.lowercased(), $0) } },
      uniquingKeysWith: { first, _ in first }
    )
  }

  private func add(_ person: PersonRow) {
    add(DraftGuest(email: person.email, displayName: person.displayName, photoUrl: person.photoUrl))
  }

  private func add(_ guest: DraftGuest) {
    guard !guests.contains(where: { $0.email.caseInsensitiveCompare(guest.email) == .orderedSame }) else { return }
    guests.append(guest)
    text = ""
    active = 0
  }
}

/// The guest matches as the field hands them to the island.
struct GuestMatches {
  struct Row: Identifiable {
    var id: String
    var name: String?
    var email: String?
    var photoUrl: String?
    var symbol: String?
    var pick: () -> Void
  }

  /// The guests row, in the island's space.
  var anchor: Anchor<CGRect>
  var rows: [Row]
  var active: Int
  var hover: (Int) -> Void
}

struct GuestMatchesKey: PreferenceKey {
  static var defaultValue: GuestMatches? { nil }

  static func reduce(value: inout GuestMatches?, nextValue: () -> GuestMatches?) {
    value = nextValue() ?? value
  }
}

/// The matches, floating above the guests row like a menu.
struct GuestMatchesCard: View {
  let matches: GuestMatches

  private let shape = RoundedRectangle(cornerRadius: 14, style: .continuous)

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      ForEach(Array(matches.rows.enumerated()), id: \.element.id) { index, row in
        SuggestionRow(
          name: row.name,
          email: row.email,
          photoUrl: row.photoUrl,
          active: index == matches.active,
          symbol: row.symbol,
          action: row.pick
        )
        .onHover { if $0 { matches.hover(index) } }
      }
    }
    .padding(4)
    .glassEffect(.regular, in: shape)
    .shadow(color: .black.opacity(0.18), radius: 12, y: 4)
    .accessibilityElement(children: .contain)
    .accessibilityLabel("Guest suggestions")
  }
}

/// A match: avatar, name over address.
private struct SuggestionRow: View {
  let name: String?
  let email: String?
  let photoUrl: String?
  let active: Bool
  var symbol: String?
  let action: () -> Void

  var body: some View {
    Button(action: action) {
      HStack(spacing: 8) {
        if let symbol {
          Image(systemName: symbol)
            .font(.system(size: 11, weight: .medium))
            .foregroundStyle(Palette.mutedForeground)
            .frame(width: 24, height: 24)
            .background(Palette.secondary, in: .circle)
        } else {
          PersonAvatar(name: name, email: email ?? "", photoUrl: photoUrl, size: 24)
        }
        VStack(alignment: .leading, spacing: 0) {
          Text(name ?? email ?? "")
            .font(.sans(TextSize.sm))
            .lineLimit(1)
          if name != nil, let email {
            Text(email)
              .font(.sans(TextSize.xs))
              .foregroundStyle(Palette.mutedForeground)
              .lineLimit(1)
          }
        }
        .truncationMode(.middle)
        Spacer(minLength: 0)
      }
      .padding(.horizontal, 6)
      .frame(height: 34)
      .background {
        RoundedRectangle(cornerRadius: 8, style: .continuous)
          .fill(Palette.foreground.opacity(active ? 0.08 : 0))
      }
      .contentShape(.rect)
    }
    .buttonStyle(.plain)
  }
}

private struct GuestChip: View {
  let guest: DraftGuest
  let photoUrl: String?
  /// Nil when the list is read-only.
  let remove: (() -> Void)?

  var body: some View {
    HStack(spacing: 5) {
      PersonAvatar(name: guest.displayName, email: guest.email, photoUrl: photoUrl, size: 16)
      Text(guest.displayName ?? guest.email)
        .lineLimit(1)
        .truncationMode(.middle)
      if guest.isSelf {
        Text("(you)").foregroundStyle(Palette.mutedForeground)
      }
      if let remove {
        Button(action: remove) {
          Image(systemName: "xmark")
            .font(.system(size: 8, weight: .bold))
            .foregroundStyle(Palette.mutedForeground)
            .frame(width: 12, height: 12)
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Remove \(guest.displayName ?? guest.email)")
      }
    }
    .font(.sans(TextSize.xs, .medium))
    .padding(.leading, 3)
    .padding(.trailing, remove == nil ? 8 : 6)
    .frame(height: 22)
    .background(Palette.foreground.opacity(0.08), in: .capsule)
    .help(guest.email)
  }
}

/// A person's picture, or their initial on their own palette hue when there
/// is none or it fails to load (the web's `Avatar`).
struct PersonAvatar: View {
  let name: String?
  let email: String
  let photoUrl: String?
  let size: CGFloat

  var body: some View {
    ZStack {
      Palette.event(Self.hue(for: email))
      Text(String(name?.first ?? email.first ?? "?").uppercased())
        .font(.sans(size * 0.45, .semibold))
        // The palette hues stay light in both themes, so a dark initial reads.
        .foregroundStyle(.black.opacity(0.75))
      if let photoUrl, let url = URL(string: photoUrl) {
        RemoteImage(url: url)
      }
    }
    .frame(width: size, height: size)
    .clipShape(.circle)
    .accessibilityHidden(true)
  }

  /// The web's `avatarColorVar`: one of the first eight event hues, hashed
  /// from the email, so a guest gets the same colour on every surface.
  static func hue(for email: String) -> Int {
    var hash: Int32 = 0
    for unit in email.lowercased().utf16 { hash = hash &* 31 &+ Int32(unit) }
    return Int(hash.magnitude % 8) + 1
  }
}
