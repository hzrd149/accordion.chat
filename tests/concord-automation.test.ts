import { afterEach, beforeEach, expect, it, vi } from "vitest";

const KEY = "accordion:concordAutomation";
let values: Map<string, string>;

beforeEach(() => {
  vi.resetModules();
  values = new Map();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  });
});

afterEach(() => vi.unstubAllGlobals());

it.each([null, '{"autoUnlock":false}', '{"historySync":true}', "invalid"])(
  "defaults to background history sync with stored settings %s",
  async (stored) => {
    if (stored !== null) values.set(KEY, stored);
    const { activeConcordAutomation } = await import("../src/services/concord-automation");
    expect(activeConcordAutomation.historySync).toBe("background");
    if (stored === '{"autoUnlock":false}') expect(activeConcordAutomation.autoUnlock).toBe(false);
  },
);

it.each(["background", "off"] as const)("restores the %s history policy", async (historySync) => {
  values.set(KEY, JSON.stringify({ historySync }));
  const { activeConcordAutomation } = await import("../src/services/concord-automation");
  expect(activeConcordAutomation.historySync).toBe(historySync);
});

it("persists history changes without changing the active constructor options until reload", async () => {
  const { activeConcordAutomation, concordAutomation$, setConcordAutomation } =
    await import("../src/services/concord-automation");
  setConcordAutomation("historySync", "off");
  expect(concordAutomation$.value.historySync).toBe("off");
  expect(JSON.parse(values.get(KEY)!).historySync).toBe("off");
  expect(activeConcordAutomation.historySync).toBe("background");
  expect(concordAutomation$.value.autoUnlock).toBe(true);
  vi.resetModules();
  const reloaded = await import("../src/services/concord-automation");
  expect(reloaded.activeConcordAutomation.historySync).toBe("off");
});

it("does not update the preference when saving fails", async () => {
  const { concordAutomation$, setConcordAutomation } = await import("../src/services/concord-automation");
  vi.stubGlobal("localStorage", { setItem: () => { throw new Error("unavailable"); } });
  expect(() => setConcordAutomation("historySync", "off")).toThrow("Could not save");
  expect(concordAutomation$.value.historySync).toBe("background");
});
