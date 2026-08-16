/**
 * Provider-neutral calendar services: orchestration that runs against any
 * `CalendarProviderAdapter`, with no knowledge of Google or Microsoft. This is
 * where the domain will route once the connection model lands; today it exists
 * so the seam is exercised and proven neutral (see service.test.ts).
 */

import { ProviderError } from "./errors";
import type {
  CalendarProviderAdapter,
  CreateEventRequest,
  ProviderEvent,
} from "./types";

export {
  ExternalWriteCommittedError,
  isDefinitiveProviderFailure,
} from "./errors";

/**
 * Create an event, reconciling a create that may already have landed instead of
 * risking a duplicate.
 *
 * A `conflict` means the provider already holds a create for this idempotency
 * key (the retry-that-succeeded case); an `ambiguous` means the response was
 * lost and it might have. In both cases, if we hold an idempotency key we ask
 * the adapter to resolve it rather than blind-retry. The reconciliation is the
 * adapter's job — this function never assumes how a provider dedupes — which is
 * exactly what keeps ambiguous-create safety provider-neutral.
 */
export async function createEventReconciling(
  adapter: CalendarProviderAdapter,
  request: CreateEventRequest,
): Promise<ProviderEvent> {
  try {
    return await adapter.createEvent(request);
  } catch (error) {
    if (
      error instanceof ProviderError &&
      (error.kind === "conflict" || error.kind === "ambiguous") &&
      request.idempotencyKey !== undefined
    ) {
      const existing = await adapter.reconcileAmbiguousCreate({
        calendarId: request.calendarId,
        idempotencyKey: request.idempotencyKey,
      });
      if (existing) return existing;
    }
    throw error;
  }
}
