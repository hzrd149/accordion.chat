// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { shortNpub } from "../src/helpers/util";

vi.mock("../src/nostr", async () => {
  const { EventStore } = await import("applesauce-core");
  return { eventStore: new EventStore() };
});

import { eventStore } from "../src/nostr";
import { UserAvatar, UserLabel, UserName } from "../src/components/User";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const container = document.createElement("div");
let root = createRoot(container);

afterEach(async () => {
  await act(() => root.unmount());
  root = createRoot(container);
  vi.restoreAllMocks();
});

describe("user components", () => {
  it.each(["", " ", "invalid", "ab", "g".repeat(64), "a".repeat(63), "a".repeat(65), null, undefined])(
    "renders a safe fallback without looking up invalid pubkey %j",
    async (pubkey) => {
      const lookup = vi.spyOn(eventStore, "replaceable");
      await act(() => root.render(createElement(UserName, { pubkey })));
      expect(container.textContent).toBe("Unknown user");
      await act(() => root.render(createElement(UserLabel, { pubkey })));
      expect(container.textContent).toBe("Unknown user");
      await act(() => root.render(createElement(UserAvatar, { pubkey })));
      expect(container.textContent).toBe("?");
      expect(lookup).not.toHaveBeenCalled();
    },
  );

  it("keeps the short npub fallback for valid keys and handles prop changes", async () => {
    const pubkey = "ab".repeat(32);
    await act(() => root.render(createElement(UserName, { pubkey })));
    expect(container.textContent).toBe(shortNpub(pubkey));
    await act(() => root.render(createElement(UserName, { pubkey: "" })));
    expect(container.textContent).toBe("Unknown user");
    await act(() => root.render(createElement(UserName, { pubkey })));
    expect(container.textContent).toBe(shortNpub(pubkey));
  });
});
