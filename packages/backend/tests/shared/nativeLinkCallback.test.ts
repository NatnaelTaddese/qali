// @ts-expect-error Bun supplies its test module at runtime.
import { describe, expect, test } from "bun:test";

import { nativeLinkForwardURL } from "../../convex/shared/nativeLinkCallback";

const nativeOrigins = ["qali://"];

describe("nativeLinkForwardURL", () => {
  test("forwards a native link's callback to the app's deep link", () => {
    const url = nativeLinkForwardURL({
      callbackURL: "qali:///?linked=google",
      providerId: "google",
      query: { code: "4/0Ab+c d", state: "st8", scope: "ignored", iss: "x" },
      nativeOrigins,
    });
    expect(url).toBe(
      "qali:///link-callback/google?code=4%2F0Ab%2Bc+d&state=st8",
    );
    const parsed = new URL(url!);
    expect(parsed.searchParams.get("code")).toBe("4/0Ab+c d");
  });

  test("forwards a provider error so the app can report it", () => {
    expect(
      nativeLinkForwardURL({
        callbackURL: "qali:///?linked=google",
        providerId: "google",
        query: { error: "access_denied", state: "st8" },
        nativeOrigins,
      }),
    ).toBe("qali:///link-callback/google?state=st8&error=access_denied");
  });

  test("leaves web links alone", () => {
    expect(
      nativeLinkForwardURL({
        callbackURL: "https://calendar.myqali.com/?linked=google",
        providerId: "google",
        query: { code: "c", state: "s" },
        nativeOrigins,
      }),
    ).toBeUndefined();
  });

  test("needs a state and a plain provider id", () => {
    const base = { callbackURL: "qali:///", nativeOrigins };
    expect(
      nativeLinkForwardURL({
        ...base,
        providerId: "google",
        query: { code: "c" },
      }),
    ).toBeUndefined();
    expect(
      nativeLinkForwardURL({
        ...base,
        providerId: "../x",
        query: { state: "s" },
      }),
    ).toBeUndefined();
    expect(
      nativeLinkForwardURL({
        ...base,
        providerId: undefined,
        query: { state: "s" },
      }),
    ).toBeUndefined();
    expect(
      nativeLinkForwardURL({
        ...base,
        callbackURL: undefined,
        providerId: "google",
        query: { state: "s" },
      }),
    ).toBeUndefined();
  });
});
