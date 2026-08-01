/** Keep unread rows reachable while filling the rest of a bounded feed with
 * recent history. Rows present in both inputs are emitted only once. */
export function selectVisibleNotifications<T extends { _id: string }>(
  unread: readonly T[],
  recent: readonly T[],
  limit: number,
): T[] {
  const unreadIds = new Set(unread.map((row) => row._id));
  return [
    ...unread,
    ...recent.filter((row) => !unreadIds.has(row._id)),
  ].slice(0, limit);
}
