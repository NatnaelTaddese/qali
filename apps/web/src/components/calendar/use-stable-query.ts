import { useQuery } from "convex/react";
import { useRef } from "react";

/**
 * Like Convex's `useQuery`, but holds the previous result while the query is
 * re-loading after its args change or is temporarily skipped. Convex returns
 * `undefined` in both cases; retaining the last result supports
 * stale-while-revalidate UI without keeping an unused subscription alive.
 *
 * Cast to `typeof useQuery` so every call site keeps Convex's own inference.
 */
export const useStableQuery: typeof useQuery = ((...args: unknown[]) => {
  const result = (useQuery as (...a: unknown[]) => unknown)(...args);
  const stored = useRef(result);
  if (result !== undefined) stored.current = result;
  return result === undefined ? stored.current : result;
}) as typeof useQuery;
