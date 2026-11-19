import QaliDomain
import SwiftUI

/// Every calendar, grouped by account: show or hide it, see its colour and
/// kind, rename it (the web's CalendarsSection).
struct CalendarsPane: View {
  let data: CalendarData
  @Environment(AppModel.self) private var model
  @State private var error: String?

  var body: some View {
    Form {
      if let connections = data.connections {
        if data.calendars.isEmpty {
          Section {
            Text("No calendars yet. They appear after your first sync.")
              .foregroundStyle(.secondary)
          }
        }
        ForEach(connections) { connection in
          let rows = sorted(data.calendars.filter { $0.connectionId == connection.id })
          if !rows.isEmpty {
            Section {
              ForEach(rows) { calendar in
                CalendarRow(data: data, calendar: calendar, error: $error)
              }
            } header: {
              Text(
                connection.providerAccountId
                  ?? (connections.count == 1 ? model.user?.email : nil)
                  ?? "Connected account"
              )
            }
          }
        }
      } else {
        Section { ProgressView().frame(maxWidth: .infinity) }
      }
    }
    .formStyle(.grouped)
    .saveErrors($error)
  }

  /// Primary first, then by name, as the toolbar picker orders them.
  private func sorted(_ calendars: [CalendarListItem]) -> [CalendarListItem] {
    calendars.sorted { a, b in
      if (a.primary ?? false) != (b.primary ?? false) { return a.primary ?? false }
      return a.displayName.localizedCompare(b.displayName) == .orderedAscending
    }
  }
}

private struct CalendarRow: View {
  let data: CalendarData
  let calendar: CalendarListItem
  @Binding var error: String?

  @State private var selectedOverride: Bool?
  @State private var editing = false
  @State private var draft = ""
  @State private var hovering = false
  @FocusState private var fieldFocused: Bool

  private var kind: String {
    if calendar.primary ?? false { return "Primary" }
    if calendar.isShared ?? false { return "Shared" }
    if !calendar.isWritable { return "Read-only" }
    return "Regular"
  }

  private var color: Color { Palette.event(calendar.colorKey) }

  var body: some View {
    HStack(spacing: 10) {
      Toggle(isOn: Binding(
        get: { selectedOverride ?? (calendar.selected ?? true) },
        set: { next in
          selectedOverride = next
          save("Couldn't update the calendar.", into: $error) {
            try await data.setSelected(calendar, selected: next)
          }
        }
      )) {
        EmptyView()
      }
      .toggleStyle(.checkbox)
      .tint(color)
      .labelsHidden()
      .accessibilityLabel("Show \(calendar.displayName)")

      Circle()
        .fill(color)
        .frame(width: 10, height: 10)

      if editing {
        TextField("Name", text: $draft)
          .textFieldStyle(.roundedBorder)
          .focused($fieldFocused)
          .onSubmit(commit)
          .onExitCommand { editing = false }
          .onChange(of: fieldFocused) { _, focused in if !focused && editing { commit() } }
      } else {
        HStack(spacing: 6) {
          Text(calendar.displayName)
            .lineLimit(1)
            .truncationMode(.tail)
          if calendar.summaryOverride != nil, let original = calendar.summary {
            Text("was \(original)")
              .font(.caption)
              .foregroundStyle(.secondary)
              .lineLimit(1)
          }
        }
        .onTapGesture(count: 2) { if !(calendar.isShared ?? false) { startEditing() } }
      }

      Spacer(minLength: 8)

      if !editing && !(calendar.isShared ?? false) {
        Button("Rename", systemImage: "pencil", action: startEditing)
          .labelStyle(.iconOnly)
          .buttonStyle(.borderless)
          .foregroundStyle(.secondary)
          .opacity(hovering ? 1 : 0)
          .help("Rename")
      }

      Text(kind)
        .foregroundStyle(.secondary)
        .frame(width: 72, alignment: .trailing)
    }
    .contentShape(.rect)
    .onHover { hovering = $0 }
    .contextMenu {
      if !(calendar.isShared ?? false) {
        Button("Rename…", action: startEditing)
        if calendar.summaryOverride != nil {
          Button("Use Original Name") { rename(to: nil) }
        }
      }
    }
    .onChange(of: calendar.selected) { selectedOverride = nil }
  }

  private func startEditing() {
    draft = calendar.displayName
    editing = true
    fieldFocused = true
  }

  private func commit() {
    editing = false
    let trimmed = draft.trimmingCharacters(in: .whitespacesAndNewlines)
    guard trimmed != calendar.displayName else { return }
    // Committing nothing, or the provider's own name, clears the override.
    rename(to: trimmed.isEmpty || trimmed == calendar.summary ? nil : trimmed)
  }

  private func rename(to name: String?) {
    save("Couldn't rename the calendar.", into: $error) {
      try await data.rename(calendar, to: name)
    }
  }
}
