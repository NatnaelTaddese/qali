// @ts-expect-error Bun supplies its test module at runtime; the web app's
// TypeScript config intentionally includes browser globals only.
import { beforeEach, describe, expect, test } from "bun:test";
import { sounds } from "cuelume";

import {
  SOUND_FOR_KIND,
  isNotificationSoundsEnabled,
  playNotificationSound,
  setNotificationSoundsEnabled,
  subscribeNotificationSounds,
} from "./notification-sounds";

describe("SOUND_FOR_KIND", () => {
  test("maps every kind to a sound cuelume ships", () => {
    for (const name of Object.values(SOUND_FOR_KIND)) {
      expect(sounds).toContain(name);
    }
  });

  test("keeps reminders and booking requests distinguishable by ear", () => {
    expect(SOUND_FOR_KIND.reminder).not.toBe(SOUND_FOR_KIND.booking);
  });
});

describe("notification sounds preference", () => {
  beforeEach(() => {
    setNotificationSoundsEnabled(true);
  });

  test("defaults to on", () => {
    expect(isNotificationSoundsEnabled()).toBe(true);
  });

  test("round-trips through localStorage", () => {
    setNotificationSoundsEnabled(false);
    expect(isNotificationSoundsEnabled()).toBe(false);
    expect(localStorage.getItem("notification-sounds")).toBe("0");
    setNotificationSoundsEnabled(true);
    expect(localStorage.getItem("notification-sounds")).toBe("1");
  });

  test("notifies subscribers in this tab", () => {
    let calls = 0;
    const unsubscribe = subscribeNotificationSounds(() => {
      calls++;
    });
    setNotificationSoundsEnabled(false);
    expect(calls).toBe(1);
    unsubscribe();
    setNotificationSoundsEnabled(true);
    expect(calls).toBe(1);
  });
});

describe("playNotificationSound", () => {
  test("reports that nothing played while sounds are off", () => {
    setNotificationSoundsEnabled(false);
    expect(playNotificationSound("reminder")).toBe(false);
    setNotificationSoundsEnabled(true);
  });

  test("reports that nothing played without Web Audio", () => {
    // jsdom has no AudioContext, so the OS notification must keep its sound.
    expect(playNotificationSound("reminder")).toBe(false);
  });
});
