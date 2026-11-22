import SwiftUI

/// Connected accounts and how each one syncs (the web's AccountsSection).
struct AccountsPane: View {
  let data: CalendarData
  @Environment(AppModel.self) private var model
  @State private var error: String?
  @State private var confirmDelete = false
  @State private var deleting = false

  var body: some View {
    Form {
      if let connections = data.connections {
        if connections.isEmpty {
          Section {
            Text("No connected accounts yet. They appear after your first sync.")
              .foregroundStyle(.secondary)
          }
        }
        ForEach(connections) { connection in
          ConnectionSection(
            data: data,
            connection: connection,
            // The login grant: its address is the session's, or it is the only
            // connection and has no address yet.
            primary: isPrimary(connection, sole: connections.count == 1),
            canDisconnect: connections.count > 1,
            error: $error
          )
        }
        Section {
          SettingsRow("Another account", detail: "Linking opens qali on the web, then the account shows up here.") {
            Button("Add Google Account…") {
              NSWorkspace.shared.open(AppConfig.webAppURL)
            }
          }
        }
        Section {
          SettingsRow("Delete account", detail: "Permanently deletes your qali account and all of its data") {
            Button(deleting ? "Deleting…" : "Delete Account…", role: .destructive) {
              confirmDelete = true
            }
            .disabled(deleting)
          }
        }
      } else {
        Section { ProgressView().frame(maxWidth: .infinity) }
      }
    }
    .formStyle(.grouped)
    .saveErrors($error)
    .confirmationDialog("Delete your qali account?", isPresented: $confirmDelete) {
      Button("Delete Account", role: .destructive) {
        deleting = true
        Task {
          do {
            try await data.deleteAccount()
            // The server already ended the session; this clears it here and
            // returns the app to the sign-in screen.
            await model.signOut()
          } catch {
            self.error = "Couldn't delete your account."
          }
          deleting = false
        }
      }
    } message: {
      Text(
        "This can't be undone. qali revokes its access to every connected Google account and permanently deletes your synced calendars and contacts, booking page, assistant history and settings. Nothing is deleted from Google Calendar itself."
      )
    }
  }

  private func isPrimary(_ connection: ConnectionListItem, sole: Bool) -> Bool {
    if let address = connection.providerAccountId?.lowercased(),
      let email = model.user?.email.lowercased()
    {
      return address == email
    }
    return sole && connection.providerAccountId == nil
  }
}

private struct ConnectionSection: View {
  let data: CalendarData
  let connection: ConnectionListItem
  let primary: Bool
  let canDisconnect: Bool
  @Binding var error: String?

  @Environment(AppModel.self) private var model
  /// Shown until the subscription reports the saved value, so a switch
  /// doesn't spring back while the mutation is in flight.
  @State private var activeOverride: Bool?
  @State private var contactsOverride: Bool?
  @State private var confirmDisconnect = false
  @State private var disconnecting = false

  private var paused: Bool { connection.status == "paused" }
  private var errored: Bool { connection.status == "error" }
  private var providerName: String { connection.provider == "microsoft" ? "Outlook" : "Google Calendar" }

  var body: some View {
    Section {
      identity

      SettingsRow("Calendar", detail: "View, create, and update events") {
        Toggle("Calendar", isOn: Binding(
          get: { activeOverride ?? !paused },
          set: { next in
            activeOverride = next
            save("Couldn't update the connection.", into: $error) {
              try await data.setConnection(connection, active: next)
            }
          }
        ))
        .toggleStyle(.switch)
        .labelsHidden()
      }

      SettingsRow("Contacts", detail: "Suggests and ranks the people you invite") {
        Toggle("Contacts", isOn: Binding(
          get: { contactsOverride ?? (connection.contactsEnabled ?? false) },
          set: { next in
            contactsOverride = next
            save("Couldn't update contacts sync.", into: $error) {
              try await data.setContacts(connection, enabled: next)
            }
          }
        ))
        .toggleStyle(.switch)
        .labelsHidden()
      }

      SettingsRow {
        if errored {
          Button("Resume") {
            save("Couldn't resume the connection.", into: $error) {
              try await data.setConnection(connection, active: true)
            }
          }
        } else {
          Button {
            Task { await data.syncNow() }
          } label: {
            if data.isSyncing {
              HStack(spacing: 6) {
                ProgressView().controlSize(.mini)
                Text("Syncing…")
              }
            } else {
              Label("Sync Now", systemImage: "arrow.clockwise")
            }
          }
          .disabled(paused || data.isSyncing)
        }
      } title: {
        HStack(spacing: 6) {
          Text("Sync")
          Circle()
            .fill(errored ? Color.red : paused ? Color.secondary.opacity(0.5) : Color.green)
            .frame(width: 7, height: 7)
        }
      } detail: {
        TimelineView(.everyMinute) { context in
          Text(syncDescription(now: context.date))
            .foregroundStyle(errored ? Color.red : Color.secondary)
        }
      }

      if canDisconnect {
        SettingsRow("Disconnect", detail: "Removes this account and everything it synced") {
          Button(disconnecting ? "Disconnecting…" : "Disconnect…", role: .destructive) {
            confirmDisconnect = true
          }
          .disabled(disconnecting)
        }
      }
    }
    .onChange(of: paused) { activeOverride = nil }
    .onChange(of: connection.contactsEnabled) { contactsOverride = nil }
    .confirmationDialog(
      "Disconnect \(connection.providerAccountId ?? providerName)?",
      isPresented: $confirmDisconnect
    ) {
      Button("Disconnect", role: .destructive) {
        disconnecting = true
        Task {
          do { try await data.disconnect(connection) } catch { self.error = "Couldn't disconnect the account." }
          disconnecting = false
        }
      }
    } message: {
      Text("Its calendars and events are removed from qali. Nothing is deleted from \(providerName).")
    }
  }

  private var identity: some View {
    HStack(spacing: 12) {
      ZStack(alignment: .bottomTrailing) {
        if primary {
          UserAvatar(size: 36)
        } else {
          SettingsAvatar(
            url: connection.providerAccountImageUrl,
            initial: String((connection.providerAccountName ?? connection.providerAccountId ?? "?").prefix(1)),
            size: 36
          )
        }
        ProviderBadge(provider: connection.provider, size: 16)
          .offset(x: 3, y: 3)
      }
      VStack(alignment: .leading, spacing: 2) {
        Text(accountName).font(.headline)
        Text(accountLabel).foregroundStyle(.secondary)
      }
      .lineLimit(1)
      .truncationMode(.middle)
      Spacer()
      if primary {
        Label("Primary", systemImage: "checkmark.seal.fill")
          .font(.caption.weight(.medium))
          .foregroundStyle(.tint)
      }
    }
    .padding(.vertical, 2)
  }

  private var accountName: String {
    primary ? (model.user?.name ?? providerName) : (connection.providerAccountName ?? providerName)
  }

  private var accountLabel: String {
    connection.providerAccountId ?? (primary ? (model.user?.email ?? "") : "Account details pending sync")
  }

  private func syncDescription(now: Date) -> String {
    if errored { return connection.lastError ?? "Needs attention" }
    if paused { return "Paused, not syncing" }
    let interval = max(1, Int(((connection.syncIntervalMs ?? 15 * 60_000) / 60_000).rounded()))
    let synced: String
    if let last = connection.lastSyncAt {
      let formatter = RelativeDateTimeFormatter()
      formatter.unitsStyle = .full
      let date = Date(timeIntervalSince1970: last / 1000)
      synced = now.timeIntervalSince(date) < 60 ? "Synced just now" : "Synced \(formatter.localizedString(for: date, relativeTo: now))"
    } else {
      synced = "Not synced yet"
    }
    return "\(synced) · checks every \(interval) min"
  }
}
