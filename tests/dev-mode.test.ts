import { afterEach, beforeEach, expect, it, vi } from "vitest";

const configureDiagnostics = vi.hoisted(() => vi.fn());
vi.mock("nostr-idb", () => ({ configureDiagnostics }));

let values: Map<string, string>;

beforeEach(() => {
  vi.resetModules();
  configureDiagnostics.mockClear();
  values = new Map();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  });
  vi.stubGlobal("window", new EventTarget());
});

afterEach(() => vi.unstubAllGlobals());

it.each([false, true])("restores developer mode %s without enabling database diagnostics", async (enabled) => {
  if (enabled) values.set("accordion:devMode", "1");
  const { getDevMode } = await import("../src/services/dev-mode");
  expect(getDevMode()).toBe(enabled);
  expect(configureDiagnostics).not.toHaveBeenCalled();
});

it("updates the preference and UI without changing logging", async () => {
  const { setDevMode, getDevMode, DEV_MODE_CHANGE_EVENT } = await import("../src/services/dev-mode");
  const changed = vi.fn();
  window.addEventListener(DEV_MODE_CHANGE_EVENT, changed);

  for (const enabled of [true, false]) {
    setDevMode(enabled);
    expect(configureDiagnostics).not.toHaveBeenCalled();
    expect(getDevMode()).toBe(enabled);
  }
  expect(changed).toHaveBeenCalledTimes(2);
});

it("tolerates unavailable preference storage", async () => {
  vi.stubGlobal("localStorage", {
    getItem: () => { throw new Error("unavailable"); },
    setItem: () => { throw new Error("unavailable"); },
    removeItem: () => { throw new Error("unavailable"); },
  });
  const { setDevMode, getDevMode } = await import("../src/services/dev-mode");
  expect(getDevMode()).toBe(false);
  expect(() => setDevMode(true)).not.toThrow();
  expect(() => setDevMode(false)).not.toThrow();
  expect(configureDiagnostics).not.toHaveBeenCalled();
});
