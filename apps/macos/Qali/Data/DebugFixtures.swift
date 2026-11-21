#if DEBUG
  import Foundation

  /// `-QaliFixture events` swaps the live events for a fixed set in the
  /// current week that exercises what real data may not: overlapping events
  /// (cascade, tiled and fanned), a 15-minute event, a video call, guests, and
  /// all-day events stacked deeper than the band shows.
  enum DebugFixtures {
    static let events: [CalendarEvent]? = {
      guard UserDefaults.standard.string(forKey: "QaliFixture") == "events" else { return nil }
      var local = Calendar(identifier: .gregorian)
      local.firstWeekday = 2
      var utc = Calendar(identifier: .gregorian)
      utc.timeZone = TimeZone(identifier: "UTC")!
      let monday = local.dateInterval(of: .weekOfYear, for: .now)!.start

      /// A timed event on `day` (0 = Monday) between two wall-clock hours.
      func timed(
        _ id: String, _ title: String, day: Int, _ from: Double, _ to: Double, color: String, call: Bool = false,
        guests: [String] = []
      ) -> [String: Any] {
        let start = local.date(byAdding: .day, value: day, to: monday)!.timeIntervalSince1970 * 1000
        var row: [String: Any] = [
          "_id": id, "summary": title, "allDay": false, "status": "confirmed", "color": color,
          "startMs": start + from * 3_600_000, "endMs": start + to * 3_600_000,
        ]
        if call { row["conferenceUrl"] = "https://meet.google.com/example" }
        if !guests.isEmpty {
          row["attendees"] = guests.map { name in
            ["email": "\(name.lowercased())@example.com", "displayName": name, "responseStatus": "accepted"]
          }
        }
        return row
      }

      /// An all-day event covering `days` days from `day`, as UTC midnights.
      func allDay(_ id: String, _ title: String, day: Int, days: Int, color: String) -> [String: Any] {
        let parts = local.dateComponents([.year, .month, .day], from: local.date(byAdding: .day, value: day, to: monday)!)
        let start = utc.date(from: parts)!.timeIntervalSince1970 * 1000
        return [
          "_id": id, "summary": title, "allDay": true, "status": "confirmed", "color": color,
          "startMs": start, "endMs": start + Double(days) * 86_400_000,
        ]
      }

      let rows: [[String: Any]] = [
        allDay("a1", "Conference", day: 1, days: 3, color: "9"),
        allDay("a2", "Birthday", day: 2, days: 1, color: "4"),
        allDay("a3", "Offsite", day: 2, days: 1, color: "5"),
        allDay("a4", "Public holiday", day: 0, days: 1, color: "10"),
        // Spans that run across week rows in the month, and a crowded
        // Wednesday that overflows into "+N more".
        allDay("a5", "Sprint", day: 1, days: 3, color: "7"),
        allDay("a6", "Ski trip", day: 5, days: 4, color: "2"),
        allDay("a7", "Release freeze", day: -2, days: 4, color: "11"),
        timed("t9", "Planning", day: 2, 9, 10, color: "9"),
        timed("t10", "1:1", day: 2, 11, 11.5, color: "6"),
        timed("t11", "Retro", day: 2, 15, 16.5, color: "3", guests: ["Hana", "Ivo"]),
        timed("t1", "Roadmap review", day: 0, 9, 11, color: "9", guests: ["Ana", "Ben", "Cleo"]),
        timed("t2", "Design critique", day: 0, 9.5, 10.5, color: "6"),
        timed("t3", "Interview loop", day: 0, 10, 12, color: "3"),
        timed("t4", "Standup", day: 0, 14, 15, color: "2"),
        timed("t5", "Vendor call", day: 0, 14, 15, color: "11", call: true),
        timed("t6", "Check-in", day: 0, 16, 16.25, color: "7"),
        timed(
          "t7", "Workshop with the whole product and design group", day: 3, 13, 16, color: "5", call: true,
          guests: ["Dana", "Eli", "Fatima", "Gus"]
        ),
        timed("t8", "Lunch", day: 3, 12.5, 13.5, color: "4"),
      ]
      let data = try! JSONSerialization.data(withJSONObject: rows)
      return try! JSONDecoder().decode([CalendarEvent].self, from: data)
    }()
  }
#endif
