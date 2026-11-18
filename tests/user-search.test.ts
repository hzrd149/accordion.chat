import { describe, expect, it } from "vitest";
import { BehaviorSubject, Observable } from "rxjs";
import { nip19 } from "nostr-tools";
import { UserSearchIndex, type UserSearchProfile } from "../src/helpers/user-search";

const pk = (c: string) => c.repeat(64);
const tick = () => new Promise<void>((resolve) => queueMicrotask(resolve));

function setup(initial: string[], cached: Record<string, UserSearchProfile> = {}) {
  const members$ = new BehaviorSubject<ReadonlySet<string>>(new Set(initial));
  const profiles = new Map<string, BehaviorSubject<UserSearchProfile | undefined>>();
  const open = new Set<string>();
  const profile$ = (pubkey: string) =>
    new Observable<UserSearchProfile | undefined>((sub) => {
      let subject = profiles.get(pubkey);
      if (!subject) profiles.set(pubkey, (subject = new BehaviorSubject(cached[pubkey])));
      open.add(pubkey);
      const inner = subject.subscribe(sub);
      return () => {
        open.delete(pubkey);
        inner.unsubscribe();
      };
    });
  const index = new UserSearchIndex(members$, profile$);
  const setProfile = (pubkey: string, p: UserSearchProfile) => profiles.get(pubkey)!.next(p);
  return { index, members$, setProfile, open };
}

describe("UserSearchIndex", () => {
  it("indexes members by npub before profiles load, then upgrades names", async () => {
    const { index, setProfile } = setup([pk("a")]);
    await tick();
    const npub = nip19.npubEncode(pk("a"));
    expect(index.search(npub.slice(0, 20))[0]?.pubkey).toBe(pk("a"));
    expect(index.get(pk("a"))?.name).toMatch(/^npub1/);

    setProfile(pk("a"), { displayName: "Alice", name: "alice", nip05: "alice@example.com" });
    await tick();
    expect(index.get(pk("a"))?.name).toBe("Alice");
    expect(index.search("alic")[0]?.pubkey).toBe(pk("a"));
  });

  it("matches on display name, username and nip05", async () => {
    const { index } = setup([pk("a"), pk("b"), pk("c")], {
      [pk("a")]: { displayName: "Zed" },
      [pk("b")]: { name: "bobby" },
      [pk("c")]: { nip05: "carol@domain.test" },
    });
    await tick();
    expect(index.search("zed").map((e) => e.pubkey)).toEqual([pk("a")]);
    expect(index.search("bobby")[0]?.pubkey).toBe(pk("b"));
    expect(index.search("carol@domain")[0]?.pubkey).toBe(pk("c"));
  });

  it("lists by name on an empty query and resolves pasted pubkeys exactly", async () => {
    const { index } = setup([pk("a"), pk("b")], { [pk("a")]: { displayName: "Yvonne" }, [pk("b")]: { displayName: "Abe" } });
    await tick();
    expect(index.search("").map((e) => e.name)).toEqual(["Abe", "Yvonne"]);
    expect(index.search(nip19.npubEncode(pk("a"))).map((e) => e.pubkey)).toEqual([pk("a")]);
    expect(index.search(pk("c"))).toEqual([]);
  });

  it("honours exclude without shrinking results below the limit", async () => {
    const members = ["a", "b", "c", "d"].map(pk);
    const { index } = setup(members, Object.fromEntries(members.map((m, i) => [m, { displayName: `Sam ${i}` }])));
    await tick();
    const results = index.search("sam", { limit: 2, exclude: [pk("a"), pk("b")] });
    expect(results.map((e) => e.pubkey).sort()).toEqual([pk("c"), pk("d")]);
    expect(index.search("", { exclude: [pk("a")] }).some((e) => e.pubkey === pk("a"))).toBe(false);
  });

  it("drops removed members and closes their profile subscriptions", async () => {
    const { index, members$, open } = setup([pk("a"), pk("b")], { [pk("a")]: { displayName: "Ann" } });
    await tick();
    members$.next(new Set([pk("b")]));
    await tick();
    expect(index.search("ann")).toEqual([]);
    expect(index.get(pk("a"))).toBeUndefined();
    expect(open.has(pk("a"))).toBe(false);
  });

  it("coalesces a burst of updates into one version bump, including large rebuilds", async () => {
    const members = Array.from({ length: 50 }, (_, i) => i.toString(16).padStart(64, "0"));
    const { index, setProfile } = setup(members);
    await tick();
    const before = index.version$.value;
    members.forEach((m, i) => setProfile(m, { displayName: `User ${i}` }));
    await tick();
    expect(index.version$.value).toBe(before + 1);
    expect(index.search("User 42")[0]?.name).toBe("User 42");
    expect(index.size).toBe(50);
  });

  it("dispose unsubscribes everything", async () => {
    const { index, open } = setup([pk("a"), pk("b")]);
    await tick();
    let completed = false;
    index.version$.subscribe({ complete: () => (completed = true) });
    index.dispose();
    expect(open.size).toBe(0);
    expect(completed).toBe(true);
  });
});
