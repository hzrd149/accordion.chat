import { describe, expect, it } from "vitest";
import type { CommunityState, Rumor } from "@applesauce/concord";
import { PERM } from "@applesauce/concord";
import { foldMembers, resolveStanding, rumorMs, snapshotAuthorities, vacVerifier } from "@applesauce/concord/helpers";
import { foldActivity, traceMembers } from "../src/helpers/member-trace";

const OWNER = "a".repeat(64);
const ALICE = "b".repeat(64);
const BOB = "c".repeat(64);
const MALLORY = "d".repeat(64);
const CID = "e".repeat(64);
const T = 1_700_000_000;

function state(over: Partial<CommunityState> = {}): CommunityState {
  return {
    material: { community_id: CID, owner: OWNER, name: "T", relays: [], root_epoch: 0, channels: [] },
    channels: [],
    roles: [],
    grants: new Map(),
    banlist: new Set(),
    inviteLinks: new Set(),
    members: new Set(),
    dissolved: false,
    ...over,
  } as unknown as CommunityState;
}

let n = 0;
const rumor = (kind: number, pubkey: string, sec: number, content = "", tags: string[][] = []): Rumor =>
  ({ id: String(++n).padStart(64, "0"), kind, pubkey, created_at: T + sec, content, tags: [["ms", "0"], ...tags] }) as Rumor;

const byKey = (traces: ReturnType<typeof traceMembers>) => new Map(traces.map((t) => [t.pubkey, t]));
const NOW = (T + 1000) * 1000;

describe("traceMembers", () => {
  it("lets the latest self-signed entry decide and supersedes earlier ones", () => {
    const gb = [rumor(3306, ALICE, 1, "join"), rumor(3306, ALICE, 2, "leave"), rumor(3306, BOB, 1, "join")];
    const t = byKey(traceMembers(state({ members: new Set([BOB]) }), gb, new Map(), NOW));
    expect(t.get(ALICE)).toMatchObject({ foldPresent: false, present: false, basis: "left" });
    expect(t.get(ALICE)!.entries.map((e) => e.outcome)).toEqual(["superseded", "decisive"]);
    expect(t.get(BOB)).toMatchObject({ foldPresent: true, present: true, basis: "join" });
  });

  it("ignores kicks without authority and snapshots from non-refounders", () => {
    const gb = [rumor(3306, ALICE, 1, "join"), rumor(3309, MALLORY, 2, "", [["p", ALICE]]), rumor(3312, MALLORY, 3, JSON.stringify([BOB]))];
    const t = byKey(traceMembers(state(), gb, new Map(), NOW));
    expect(t.get(ALICE)!.entries[1]).toMatchObject({ verb: "kick", outcome: "ignored", reason: "insufficient rank" });
    expect(t.get(ALICE)!.foldPresent).toBe(true);
    expect(t.get(BOB)!.entries[0]).toMatchObject({ verb: "snapshot", outcome: "ignored", reason: "not snapshot authority" });
    expect(t.get(BOB)!.foldPresent).toBe(false);
  });

  it("re-admits on activity newer than a departure, and bans override", () => {
    const gb = [rumor(3306, ALICE, 1, "leave"), rumor(3306, BOB, 1, "join")];
    const activity = foldActivity([{ label: "public channels", rumors: [rumor(9, ALICE, 5)] }]);
    const t = byKey(traceMembers(state({ banlist: new Set([BOB]) }), gb, activity, NOW));
    expect(t.get(ALICE)).toMatchObject({ foldPresent: true, basis: "activity", lastActivityMs: (T + 5) * 1000 });
    expect(t.get(BOB)).toMatchObject({ foldPresent: false, basis: "banned", banned: true });
  });

  it("flags entries dated more than an hour ahead", () => {
    const gb = [rumor(3306, ALICE, 1000 + 7200, "join")];
    const t = byKey(traceMembers(state(), gb, new Map(), NOW));
    expect(t.get(ALICE)!.entries[0]).toMatchObject({ outcome: "ignored", reason: "future dated" });
  });

  it("agrees with the SDK fold", () => {
    const s = state({ banlist: new Set([MALLORY]), bannedAt: new Map([[MALLORY, T + 3]]) });
    const gb = [
      rumor(3306, ALICE, 1, "join"),
      rumor(3306, ALICE, 4, "leave"),
      rumor(3306, BOB, 2, "join"),
      rumor(3309, OWNER, 6, "", [["p", BOB]]),
      rumor(3306, MALLORY, 2, "join"),
      rumor(3306, OWNER, 1, "join"),
    ];
    const chat = [rumor(9, ALICE, 8), rumor(9, MALLORY, 9)];
    const activity = foldActivity([{ label: "guestbook", rumors: gb }, { label: "chat", rumors: chat }]);
    const observed = new Map([...activity].map(([pk, a]) => [pk, a.lastMs]));
    const standing = (m: string) => resolveStanding(m, OWNER, new Map(), s.grants);
    const decoded = gb.map((r) => ({ rumor: r, author: r.pubkey, wrapId: r.id, sealKind: 13, ms: rumorMs(r) }));
    const sdk = foldMembers(decoded as never, observed, s.banlist, standing, NOW, snapshotAuthorities(s.material), vacVerifier(s, PERM.KICK), s.bannedAt);
    const replay = traceMembers(s, gb, activity, NOW).filter((t) => t.foldPresent).map((t) => t.pubkey);
    expect(new Set(replay)).toEqual(sdk);
  });
});
