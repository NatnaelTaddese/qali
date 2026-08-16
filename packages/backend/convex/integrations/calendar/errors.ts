/** Provider-neutral failures exposed by calendar adapters. */
export type ProviderErrorKind =
  | "authentication"
  | "permission"
  | "validation"
  | "not-found"
  | "conflict"
  | "cursor-expired"
  | "rate-limited"
  | "transient"
  | "ambiguous";

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

/** True only when the provider conclusively rejected the operation. */
export function isDefinitiveProviderFailure(error: unknown): boolean {
  return (
    error instanceof ProviderError &&
    error.kind !== "ambiguous" &&
    error.kind !== "transient" &&
    error.kind !== "rate-limited"
  );
}

/** The provider committed, but the app's local mirror/reconciliation did not. */
export class ExternalWriteCommittedError extends Error {
  constructor(
    readonly successSummary: string,
    readonly cause: unknown,
  ) {
    super(
      `The calendar provider accepted the change, but local reconciliation is pending: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
    this.name = "ExternalWriteCommittedError";
  }
}
