import type { Role } from "@applesauce/concord";
import { compareRanks } from "@applesauce/concord/helpers";

/** Preserve rank keys as strings: their authority order is bytewise, not numeric or locale-aware. */
export function roleRank(role: Role): number | string {
  return role.rank ?? role.position ?? 0xffffffff;
}

export function compareRoles(a: Role, b: Role): number {
  return compareRanks(roleRank(a), roleRank(b)) || a.role_id.localeCompare(b.role_id);
}

export function isCommunityRole(role: Role): boolean {
  return !role.deleted && (role.rank !== undefined || role.scope?.kind === "server");
}

/** Form validation only; the SDK remains the authority for the submitted edit. */
export function roleOrderPatch(role: Role, input: string): { rank: string } | { position: number } {
  if (role.rank !== undefined) {
    if (!/^[0-9A-Za-z]{0,31}[1-9A-Za-z]$/.test(input)) {
      throw new Error("Rank must be 1–32 ASCII letters or digits and cannot end in zero.");
    }
    return { rank: input };
  }
  const position = Number(input);
  if (!Number.isSafeInteger(position) || position < 1 || position >= 0xffffffff) {
    throw new Error("Position must be a positive integer below 4294967295.");
  }
  return { position };
}
