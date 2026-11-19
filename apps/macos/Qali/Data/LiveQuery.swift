import ConvexMobile
import Foundation
import Observation

/// A Convex query subscription as observable state.
///
/// Like the RN/web `useStableQuery`, it keeps the previous result while a new
/// subscription for changed arguments is loading, so views can show stale data
/// instead of flashing empty. Setting the same arguments again is a no-op, so
/// callers can assign derived arguments freely. Unchanged results are dropped.
@Observable
final class LiveQuery<Value: Decodable & Sendable & Equatable> {
  private(set) var value: Value?
  private(set) var error: Error?
  /// True from a change of arguments until their first result arrives; `value`
  /// is the previous arguments' result (or nil) in the meantime.
  private(set) var isLoading = false

  @ObservationIgnored private let client: ConvexClient
  @ObservationIgnored private let name: String
  @ObservationIgnored private var argsKey: String?
  @ObservationIgnored private var task: Task<Void, Never>?
  /// Called with every result for the current arguments, changed or not.
  @ObservationIgnored var onResult: ((Value) -> Void)?
  /// Called after `value`, `isLoading` or `error` may have changed, for
  /// state derived from them.
  @ObservationIgnored var onChange: (() -> Void)?

  init(_ client: ConvexClient, _ name: String, args: [String: ConvexEncodable?]? = [:]) {
    self.client = client
    self.name = name
    if let args { setArgs(args) }
  }

  /// Re-subscribes when `args` differ from the current ones; nil pauses the
  /// query (like Convex's `"skip"`) while keeping the last value.
  func setArgs(_ args: [String: ConvexEncodable?]?) {
    let key = args.flatMap { try? $0.convexEncode() }
    guard key != argsKey else { return }
    argsKey = key
    task?.cancel()
    task = nil
    guard let args else {
      isLoading = false
      onChange?()
      return
    }
    isLoading = true
    onChange?()

    let publisher = client.subscribe(to: name, with: args, yielding: Value.self)
    task = Task { [weak self] in
      do {
        for try await next in publisher.values {
          guard let self, !Task.isCancelled else { return }
          // The client re-reports every subscription on each server
          // transition (a sync writing rows sends a burst), usually with an
          // unchanged result; only a real change should invalidate views.
          self.onResult?(next)
          if self.value != next { self.value = next }
          if self.error != nil { self.error = nil }
          if self.isLoading { self.isLoading = false }
          self.onChange?()
        }
      } catch {
        guard let self, !Task.isCancelled else { return }
        self.error = error
        self.isLoading = false
        self.onChange?()
      }
    }
  }

  deinit {
    task?.cancel()
  }
}
