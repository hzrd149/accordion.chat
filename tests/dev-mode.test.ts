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

it.each([false, true])("restores database diagnostics with developer mode %s at startup", async (enabled) => {
  if (enabled) values.set("accordion:devMode", "1");
  await import("../src/services/dev-mode");
  expect(configureDiagnostics).toHaveBeenCalledExactlyOnceWith({ debug: enabled, timing: enabled });
});

it("toggles logging and timings immediately alongside the preference and UI notification", async () => {
  const { setDevMode, getDevMode, DEV_MODE_CHANGE_EVENT } = await import("../src/services/dev-mode");
  const changed = vi.fn();
  window.addEventListener(DEV_MODE_CHANGE_EVENT, changed);

  for (const enabled of [true, false]) {
    setDevMode(enabled);
    expect(configureDiagnostics).toHaveBeenLastCalledWith({ debug: enabled, timing: enabled });
    expect(getDevMode()).toBe(enabled);
  }
  expect(changed).toHaveBeenCalledTimes(2);
});

it("keeps diagnostics usable when preference storage is unavailable", async () => {
  vi.stubGlobal("localStorage", {
    getItem: () => { throw new Error("unavailable"); },
    setItem: () => { throw new Error("unavailable"); },
    removeItem: () => { throw new Error("unavailable"); },
  });
  const { setDevMode } = await import("../src/services/dev-mode");
  expect(configureDiagnostics).toHaveBeenLastCalledWith({ debug: false, timing: false });
  setDevMode(true);
  expect(configureDiagnostics).toHaveBeenLastCalledWith({ debug: true, timing: true });
  setDevMode(false);
  expect(configureDiagnostics).toHaveBeenLastCalledWith({ debug: false, timing: false });
});
