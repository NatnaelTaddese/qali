import { useQuery } from "convex/react";
import { useRef } from "react";

/**
 * Like Convex's `useQuery`, but holds the previous result while the query is
 * re-loading after its args change (Convex returns `undefined` during that
 * window). This keeps the calendar from flashing empty on the rare occasions
 * the buffered date window shifts. Args passed within an unchanged window keep
 * the same subscription and never re-load in the first place.
 *
 * Cast to `typeof useQuery` so every call site keeps Convex's own inference.
 */
export const useStableQuery: typeof useQuery = ((...args: unknown[]) => {
  const result = (useQuery as (...a: unknown[]) => unknown)(...args);
  const stored = useRef(result);
  if (result !== undefined) stored.current = result;
  return result === undefined ? stored.current : result;
}) as typeof useQuery;
