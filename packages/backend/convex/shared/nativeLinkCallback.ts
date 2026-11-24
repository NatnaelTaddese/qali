/**
 * Account linking from the native apps.
 *
 * A link's OAuth callback has to present a session for the user the link
 * belongs to (see `bindLinkCallbackToSession` in auth.ts). A web link passes
 * that check because the browser holds the session. A native link can't: the
 * app keeps its session cookie in its own Keychain, and the browser that
 * Google redirects back to has no session, or one for someone else.
 *
 * So when a link that started in a native app reaches the callback without
 * the right session, the callback's parameters are forwarded to the app over
 * its deep link (`qali:///link-callback/google?code=…&state=…`), and the app
 * replays them against `/callback/google` with its own session. Nothing in
 * the browser is linked or signed in.
 *
 * This can't be used to attach someone else's Google account. The forward
 * only goes to the native scheme, which opens the app on the device of
 * whoever consented. That app then has to present the session that started
 * the link. A link minted by an attacker and consented to by a victim
 * reaches the victim's app, whose session doesn't match, and is refused
 * there.
 */

/** The callback parameters Better Auth's `/callback/:id` reads. */
const FORWARDED_PARAMS = [
  "code",
  "state",
  "error",
  "error_description",
  "device_id",
  "user",
] as const;

/** The deep-link path the native app finishes a forwarded link at. */
export const NATIVE_LINK_CALLBACK_PATH = "/link-callback/";

/**
 * The deep link to hand a link callback to, or undefined when the link didn't
 * start in a native app (its stored `callbackURL` is not on a native origin)
 * or the request has nothing to forward.
 */
export function nativeLinkForwardURL(args: {
  /** The `callbackURL` saved in the OAuth state at `/link-social`. */
  callbackURL: string | undefined;
  /** The `:id` of `/callback/:id`, e.g. "google". */
  providerId: string | undefined;
  query: Record<string, unknown> | undefined;
  nativeOrigins: readonly string[];
}): string | undefined {
  const { callbackURL, providerId, query, nativeOrigins } = args;
  if (!callbackURL) return undefined;
  const origin = nativeOrigins.find((o) => callbackURL.startsWith(o));
  if (!origin) return undefined;
  if (!providerId || !/^[a-z0-9-]+$/.test(providerId)) return undefined;
  const params = new URLSearchParams();
  for (const key of FORWARDED_PARAMS) {
    const value = query?.[key];
    if (typeof value === "string") params.set(key, value);
  }
  if (!params.get("state")) return undefined;
  // "qali://" + "/link-callback/google" → "qali:///link-callback/google",
  // the same triple-slash form as the sign-in callback.
  return `${origin}${NATIVE_LINK_CALLBACK_PATH}${providerId}?${params.toString()}`;
}
