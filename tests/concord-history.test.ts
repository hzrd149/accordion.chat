import { describe, expect, it } from "vitest";
import { bytesToHex, randomBytes } from "@noble/hashes/utils.js";
import { getPublicKey } from "applesauce-core/helpers/keys";
import type { DecodedEvent, JoinMaterial } from "@applesauce/concord";
import { buildRekeyRumors, bytesToBase64, rekeyLocator, ROOT_SCOPE_HEX } from "@applesauce/concord/helpers";
import { analyzeRotations, buildChain, diffMembers, generationRows, stringify } from "../src/helpers/concord-history";

const hex32 = () => bytesToHex(randomBytes(32));
const pubkey = () => getPublicKey(randomBytes(32));

function material(overrides: Partial<JoinMaterial> = {}): JoinMaterial {
  return {
    community_id: hex32(),
    owner: pubkey(),
    owner_salt: hex32(),
    community_root: "c2".repeat(32),
    root_epoch: 2,
    channels: [],
    relays: ["wss://relay.example"],
    name: "Test",
    refounder: "r2",
    control_pk: "cp2",
    held_roots: [
      { epoch: 1, key: "c1".repeat(32), refounder: "r1", control_pk: "cp1", retired_at: 2000 },
      { epoch: 0, key: "c0".repeat(32), retired_at: 1000 },
    ],
    ...overrides,
  };
}

describe("buildChain", () => {
  it("orders epochs and takes each epoch's own root, refounder and control address", () => {
    const chain = buildChain(material());
    expect(chain.map((m) => m.root_epoch)).toEqual([0, 1, 2]);
    expect(chain.map((m) => m.community_root)).toEqual(["c0".repeat(32), "c1".repeat(32), "c2".repeat(32)]);
    expect(chain.map((m) => m.refounder)).toEqual([undefined, "r1", "r2"]);
    expect(chain.map((m) => m.control_pk)).toEqual([undefined, "cp1", "cp2"]);
    expect(chain[2].held_roots?.map((r) => r.epoch)).toEqual([1, 0]);
    expect(chain[0].held_roots).toEqual([]);
  });

  it("dedupes a held duplicate of the current epoch in favour of the current root", () => {
    const m = material({ held_roots: [{ epoch: 2, key: "ff".repeat(32) }, { epoch: 1, key: "c1".repeat(32) }] });
    const chain = buildChain(m);
    expect(chain.map((x) => x.root_epoch)).toEqual([1, 2]);
    expect(chain[1].community_root).toBe("c2".repeat(32));
  });
});

describe("generationRows", () => {
  it("derives active/retired dates and flags gaps", () => {
    const rows = generationRows(material({ held_roots: [{ epoch: 0, key: "c0".repeat(32), retired_at: 1000 }] }));
    expect(rows.map((r) => [r.epoch, r.activeFrom, r.retiredAt, r.current, r.gapBefore])).toEqual([
      [0, undefined, 1000, false, false],
      [2, undefined, undefined, true, true],
    ]);
    expect(rows[0].rootFingerprint).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe("diffMembers", () => {
  it("reports added and removed members", () => {
    expect(diffMembers(new Set(["a", "b"]), new Set(["b", "c"]))).toEqual({ added: ["c"], removed: ["a"] });
    expect(diffMembers(undefined, new Set(["a"]))).toEqual({ added: [], removed: [] });
  });
});

describe("stringify", () => {
  it("redacts secret fields to fingerprints", () => {
    const out = stringify({ community_root: "aa".repeat(32), name: "x" }, true);
    expect(out).not.toContain("aa".repeat(32));
    expect(out).toMatch(/"community_root": "fp:[0-9a-f]{16}"/);
  });
});

describe("analyzeRotations", () => {
  async function rotationEvents(rotator: string, recipients: string[], extraBlobs: number) {
    const newEpoch = 3n;
    const blobs = [
      ...recipients.map((r) => ({ locator: rekeyLocator(rotator, r, ROOT_SCOPE_HEX, newEpoch), wrapped: bytesToBase64(randomBytes(64)) })),
      ...Array.from({ length: extraBlobs }, () => ({ locator: hex32(), wrapped: bytesToBase64(randomBytes(64)) })),
    ];
    const templates = await Promise.all(
      buildRekeyRumors({ scope: { kind: "root" }, newEpoch, prevEpoch: 2n, prevCommit: "ab".repeat(32) }, blobs, 1_700_000_000_123),
    );
    return templates.map(
      (t, i): DecodedEvent => ({
        rumor: { ...t, id: hex32(), pubkey: rotator } as DecodedEvent["rumor"],
        author: rotator,
        wrapId: `wrap${i}`,
        sealKind: 13,
        ms: 1_700_000_000_123,
      }),
    );
  }

  it("splits epoch members into rekeyed and not rekeyed, and maps chunks to relays", async () => {
    const rotator = pubkey();
    const kept = [pubkey(), pubkey()];
    const dropped = pubkey();
    const events = await rotationEvents(rotator, kept, 0);
    const { rotations, malformed } = analyzeRotations(events, [...kept, dropped], new Map([["wrap0", new Set(["wss://a"])]]));
    expect(malformed).toEqual([]);
    expect(rotations).toHaveLength(1);
    const r = rotations[0];
    expect(r.complete).toBe(true);
    expect(r.newEpoch).toBe(3);
    expect(r.prevEpoch).toBe(2);
    expect(r.blobCount).toBe(2);
    expect(r.rekeyed.sort()).toEqual([...kept].sort());
    expect(r.notRekeyed).toEqual([dropped]);
    expect(r.chunksByRelay.get("wss://a")).toEqual([1]);
    expect(r.firstMs).toBe(1_700_000_000_123);
  });

  it("reports a rotation with a missing chunk as incomplete", async () => {
    const rotator = pubkey();
    const events = await rotationEvents(rotator, [pubkey()], 200);
    expect(events.length).toBeGreaterThan(1);
    const { rotations } = analyzeRotations(events.slice(1), []);
    expect(rotations[0].complete).toBe(false);
    expect(rotations[0].missingIndexes).toContain(1);
  });
});
