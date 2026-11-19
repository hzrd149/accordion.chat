import type { ConcordCommunity, Role } from "@applesauce/concord";
import { PERM } from "@applesauce/concord";
import { BehaviorSubject, firstValueFrom, of } from "rxjs";
import { describe, expect, it, vi } from "vitest";
import { compareRoles, isCommunityRole, roleOrderPatch, roleRank } from "../src/helpers/roles";
import { canChangeMemberRole$ } from "../src/helpers/role-grant-permission";

const legacy = (id: string, position: number): Role => ({
  role_id: id, position, name: id, scope: { kind: "server" }, color: 0, permissions: "0",
});
const ranked = (id: string, rank: string): Role => ({
  role_id: id, rank, name: id, color: 0, permissions: "0", display: true, mentionable: false,
});

describe("role presentation compatibility", () => {
  it("keeps legacy positions numeric and rank keys bytewise", () => {
    expect([legacy("junior", 10), legacy("senior", 2)].sort(compareRoles).map(roleRank)).toEqual([2, 10]);
    expect([ranked("lower", "a"), ranked("upper", "Z"), ranked("numeric", "9")]
      .sort(compareRoles).map(roleRank)).toEqual(["9", "Z", "a"]);
  });

  it("lists unscoped v2 roles alongside live legacy server roles, not membership markers or tombstones", () => {
    const channel: Role = { ...legacy("channel", 1), scope: { kind: "channel", channel_id: "ch" } };
    expect([ranked("new", "A"), legacy("old", 1), channel, { ...ranked("deleted", "B"), deleted: true }]
      .filter(isCommunityRole).map((role) => role.role_id)).toEqual(["new", "old"]);
  });

  it("edits rank keys without introducing a legacy position", () => {
    expect(roleOrderPatch(ranked("new", "A"), "B1")).toEqual({ rank: "B1" });
    expect(roleOrderPatch(legacy("old", 1), "2")).toEqual({ position: 2 });
    expect(() => roleOrderPatch(ranked("new", "A"), "B0")).toThrow(/Rank/);
    expect(() => roleOrderPatch(ranked("new", "A"), "é")).toThrow(/Rank/);
    expect(() => roleOrderPatch(legacy("old", 1), "2.5")).toThrow(/Position/);
    expect(() => roleOrderPatch(legacy("old", 1), "2junk")).toThrow(/Position/);
  });

  it("passes exact ranks for both changed and retained roles to SDK permission checks", async () => {
    const roles = [ranked("changed", "Z"), ranked("retained", "a")];
    const can = vi.fn(() => of(true));
    const community = {
      roles$: new BehaviorSubject(roles),
      grants$: new BehaviorSubject(new Map([["member", ["retained"]]])),
      dissolved$: new BehaviorSubject(false),
      canModerate$: vi.fn(() => of(true)),
      can$: can,
    } as unknown as ConcordCommunity;
    expect(await firstValueFrom(canChangeMemberRole$(community, "member", "changed"))).toBe(true);
    expect(can.mock.calls).toEqual([
      [PERM.MANAGE_ROLES, "Z"], [PERM.MANAGE_ROLES, "a"], [PERM.MANAGE_ROLES, "Z"],
    ]);
  });
});
