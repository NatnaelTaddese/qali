import ConvexMobile

// ConvexMobile predates strict concurrency: its clients are plain classes whose
// async methods are nonisolated. All state lives behind the thread-safe Rust
// core (plus Combine subjects), and the library's own examples share one
// client across tasks, so vouch for that here instead of wrapping every call.
extension ConvexClient: @retroactive @unchecked Sendable {}
