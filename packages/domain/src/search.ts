/** Event search limits shared by the dock's search input and the backend
 * query, so the box can never accept text the server would silently trim.
 * Import-free on purpose, like slug.ts. */

/** Longest query the search accepts. Convex tokenizes up to 16 terms; anything
 * past this is noise, and bounding it keeps a forged query from being costly. */
export const SEARCH_QUERY_MAX_LENGTH = 120;
