import { beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { BehaviorSubject, combineLatest, firstValueFrom, map, of } from "rxjs";
import type { Observable } from "rxjs";
import { PERM } from "@applesauce/concord";
import type { ConcordCommunity, Role } from "@applesauce/concord";
import { canChangeMemberRole$, channelMemberPermissions$ } from "../src/helpers/role-grant-permission";

const context = vi.hoisted(() => ({ community: undefined as unknown, owner: false, imageReason: undefined as string | undefined }));
vi.mock("../src/hooks/use-community", () => ({ useCommunity: () => context.community }));
vi.mock("../src/hooks/use-concord", () => ({ useConcord: () => ({ leave: vi.fn() }) }));
vi.mock("../src/hooks/use-dev-mode", () => ({ useDevMode: () => true }));
vi.mock("../src/hooks/useDecryptedImage", () => ({
  useDecryptedImage: () => null,
  useCommunityImage: () => ({ src: null, reason: context.imageReason }),
}));
vi.mock("../src/hooks/use-user-search", () => ({
  useCommunityUserSearch: () => ({ search: () => [] }),
  useCommunityUserNames: () => new Map(),
}));
vi.mock("../src/services/read-state", () => ({ clearCommunityReadState: vi.fn() }));
vi.mock("../src/services/toasts", () => ({ toastError: vi.fn(), toastSuccess: vi.fn() }));
vi.mock("../src/components/User", () => ({ UserAvatar: () => null, UserName: () => "Member" }));
vi.mock("../src/components/modals", () => ({ ConfirmModal: () => null }));
vi.mock("../src/components/dev/CommunityDebug", () => ({ CommunityDebugPage: () => null }));
vi.mock("../src/nostr", () => ({ pool: { relay: () => ({
  information$: of(undefined), icon$: of(undefined), connected$: of(false),
}) } }));
vi.mock("react-router", () => ({ useNavigate: () => vi.fn() }));
vi.mock("applesauce-react/hooks", () => ({
  useActiveAccount: () => ({ pubkey: context.owner ? "owner" : "viewer" }),
  // Server rendering does not run effects; synchronously read the mocked SDK streams.
  use$: (input?: Observable<unknown> | (() => Observable<unknown> | undefined)) => {
    const source = typeof input === "function" ? input() : input;
    let value: unknown;
    source?.subscribe((next) => { value = next; }).unsubscribe();
    return value;
  },
}));

import { CommunitySettingsView } from "../src/views/community-settings";

function role(id: string, position: number, channel = false): Role {
  return {
    role_id: id, name: id, position, permissions: PERM.MANAGE_METADATA.toString(), color: 0,
    scope: channel ? { kind: "channel", channel_id: "private" } : { kind: "server" },
  };
}

function fixture() {
  const permissions = new BehaviorSubject(0n);
  const rank = new BehaviorSubject(10);
  const targets = new BehaviorSubject(new Set(["junior"]));
  const roles = new BehaviorSubject([role("senior-role", 5), role("junior-role", 20), role("channel-role", 30, true)]);
  const grants = new BehaviorSubject(new Map([["junior", ["channel-role"]], ["senior", ["senior-role"]]]));
  const channels = new BehaviorSubject([{ channel_id: "private", name: "Private", private: true, accessible: true }]);
  const dissolved = new BehaviorSubject(false);
  const community = {
    material: { name: "Community", owner: "owner", relays: ["wss://example.com"] },
    metadata$: of({ name: "Community", description: "Read-only description", message_expiration: 3600 }),
    roles$: roles, grants$: grants, channelViews$: channels,
    members$: of(new Set(["owner", "viewer", "junior", "senior", "outsider"])),
    banlist$: of(new Set(["banned"])), dissolved$: dissolved,
    state$: of({ material: {} }),
    can$: (perm: bigint, position = 0xffffffff) => combineLatest([permissions, rank]).pipe(
      map(([bits, currentRank]) => (bits & perm) !== 0n && currentRank < position),
    ),
    canModerate$: (member: string, perm: bigint) => combineLatest([permissions, targets]).pipe(
      map(([bits, currentTargets]) => (bits & perm) !== 0n && currentTargets.has(member)),
    ),
  } as unknown as ConcordCommunity;
  return { community, permissions, rank, targets, roles, grants, channels, dissolved };
}

let state: ReturnType<typeof fixture>;
beforeEach(() => {
  state = fixture();
  context.community = state.community;
  context.owner = false;
  context.imageReason = undefined;
});

function render(page: string) {
  return renderToStaticMarkup(createElement(CommunitySettingsView, {
    cid: "community", page, mobileNav: null, onSelectPage: vi.fn(), onClose: vi.fn(),
  }));
}

describe("community settings visibility", () => {
  it("explains legacy SVG rejection and custom server download policy", () => {
    state.permissions.next(PERM.MANAGE_METADATA);
    context.imageReason = "unsupported-type";
    expect(render("overview")).toContain("including legacy SVG");
    expect(render("overview")).toContain('accept="image/png,image/jpeg,image/gif,image/webp"');
    context.imageReason = "download-failed";
    expect(render("overview")).toContain("Check the media server connection");
  });

  it("renders overview metadata and expiration read-only without metadata permission", () => {
    const html = render("overview");
    expect(html).toContain("Read-only description");
    expect(html).toContain("1 hour");
    expect(html).toContain("Leave community");
    expect(html).not.toMatch(/<input|<textarea|<select|Save changes|Dissolve community/);
  });

  it("shows metadata controls for a delegated manager, not just the owner", () => {
    state.permissions.next(PERM.MANAGE_METADATA);
    const html = render("overview");
    expect(html).toContain("<textarea");
    expect(html).toContain("Save changes");
    expect(html).toContain('aria-label="Message expiration"');
    expect(html).not.toContain("Dissolve community");
  });

  it("shows senior roles as information rather than disabled editing forms", () => {
    state.permissions.next(PERM.MANAGE_ROLES);
    const html = render("roles");
    expect(html).toContain("Manage Community");
    expect(html).not.toMatch(/<input|Save changes|Delete role|Add member/);
    expect(html).toContain("New role");
  });

  it("hides all role mutation forms without Manage Roles", () => {
    const html = render("roles");
    expect(html).not.toMatch(/<input|New role|Save changes|Delete role|Add member/);
  });

  it("shows editing and grant controls for a manageable role", () => {
    state.roles.next([role("junior-role", 20)]);
    state.permissions.next(PERM.MANAGE_ROLES);
    expect(render("roles")).toContain("Save changes");
  });

  it("keeps members, channels, network and advanced read-only without permission", () => {
    expect(render("members")).not.toMatch(/>Kick<|>Ban<|>Unban<|<input/);
    expect(render("channels")).not.toMatch(/<select|>Remove<|Delete<\/button/);
    expect(render("network")).not.toMatch(/<input|Save changes|title="Remove"/);
    expect(render("advanced")).not.toContain(">Rotate epoch</button>");
  });

  it("shows network and advanced mutations only with their respective permissions", () => {
    state.permissions.next(PERM.MANAGE_METADATA);
    expect(render("network")).toContain("<input");
    expect(render("advanced")).not.toContain(">Rotate epoch</button>");
    state.permissions.next(PERM.BAN);
    expect(render("network")).not.toContain("<input");
    expect(render("advanced")).toContain(">Rotate epoch</button>");
  });

  it("checks the banned member's rank before offering Unban", () => {
    state.permissions.next(PERM.BAN);
    expect(render("members")).not.toContain(">Unban</button>");
    state.targets.next(new Set(["banned"]));
    expect(render("members")).toContain(">Unban</button>");
  });

  it("does not offer a kick or role-stripping ban without Manage Roles", () => {
    state.permissions.next(PERM.KICK | PERM.BAN);
    const html = render("members");
    expect(html).not.toContain(">Kick</button>");
    expect(html).not.toContain(">Ban</button>");
    state.permissions.next(PERM.KICK | PERM.BAN | PERM.MANAGE_ROLES);
    expect(render("members")).toContain(">Kick</button>");
    expect(render("members")).toContain(">Ban</button>");
  });

  it("does not show removal of senior members or self in private channels", () => {
    state.permissions.next(PERM.MANAGE_CHANNELS | PERM.MANAGE_ROLES);
    const html = render("channels");
    expect((html.match(/>Remove<\/button>/g) ?? []).length).toBe(1);
    expect(html).not.toContain("<select"); // outsiders cannot receive a Role Grant
  });

  it("does not show membership controls for channels without a held key", () => {
    state.permissions.next(PERM.MANAGE_CHANNELS | PERM.MANAGE_ROLES);
    state.channels.next([{ channel_id: "private", name: "Private", private: true, accessible: false }]);
    expect(render("channels")).not.toMatch(/<select|>Remove<\/button>/);
  });

  it("offers only eligible members when adding to a private channel", () => {
    state.permissions.next(PERM.MANAGE_CHANNELS | PERM.MANAGE_ROLES);
    state.targets.next(new Set(["junior", "outsider"]));
    const html = render("channels");
    expect(html).toContain("<select");
    expect(html).toContain('value="outsider"');
    expect(html).not.toContain('value="senior"');
    expect(html).not.toContain('value="viewer"');
  });

  it("hides mutations in dissolved communities, even for the owner", () => {
    context.owner = true;
    state.permissions.next(Object.values(PERM).reduce((a, b) => a | b, 0n));
    state.dissolved.next(true);
    for (const page of ["overview", "roles", "members", "channels", "network", "advanced"]) {
      expect(render(page)).not.toMatch(/<input|<textarea|<select|Save changes|Dissolve community|>Unban<|>Remove<|>Rotate epoch<\/button>/);
    }
  });
});

describe("Role Grant eligibility", () => {
  it("requires both target moderation and the changed role's rank", async () => {
    state.permissions.next(PERM.MANAGE_ROLES);
    expect(await firstValueFrom(canChangeMemberRole$(state.community, "senior", "channel-role"))).toBe(false);
    expect(await firstValueFrom(canChangeMemberRole$(state.community, "junior", "senior-role"))).toBe(false);
    expect(await firstValueFrom(canChangeMemberRole$(state.community, "junior", "junior-role"))).toBe(true);
  });

  it("rejects a grant that retains an unsupported or senior role", async () => {
    state.permissions.next(PERM.MANAGE_ROLES);
    state.grants.next(new Map([["junior", ["senior-role"]]]));
    expect(await firstValueFrom(canChangeMemberRole$(state.community, "junior", "junior-role"))).toBe(false);
    state.grants.next(new Map([["junior", ["unknown-role"]]]));
    expect(await firstValueFrom(canChangeMemberRole$(state.community, "junior", "junior-role"))).toBe(false);
  });

  it("updates eligibility when grants or dissolution change", () => {
    state.permissions.next(PERM.MANAGE_ROLES);
    const values: boolean[] = [];
    const sub = canChangeMemberRole$(state.community, "junior", "junior-role").subscribe((value) => values.push(value));
    state.grants.next(new Map([["junior", ["senior-role"]]]));
    state.grants.next(new Map());
    state.dissolved.next(true);
    expect(values).toEqual([true, false, true, false]);
    sub.unsubscribe();
  });

  it("requires Manage Roles as well as Manage Channels when updating the roster", async () => {
    state.permissions.next(PERM.MANAGE_CHANNELS);
    const allowed = await firstValueFrom(channelMemberPermissions$(state.community, "private"));
    expect(allowed.add.size).toBe(0);
    expect(allowed.remove.size).toBe(0);
  });

  it("reacts to permission revocation and role rank changes", () => {
    state.permissions.next(PERM.MANAGE_ROLES);
    const values: boolean[] = [];
    const sub = canChangeMemberRole$(state.community, "junior", "junior-role").subscribe((value) => values.push(value));
    state.permissions.next(0n);
    state.permissions.next(PERM.MANAGE_ROLES);
    state.rank.next(25);
    expect(values).toEqual([true, false, true, false]);
    sub.unsubscribe();
  });
});
