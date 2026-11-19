import { describe, expect, it } from "vitest";
import type { CommunityState, Rumor } from "@applesauce/concord";
import { computeEditionHash } from "@applesauce/concord/helpers";
import { compareRumorEditions, CONTROL_TEMPLATES, editionRumor, entityHead } from "../src/helpers/control-debug";

const OWNER = "a".repeat(64);
const MEMBER = "b".repeat(64);
const CID = "c".repeat(64);
const ROLE = "d".repeat(64);
const CHANNEL = "e".repeat(64);

function state(): CommunityState {
  return {
    material: { community_id: CID, owner: OWNER, name: "Test", relays: [] },
    metadata: { name: "Test" },
    channels: [{ channel_id: CHANNEL, name: "general", private: false }],
    roles: [{ role_id: ROLE, name: "Mod", position: 1, permissions: "0", scope: { kind: "server" } }],
    grants: new Map([[MEMBER, [ROLE]]]),
    banlist: new Set(),
    inviteLinks: new Set(),
    members: new Set([OWNER, MEMBER]),
    dissolved: false,
  } as unknown as CommunityState;
}

function metadataEdition(version: number | string, content: string, prevHash?: string): Rumor {
  const tags = [["vsk", "0"], ["eid", CID], ["ev", String(version)], ...(prevHash ? [["ep", prevHash]] : [])];
  return { id: String(version), kind: 3308, pubkey: OWNER, created_at: 0, content, tags } as Rumor;
}

describe("control debug templates", () => {
  it("builds every template against a folded state", () => {
    for (const t of CONTROL_TEMPLATES) {
      const target = t.param === "role" ? ROLE : t.param === "channel" ? CHANNEL : t.param === "member" ? MEMBER : "";
      expect(() => t.build({ state: state(), rumors: [], self: OWNER, target }), t.id).not.toThrow();
    }
  });

  it("chains the next edition onto the latest held head", () => {
    const content = '{"name":"Test"}';
    const rumors = [metadataEdition(1, content)];
    const head = entityHead(state(), rumors, CID);
    expect(head?.version).toBe(1);
    expect(head?.hash).toBe(computeEditionHash({ vsk: 0, eid: CID, version: 1, content }));

    const draft = CONTROL_TEMPLATES.find((t) => t.id === "metadata")!.build({ state: state(), rumors, self: OWNER, target: "" });
    expect(draft.mode).toBe("edition");
    if (draft.mode !== "edition") return;
    expect(draft.edition.ev).toBe("2");
    expect(draft.edition.ep).toBe(head?.hash);
  });

  it("omits vac for the owner and refuses auto vac for a member without a Grant", () => {
    const fields = { vsk: 0, eid: CID, ev: "1", ep: "", vacMode: "auto" as const, vac: "", content: "{}" };
    expect(editionRumor(fields, state(), OWNER).tags.some((t) => t[0] === "vac")).toBe(false);
    expect(() => editionRumor(fields, state(), MEMBER)).toThrow(/Grant/);
  });

  it("selects and hashes large edition counters without rounding adjacent versions", () => {
    const lower = metadataEdition("9007199254740992", '{"name":"Older"}');
    const higher = metadataEdition("9007199254740993", '{"name":"Newer"}');
    expect(compareRumorEditions(lower, higher)).toBe(-1);
    const head = entityHead(state(), [lower, higher], CID);
    expect(head?.version).toBe("9007199254740993");
    expect(head?.hash).toBe(computeEditionHash({ vsk: 0, eid: CID, version: "9007199254740993", content: higher.content }));
    const context = { state: state(), rumors: [lower, higher], self: OWNER, target: "" };
    for (const [id, expected] of [
      ["metadata", "9007199254740994"],
      ["inv-version-skip", "9007199254741043"],
      ["inv-downgrade", "9007199254740992"],
    ]) {
      const draft = CONTROL_TEMPLATES.find((template) => template.id === id)!.build(context);
      expect(draft.mode).toBe("edition");
      if (draft.mode === "edition") expect(draft.edition.ev).toBe(expected);
    }
  });

  it("preserves exact counters from the SDK's verified head", () => {
    const current = state();
    current.controlVerification = {
      heads: new Map([[CID, {
        version: "18446744073709551614", hash: "hash", edition: { rumor: { content: "{}" } },
      }]]),
    } as unknown as CommunityState["controlVerification"];
    const draft = CONTROL_TEMPLATES.find((template) => template.id === "metadata")!.build({
      state: current, rumors: [], self: OWNER, target: "",
    });
    expect(entityHead(current, [], CID)?.version).toBe("18446744073709551614");
    if (draft.mode === "edition") expect(draft.edition.ev).toBe("18446744073709551615");
  });
});
