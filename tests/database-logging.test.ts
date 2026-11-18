import { afterEach, beforeEach, expect, it, vi } from "vitest";

const configureDiagnostics = vi.hoisted(() => vi.fn());
vi.mock("nostr-idb", () => ({ configureDiagnostics }));

const KEY = "accordion:databaseLogging";
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
});

afterEach(() => vi.unstubAllGlobals());

it.each([false, true])("restores database logging %s independently of developer mode", async (enabled) => {
  values.set("accordion:devMode", "1");
  if (enabled) values.set(KEY, "1");
  const { databaseLogging$ } = await import("../src/services/database-logging");
  expect(databaseLogging$.value).toBe(enabled);
  expect(configureDiagnostics).toHaveBeenCalledExactlyOnceWith({ debug: enabled, timing: enabled });
});

it("applies logging and timings immediately and persists the independent preference", async () => {
  const { databaseLogging$, setDatabaseLogging } = await import("../src/services/database-logging");
  const changed = vi.fn();
  const subscription = databaseLogging$.subscribe(changed);
  for (const enabled of [true, false]) {
    setDatabaseLogging(enabled);
    expect(configureDiagnostics).toHaveBeenLastCalledWith({ debug: enabled, timing: enabled });
    expect(changed).toHaveBeenLastCalledWith(enabled);
    expect(values.get(KEY)).toBe(enabled ? "1" : undefined);
    expect(values.has("accordion:devMode")).toBe(false);
  }
  subscription.unsubscribe();
});

it("keeps logging usable when preference storage is unavailable", async () => {
  vi.stubGlobal("localStorage", {
    getItem: () => { throw new Error("unavailable"); },
    setItem: () => { throw new Error("unavailable"); },
    removeItem: () => { throw new Error("unavailable"); },
  });
  const { databaseLogging$, setDatabaseLogging } = await import("../src/services/database-logging");
  expect(databaseLogging$.value).toBe(false);
  for (const enabled of [true, false]) {
    setDatabaseLogging(enabled);
    expect(databaseLogging$.value).toBe(enabled);
    expect(configureDiagnostics).toHaveBeenLastCalledWith({ debug: enabled, timing: enabled });
  }
});
