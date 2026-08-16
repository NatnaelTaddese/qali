/**
 * Provider-neutral error taxonomy. Every calendar adapter classifies its
 * transport's failures into one of these `kind`s so the domain layer can decide
 * retry / surface / reconcile without knowing whether the provider was Google or
 * Microsoft. A Google 410 and a Graph `syncStateNotFound` both become
 * `cursor-expired`; a 409 and a Graph `ErrorItemAlreadyExists` both become
 * `conflict`.
 */
export type ProviderErrorKind =
  | "authentication" // token missing/expired/revoked — re-auth needed
  | "permission" // authenticated but not allowed (read-only calendar, etc.)
  | "validation" // the request itself was malformed/rejected
  | "not-found" // the target calendar/event does not exist
  | "conflict" // a write collided (e.g. duplicate idempotency key)
  | "cursor-expired" // an opaque sync cursor is no longer valid — full resync
  | "rate-limited" // provider throttled us; see retryAfterMs
  | "transient" // a retryable network/5xx blip
  | "ambiguous"; // the write may or may not have landed (lost response)

/**
 * A classified provider failure. `retryable` and `retryAfterMs` let the caller
 * schedule a retry without re-inspecting the kind. `ambiguous` is deliberately
 * distinct from `transient`: an ambiguous create must be reconciled against its
 * idempotency key rather than blindly retried, because a blind retry could
 * double-book (this is the whole reason the write path carries an idempotency
 * key — see the port's `reconcileAmbiguousCreate`).
 */
export class ProviderError extends Error {
  constructor(
    readonly kind: ProviderErrorKind,
    message: string,
    readonly options: {
      readonly retryable?: boolean;
      readonly retryAfterMs?: number;
      readonly cause?: unknown;
    } = {},
  ) {
    super(message);
    this.name = "ProviderError";
  }

  get retryable(): boolean {
    return (
      this.options.retryable ??
      (this.kind === "transient" || this.kind === "rate-limited")
    );
  }

  get retryAfterMs(): number | undefined {
    return this.options.retryAfterMs;
  }
}
