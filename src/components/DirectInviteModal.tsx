import { useMemo, useState } from "react";
import { AlertTriangle, Globe2, Loader2, Lock, Search, Users } from "lucide-react";
import { use$, useActiveAccount } from "applesauce-react/hooks";
import type { ChannelMetadata, ConcordCommunity } from "@applesauce/concord";
import { hasChannelKey } from "@applesauce/concord/helpers";
import { useCommunityUserSearch } from "../hooks/use-user-search";
import { useOpenRankingSearch } from "../hooks/use-open-ranking-search";
import { getOpenRankingProvider } from "../services/open-ranking";
import { parsePubkey, type UserSearchEntry } from "../helpers/user-search";
import { sendDirectInvite } from "../helpers/direct-invites";
import { shortNpub } from "../helpers/util";
import { Modal } from "./modals";
import { UserAvatar, UserName } from "./User";

type Scope = "members" | "global";
const EMPTY_MEMBERS: ReadonlySet<string> = new Set();

interface UserResult {
  pubkey: string;
  source: Scope;
  rank?: number;
  member: boolean;
}

function dedupeResults(results: UserResult[]): UserResult[] {
  const seen = new Set<string>();
  const out: UserResult[] = [];
  for (const result of results) {
    if (seen.has(result.pubkey)) continue;
    seen.add(result.pubkey);
    out.push(result);
  }
  return out;
}

export function DirectInviteModal({
  community,
  channel,
  onClose,
}: {
  community: ConcordCommunity;
  channel: ChannelMetadata | undefined;
  onClose: () => void;
}) {
  const account = useActiveAccount();
  const myPubkey = account?.pubkey ?? "";
  const privateChannel = Boolean(channel?.private);
  const [scope, setScope] = useState<Scope>(privateChannel ? "members" : "global");
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<UserResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // Pubkey of the last successful invite recipient, for the confirmation banner.
  const [sent, setSent] = useState("");

  const memberSet = use$(community.members$) ?? EMPTY_MEMBERS;
  // Members come from the community's local index; Open Ranking is only the
  // network fallback for reaching people outside the community (global scope).
  const { search: searchMembers } = useCommunityUserSearch(community);
  const global = useOpenRankingSearch(query, { enabled: scope === "global" });
  const provider = getOpenRankingProvider();

  // The package's own key-presence check against material — a private channel we
  // hold no key for cannot be granted, since we have no key to hand over.
  const heldChannel = channel?.private ? hasChannelKey(community.material, channel.channel_id) : false;

  const { results, localMatches } = useMemo(() => {
    const exact = parsePubkey(query);
    const q = query.trim();
    const exactResult = exact
      ? [{ pubkey: exact, source: scope, member: memberSet.has(exact), rank: 1 } satisfies UserResult]
      : [];
    const local = searchMembers(query, { exclude: myPubkey ? [myPubkey] : undefined });
    const localMatches = new Map(local.map((c) => [c.pubkey, c] as const));
    const memberResults = local.map((c): UserResult => ({ pubkey: c.pubkey, source: "members", member: true }));
    if (scope === "members") {
      return {
        results: dedupeResults([...exactResult.filter((r) => r.member && r.pubkey !== myPubkey), ...memberResults]),
        localMatches,
      };
    }
    // Global: local member hits first (instant, no network), then Open Ranking
    // results for everyone else.
    return {
      results: dedupeResults([
        ...exactResult.filter((r) => r.pubkey !== myPubkey),
        ...(q && !exact ? memberResults : []),
        ...(q && !exact ? global.results : [])
          .filter((r) => r.pubkey !== myPubkey)
          .map((r): UserResult => ({ pubkey: r.pubkey, source: "global", rank: r.rank, member: memberSet.has(r.pubkey) })),
      ]),
      localMatches,
    };
  }, [global.results, memberSet, myPubkey, query, scope, searchMembers]);

  const selectedIsNonMember = selected ? !memberSet.has(selected.pubkey) : false;
  const privateGlobalInvite = privateChannel && selectedIsNonMember;
  const canSend = selected && !busy && (!privateChannel || heldChannel);

  async function send() {
    if (!selected || busy) return;
    setBusy(true);
    setError("");
    setSent("");
    try {
      await sendDirectInvite(community, selected.pubkey, {
        channels: privateChannel && channel ? [channel.channel_id] : undefined,
      });
      setSent(selected.pubkey);
      setSelected(null);
      setQuery("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to send invite");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal onClose={busy ? () => {} : onClose}>
      <h2 className="text-xl font-bold mb-1">Direct invite</h2>
      <p className="text-sm opacity-70 mb-4">
        Send an encrypted invite directly to a user's Nostr inbox. This is separate from invite links.
      </p>

      {privateChannel && channel && (
        <div className="alert alert-warning text-sm mb-4 items-start">
          <Lock size={18} className="mt-0.5" />
          <span>
            This invite grants access to <strong>#{channel.name}</strong>. If the user is not already a member, accepting it
            joins them to the community and grants this private channel.
          </span>
        </div>
      )}
      {privateChannel && !heldChannel && (
        <div className="alert alert-error text-sm mb-4">You do not hold this private channel key, so you cannot grant it.</div>
      )}
      {(error || global.error) && <div className="alert alert-error text-sm mb-4">{error || global.error}</div>}
      {sent && <div className="alert alert-success text-sm mb-4"><span>Invite sent to <UserName pubkey={sent} /></span></div>}

      {privateChannel && (
        <div className="join mb-3">
          <button className={`btn btn-sm join-item ${scope === "members" ? "btn-active" : ""}`} onClick={() => setScope("members")}>
            <Users size={15} /> Members
          </button>
          <button className={`btn btn-sm join-item ${scope === "global" ? "btn-active" : ""}`} onClick={() => setScope("global")}>
            <Globe2 size={15} /> Global
          </button>
        </div>
      )}

      <label className="input input-bordered flex items-center gap-2 mb-3">
        <Search size={16} className="opacity-60" />
        <input
          className="grow"
          value={query}
          autoFocus
          placeholder={scope === "members" ? "Search community members" : "Search Nostr users"}
          onChange={(e) => {
            setQuery(e.target.value);
            setSelected(null);
            setSent("");
          }}
        />
        {global.searching && <Loader2 size={16} className="animate-spin opacity-60" />}
      </label>
      {scope === "global" && <p className="text-xs opacity-60 mb-3">Global search by Open Ranking provider: {provider}</p>}

      <div className="rounded-box border border-base-300 overflow-hidden max-h-72 overflow-y-auto">
        {results.length === 0 ? (
          <div className="p-5 text-center text-sm opacity-60">
            {query.trim() ? "No users found." : scope === "members" ? "Type to search members." : "Type a name, npub, or hex pubkey."}
          </div>
        ) : (
          results.map((result) => (
            <InviteUserRow
              key={result.pubkey}
              result={result}
              candidate={localMatches.get(result.pubkey)}
              selected={selected?.pubkey === result.pubkey}
              onClick={() => setSelected(result)}
            />
          ))
        )}
      </div>

      {privateGlobalInvite && channel && (
        <div className="flex items-start gap-2 text-warning text-sm mt-4">
          <AlertTriangle size={17} className="mt-0.5 shrink-0" />
          <span>
            This user is not a community member. Sending will invite them to the community and grant <strong>#{channel.name}</strong>.
          </span>
        </div>
      )}

      <div className="modal-action">
        <button className="btn btn-ghost" disabled={busy} onClick={onClose}>
          Close
        </button>
        <button className="btn btn-primary" disabled={!canSend} onClick={() => void send()}>
          {busy ? "Sending…" : "Send invite"}
        </button>
      </div>
    </Modal>
  );
}

function InviteUserRow({
  result,
  candidate,
  selected,
  onClick,
}: {
  result: UserResult;
  candidate?: UserSearchEntry;
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <button
      className={`w-full text-left flex items-center gap-3 p-3 border-b border-base-300 last:border-b-0 hover:bg-base-200 ${
        selected ? "bg-primary/10" : ""
      }`}
      onClick={onClick}
    >
      <UserAvatar pubkey={result.pubkey} className="w-9 h-9" />
      <span className="min-w-0 flex-1">
        <span className="font-semibold block truncate">
          {candidate?.name ?? <UserName pubkey={result.pubkey} />}
        </span>
        <span className="text-xs opacity-60 font-mono truncate block">{shortNpub(result.pubkey)}</span>
      </span>
      <span className="flex items-center gap-1.5 shrink-0">
        {result.member && <span className="badge badge-ghost badge-sm">Member</span>}
        {result.source === "global" && result.rank !== undefined && (
          <span className="badge badge-outline badge-sm">{Math.round(result.rank * 100)}</span>
        )}
      </span>
    </button>
  );
}
