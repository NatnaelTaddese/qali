import QaliDomain
import SwiftUI

/// The time picker's panel (the web's `TimeField` wheels): hour, minute and,
/// on a 12-hour clock, AM/PM drums side by side behind one centre band. Each
/// drum snaps a row into the band as it scrolls, and a click on a row brings
/// it there. The time changes as the drums turn, so the ghost on the grid
/// follows.
struct TimeWheels: View {
  /// The instant being edited; the wheels change its time of day only.
  let ms: Double
  let zone: WorkingZone
  let use24h: Bool
  let set: (Double) -> Void

  /// The web event form's minute step.
  static let minuteStep = 5
  /// 12 leads, as on a clock face, so it sits next to 1.
  private static let hours12 = ["12"] + (1...11).map(String.init)
  private static let hours24 = (0..<24).map { String(format: "%02d", $0) }
  private static let minutes = stride(from: 0, to: 60, by: minuteStep).map { String(format: "%02d", $0) }
  private static let meridiems = ["AM", "PM"]

  private struct Parts: Equatable {
    var hour: String
    var minute: String
    var meridiem: String
  }

  /// The wheels' values for `ms`, the minute rounded onto the step so an
  /// off-grid time still lands on a row.
  private var parts: Parts {
    let time = zone.calendar.dateComponents([.hour, .minute], from: Date(ms: ms))
    let hour = time.hour ?? 0
    let minute = min(Int((Double(time.minute ?? 0) / Double(Self.minuteStep)).rounded()) * Self.minuteStep, 60 - Self.minuteStep)
    return Parts(
      hour: use24h ? String(format: "%02d", hour) : String(hour % 12 == 0 ? 12 : hour % 12),
      minute: String(format: "%02d", minute),
      meridiem: hour < 12 ? "AM" : "PM"
    )
  }

  private func with(_ change: (inout Parts) -> Void) {
    var next = parts
    change(&next)
    guard next != parts else { return }
    let hour: Int =
      if use24h {
        Int(next.hour) ?? 0
      } else {
        (Int(next.hour) ?? 12) % 12 + (next.meridiem == "PM" ? 12 : 0)
      }
    let day = Date(ms: ms)
    if let date = zone.calendar.date(bySettingHour: hour, minute: Int(next.minute) ?? 0, second: 0, of: day) {
      set(date.ms)
    }
  }

  var body: some View {
    let parts = parts
    HStack(spacing: 4) {
      WheelColumn(options: use24h ? Self.hours24 : Self.hours12, selection: parts.hour, label: "Hour") { value in
        with { $0.hour = value }
      }
      WheelColumn(options: Self.minutes, selection: parts.minute, label: "Minute") { value in
        with { $0.minute = value }
      }
      if !use24h {
        WheelColumn(options: Self.meridiems, selection: parts.meridiem, label: "AM or PM") { value in
          with { $0.meridiem = value }
        }
      }
    }
    .background {
      // The centre band the picked row sits in.
      RoundedRectangle(cornerRadius: 9, style: .continuous)
        .fill(Palette.foreground.opacity(0.08))
        .frame(height: WheelColumn.row)
    }
    .padding(10)
  }
}

/// One drum: the options in a snapping column five rows tall, faded towards
/// its ends.
private struct WheelColumn: View {
  static let row: CGFloat = 32
  static let visibleRows: CGFloat = 5

  let options: [String]
  let selection: String
  let label: String
  let select: (String) -> Void

  /// The row in the band; it follows scrolling and drives the value.
  @State private var position: String?

  var body: some View {
    ScrollView(.vertical) {
      LazyVStack(spacing: 0) {
        ForEach(options, id: \.self) { option in
          Text(option)
            .font(.sans(TextSize.base, .medium))
            .monospacedDigit()
            .foregroundStyle(Palette.foreground)
            .frame(maxWidth: .infinity)
            .frame(height: Self.row)
            .contentShape(.rect)
            .onTapGesture {
              withAnimation(.snappy(duration: 0.25)) { position = option }
            }
            .scrollTransition(.interactive, axis: .vertical) { content, phase in
              content
                .opacity(1 - min(abs(phase.value), 1) * 0.65)
                .scaleEffect(1 - min(abs(phase.value), 1) * 0.12)
            }
        }
      }
      .scrollTargetLayout()
    }
    .scrollIndicators(.never)
    .scrollTargetBehavior(.viewAligned)
    .scrollPosition(id: $position, anchor: .center)
    // Room above the first row and below the last, so either can reach the band.
    .contentMargins(.vertical, Self.row * (Self.visibleRows - 1) / 2, for: .scrollContent)
    .frame(width: 56, height: Self.row * Self.visibleRows)
    .mask {
      LinearGradient(
        stops: [
          .init(color: .clear, location: 0),
          .init(color: .black, location: 0.3),
          .init(color: .black, location: 0.7),
          .init(color: .clear, location: 1),
        ],
        startPoint: .top,
        endPoint: .bottom
      )
    }
    .onAppear { position = selection }
    .onChange(of: position) { _, next in
      if let next, next != selection { select(next) }
    }
    .onChange(of: selection) { _, next in
      if position != next { withAnimation(.snappy(duration: 0.25)) { position = next } }
    }
    .accessibilityElement(children: .ignore)
    .accessibilityLabel(label)
    .accessibilityValue(selection)
    .accessibilityAdjustableAction { direction in
      guard let index = options.firstIndex(of: selection) else { return }
      let next = direction == .increment ? index + 1 : index - 1
      if options.indices.contains(next) { select(options[next]) }
    }
  }
}
