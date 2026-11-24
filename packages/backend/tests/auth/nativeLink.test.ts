// @ts-expect-error Bun supplies its test module at runtime.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { expo } from "@better-auth/expo";
import { crossDomain } from "@convex-dev/better-auth/plugins";
import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";

/**
 * The native link flow end to end on a real Better Auth instance, with the
 * production `bindLinkCallbackToSession` hook: `/link-social` from the app,
 * Google's redirect landing in a browser with no session, the forward back to
 * the app, and the app's replay. Google itself isn't reachable, so the replay
 * stops at the code exchange: `invalid_code` there means the hook let the
 * request through to the link handler.
 */

const SITE = "http://localhost:3001";
const BASE = "http://localhost:3211";

let hook: (typeof import("../../convex/auth"))["bindLinkCallbackToSession"];
let auth: ReturnType<typeof makeAuth>;

function makeAuth() {
  return betterAuth({
    baseURL: BASE,
    secret: "test-secret-test-secret-test-secret",
    trustedOrigins: [SITE, "qali://"],
    database: memoryAdapter({
      user: [],
      session: [],
      account: [],
      verification: [],
    }),
    emailAndPassword: { enabled: true },
    hooks: { before: hook },
    account: {
      accountLinking: {
        enabled: true,
        allowDifferentEmails: true,
        trustedProviders: ["google"],
      },
    },
    socialProviders: { google: { clientId: "id", clientSecret: "secret" } },
    // In production's order (see auth.ts); crossDomain stores OAuth state in
    // the database and skips the state cookie check.
    plugins: [expo(), crossDomain({ siteUrl: SITE })],
  });
}

async function signUp(email: string): Promise<string> {
  const response = await auth.handler(
    new Request(`${BASE}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { "content-type": "application/json", "expo-origin": "qali://" },
      body: JSON.stringify({ email, password: "password1234", name: email }),
    }),
  );
  expect(response.status).toBe(200);
  const cookie = response.headers.get("set-cookie") ?? "";
  return cookie.match(/better-auth\.session_token=[^;]+/)![0];
}

async function startLink(session: string): Promise<string> {
  const response = await auth.handler(
    new Request(`${BASE}/api/auth/link-social`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "expo-origin": "qali://",
        cookie: session,
      },
      body: JSON.stringify({
        provider: "google",
        callbackURL: "qali:///?linked=google",
        errorCallbackURL: "qali:///?linkError=google",
        disableRedirect: true,
      }),
    }),
  );
  expect(response.status).toBe(200);
  const { url } = (await response.json()) as { url: string };
  const authorize = new URL(url);
  expect(authorize.host).toBe("accounts.google.com");
  expect(authorize.searchParams.get("redirect_uri")).toBe(
    `${BASE}/api/auth/callback/google`,
  );
  return authorize.searchParams.get("state")!;
}

async function callback(
  query: string,
  headers: Record<string, string> = {},
): Promise<URL> {
  const response = await auth.handler(
    new Request(`${BASE}/api/auth/callback/google?${query}`, { headers }),
  );
  expect(response.status).toBe(302);
  return new URL(response.headers.get("location")!);
}

const realFetch = globalThis.fetch;

beforeAll(async () => {
  // Keep the code exchange offline: Google refuses the made-up code.
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(
      input instanceof Request ? input.url : input.toString(),
    );
    if (
      url.host.endsWith("googleapis.com") ||
      url.host === "accounts.google.com"
    ) {
      return Response.json({ error: "invalid_grant" }, { status: 400 });
    }
    return realFetch(input, init);
  }) as typeof fetch;
  process.env.SITE_URL ??= SITE;
  process.env.CONVEX_SITE_URL ??= BASE.replace("localhost", "test.convex.site");
  process.env.GOOGLE_CLIENT_ID ??= "id";
  process.env.GOOGLE_CLIENT_SECRET ??= "secret";
  hook = (await import("../../convex/auth")).bindLinkCallbackToSession;
  auth = makeAuth();
});

afterAll(() => {
  globalThis.fetch = realFetch;
});

describe("native account linking", () => {
  test("a browser without the session forwards the callback to the app", async () => {
    const session = await signUp("owner@example.com");
    const state = await startLink(session);

    const forward = await callback(`code=abc&state=${state}&scope=openid`);
    expect(forward.protocol).toBe("qali:");
    expect(forward.pathname).toBe("/link-callback/google");
    expect(forward.searchParams.get("code")).toBe("abc");
    expect(forward.searchParams.get("state")).toBe(state);

    // The app's replay, with its session, reaches the link handler (which then
    // fails only because "abc" isn't a real Google code).
    const done = await callback(forward.search.slice(1), {
      "expo-origin": "qali://",
      cookie: session,
    });
    expect(`${done.protocol}//${done.pathname}`).toBe("qali:///");
    expect(done.searchParams.get("linkError")).toBe("google");
    expect(done.searchParams.get("error")).toBe("invalid_code");
  });

  test("a replay from someone else's app is refused and the state consumed", async () => {
    const attacker = await signUp("attacker@example.com");
    const victim = await signUp("victim@example.com");
    const state = await startLink(attacker);

    const forward = await callback(`code=abc&state=${state}`);
    expect(forward.pathname).toBe("/link-callback/google");

    const refused = await callback(forward.search.slice(1), {
      "expo-origin": "qali://",
      cookie: victim,
    });
    expect(refused.searchParams.get("error")).toBe("link_session_mismatch");

    // Even the right session can't use the state now.
    const again = await callback(forward.search.slice(1), {
      "expo-origin": "qali://",
      cookie: attacker,
    });
    expect(again.searchParams.get("error")).toBe("state_mismatch");
  });

  test("a web link without the session is still refused in the browser", async () => {
    const session = await signUp("web@example.com");
    const response = await auth.handler(
      new Request(`${BASE}/api/auth/link-social`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: SITE,
          cookie: session,
        },
        body: JSON.stringify({
          provider: "google",
          callbackURL: `${SITE}/?linked=google`,
          errorCallbackURL: `${SITE}/?linkError=google`,
          disableRedirect: true,
        }),
      }),
    );
    const state = new URL(
      ((await response.json()) as { url: string }).url,
    ).searchParams.get("state");
    const refused = await callback(`code=abc&state=${state}`);
    expect(refused.origin).toBe(SITE);
    expect(refused.searchParams.get("error")).toBe("link_session_mismatch");
  });
});
