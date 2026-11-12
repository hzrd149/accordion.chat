import { describe, expect, it } from "vitest";
import { defaultRoute } from "../src/helpers/route-defaults";

describe("route defaults", () => {
  it.each([
    "/settings", "/settings/appearance", "/settings/dm",
    "/c/one/settings", "/c/one/settings/roles", "/c/one/mentions",
    "/c/one/chosen", "/dm", "/dm/peer", "/invites",
    "/invite/bundle", "/dev", "/dev/crypto-history",
  ])("preserves %s even while the previous community is retained", (pathname) => {
    expect(defaultRoute(pathname, "one", "one", "general")).toBeUndefined();
  });

  it("selects defaults only on landing routes", () => {
    expect(defaultRoute("/", "one", undefined, undefined)).toBe("/c/one");
    expect(defaultRoute("/c/one", "one", "one", "general")).toBe("/c/one/general");
    expect(defaultRoute("/c/one/", "one", "one", "general")).toBe("/c/one/general");
  });

  it("waits for the requested community instead of redirecting to the previous one", () => {
    expect(defaultRoute("/c/two", "one", "one", "general")).toBeUndefined();
    expect(defaultRoute("/c/two", "one", undefined, undefined)).toBeUndefined();
    expect(defaultRoute("/c/two", "one", "two", "other")).toBe("/c/two/other");
  });

  it("waits for communities and channels to load", () => {
    expect(defaultRoute("/", undefined, undefined, undefined)).toBeUndefined();
    expect(defaultRoute("/c/one", "one", "one", undefined)).toBeUndefined();
  });
});
