import { useMemo, useState } from "react";
import { ArrowLeft, Check, CircleCheck, Loader2, Lock, Search, X } from "lucide-react";
import { use$, useActiveAccount } from "applesauce-react/hooks";
import type { ChannelMetadata, ConcordCommunity } from "@applesauce/concord";
import { hasChannelKey } from "@applesauce/concord/helpers";
import { useCommunityUserSearch } from "../hooks/use-user-search";
import { useOpenRankingSearch } from "../hooks/use-open-ranking-search";
import { parsePubkey, type UserSearchEntry } from "../helpers/user-search";
import { sendDirectInvite, type DirectInviteStep } from "../helpers/direct-invites";
import { PublishRejectedError, type PublishVerdict } from "../helpers/publish";
import { shortNpub } from "../helpers/util";
import { Modal } from "./modals";
import { UserAvatar, UserName } from "./User";

type Scope = "members" | "global";
const EMPTY_MEMBERS: ReadonlySet<string> = new Set();

interface UserResult {
  pubkey: string;
  member: boolean;
}

/** pick → confirm → sending → done | failed. */
type Phase = "pick" | "confirm" | "sending" | "done" | "failed";

const STEPS: { step: DirectInviteStep; label: string }[] = [
  { step: "encrypt", label: "Encrypting invite" },
  { step: "relays", label: "Finding their inbox relays" },
  { step: "publish", label: "Delivering" },
];

function dedupe(results: UserResult[]): UserResult[] {
  const seen = new Set<string>();
  return results.filter((r) => !seen.has(r.pubkey) && seen.add(r.pubkey));
}

function relayHost(url: string): string {
  return url.replace(/^wss?:\/\//, "").replace(/\/$/, "");
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
  const communityName = use$(community.metadata$)?.name ?? "this community";
  const privateChannel = channel?.private ? channel : undefined;
  // The package's own key-presence check against material — a private channel we
  // hold no key for cannot be granted, since we have no key to hand over.
  const heldChannel = privateChannel ? hasChannelKey(community.material, privateChannel.channel_id) : true;

  const [scope, setScope] = useState<Scope>(privateChannel ? "members" : "global");
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<UserResult | null>(null);
  const [phase, setPhase] = useState<Phase>("pick");
  const [step, setStep] = useState<DirectInviteStep>("encrypt");
  const [relays, setRelays] = useState<{ total: string[]; inbox: number }>({ total: [], inbox: 0 });
  const [verdicts, setVerdicts] = useState<readonly PublishVerdict[]>([]);
  const [error, setError] = useState("");

  const memberSet = use$(community.members$) ?? EMPTY_MEMBERS;
  // Members come from the community's local index; Open Ranking is only the
  // network fallback for reaching people outside the community (global scope).
  const { search: searchMembers } = useCommunityUserSearch(community);
  const global = useOpenRankingSearch(query, { enabled: scope === "global" });

  const { results, localMatches } = useMemo(() => {
    const exact = parsePubkey(query);
    const q = query.trim();
    const local = searchMembers(query, { exclude: myPubkey ? [myPubkey] : undefined });
    const localMatches = new Map(local.map((c) => [c.pubkey, c] as const));
    const exactResult = exact ? [{ pubkey: exact, member: memberSet.has(exact) }] : [];
    const memberResults = local.map((c): UserResult => ({ pubkey: c.pubkey, member: true }));
    const all =
      scope === "members"
        ? [...exactResult.filter((r) => r.member), ...memberResults]
        : // Global: local member hits first (instant), then Open Ranking for everyone else.
          [
            ...exactResult,
            ...(q && !exact ? memberResults : []),
            ...(q && !exact ? global.results : []).map((r) => ({ pubkey: r.pubkey, member: memberSet.has(r.pubkey) })),
          ];
    return { results: dedupe(all.filter((r) => r.pubkey !== myPubkey)), localMatches };
  }, [global.results, memberSet, myPubkey, query, scope, searchMembers]);

  async function send() {
    if (!selected) return;
    setPhase("sending");
    setStep("encrypt");
    setRelays({ total: [], inbox: 0 });
    setVerdicts([]);
    setError("");
    try {
      const outcomes = await sendDirectInvite(community, selected.pubkey, {
        channels: privateChannel ? [privateChannel.channel_id] : undefined,
        onProgress: (p) => {
          setStep(p.step);
          if (p.step === "publish") setRelays({ total: p.relays, inbox: p.inboxRelays });
        },
      });
      setVerdicts(outcomes);
      setPhase("done");
    } catch (e) {
      if (e instanceof PublishRejectedError) setVerdicts(e.outcomes);
      setError(e instanceof Error ? e.message : "Failed to send invite");
      setPhase("failed");
    }
  }

  function reset() {
    setSelected(null);
    setQuery("");
    setPhase("pick");
  }

  const busy = phase === "sending";
  const target = privateChannel ? `#${privateChannel.name}` : communityName;

  if (phase === "pick")
    return (
      <Modal onClose={onClose}>
        <h2 className="text-lg font-bold mb-3 truncate">Invite to {target}</h2>
        <div className="flex gap-2 mb-2">
          <label className="input input-bordered flex items-center gap-2 flex-1">
            <Search size={16} className="opacity-50" />
            <input
              className="grow"
              value={query}
              autoFocus
              placeholder={scope === "members" ? "Search members" : "Name, npub or pubkey"}
              onChange={(e) => setQuery(e.target.value)}
            />
            {global.searching && <Loader2 size={16} className="animate-spin opacity-50" />}
          </label>
          {privateChannel && (
            <select className="select select-bordered w-auto" value={scope} onChange={(e) => setScope(e.target.value as Scope)}>
              <option value="members">Members</option>
              <option value="global">Everyone</option>
            </select>
          )}
        </div>
        {global.error && <p className="text-sm text-error mb-2">{global.error}</p>}
        <ul className="-mx-2 h-80 overflow-y-auto">
          {results.length === 0 ? (
            <li className="py-10 text-center text-sm opacity-50">{query.trim() ? "No users found" : ""}</li>
          ) : (
            results.map((result) => (
              <li key={result.pubkey}>
                <UserRow
                  result={result}
                  candidate={localMatches.get(result.pubkey)}
                  onClick={() => {
                    setSelected(result);
                    setPhase("confirm");
                  }}
                />
              </li>
            ))
          )}
        </ul>
      </Modal>
    );

  // confirm / sending / done / failed all centre on the chosen user.
  const pubkey = selected!.pubkey;
  const grantsChannelToOutsider = privateChannel && !selected!.member;
  const accepted = verdicts.filter((v) => v.ok).length;

  return (
    <Modal onClose={busy ? () => {} : onClose}>
      <div className="flex items-center gap-2 mb-4 h-8">
        {phase === "confirm" && (
          <button className="btn btn-ghost btn-sm btn-square -ml-2" aria-label="Back" onClick={() => setPhase("pick")}>
            <ArrowLeft size={18} />
          </button>
        )}
        <h2 className="text-lg font-bold truncate">
          {phase === "done" ? "Invite sent" : phase === "failed" ? "Invite not sent" : "Send invite"}
        </h2>
      </div>

      <div className="flex flex-col items-center text-center gap-1 mb-5">
        <div className="relative">
          <UserAvatar pubkey={pubkey} className="w-16 h-16" />
          {phase === "done" && (
            <CircleCheck size={22} className="absolute -bottom-1 -right-1 text-success bg-base-100 rounded-full" />
          )}
        </div>
        <div className="font-semibold text-lg mt-1">
          <UserName pubkey={pubkey} />
        </div>
        <div className="text-xs font-mono opacity-50">{shortNpub(pubkey)}</div>
        <div className="text-sm opacity-70 mt-2 flex items-center gap-1">
          {privateChannel && <Lock size={13} />}
          {phase === "done" ? "Invited to" : "Invite to"} <span className="font-semibold">{target}</span>
        </div>
        {phase === "confirm" && grantsChannelToOutsider && (
          <p className="text-xs text-warning mt-1">Not a member yet — this also invites them to {communityName}.</p>
        )}
        {phase === "confirm" && !heldChannel && (
          <p className="text-xs text-error mt-1">You don't hold this channel's key, so you can't grant it.</p>
        )}
      </div>

      {phase !== "confirm" && (
        <ul className="text-sm space-y-1.5 mb-2">
          {STEPS.map(({ step: s, label }, i) => {
            const current = STEPS.findIndex((x) => x.step === step);
            const state =
              phase === "done" || i < current ? "done" : i > current ? "todo" : phase === "failed" ? "failed" : "active";
            return (
              <li key={s} className={`flex items-center gap-2.5 ${state === "todo" ? "opacity-40" : ""}`}>
                <StepIcon state={state} />
                <span className="flex-1">
                  {s === "relays" && i < current
                    ? relays.inbox
                      ? `Found ${relays.inbox} inbox relay${relays.inbox === 1 ? "" : "s"}`
                      : "No inbox relays — using community relays"
                    : s === "publish" && relays.total.length
                      ? `${label} to ${relays.total.length} relay${relays.total.length === 1 ? "" : "s"}`
                      : label}
                </span>
              </li>
            );
          })}
          {verdicts.length > 0 && (
            <li className="pl-7 pt-1 space-y-0.5">
              {verdicts.map((v) => (
                <div key={v.from} className="flex items-center gap-2 text-xs" title={v.message}>
                  {v.ok ? <Check size={13} className="text-success" /> : <X size={13} className="text-error" />}
                  <span className="font-mono opacity-70 truncate">{relayHost(v.from)}</span>
                  {!v.ok && v.message && <span className="opacity-50 truncate">{v.message}</span>}
                </div>
              ))}
            </li>
          )}
        </ul>
      )}

      {phase === "done" && (
        <p className="text-sm text-success mt-3">
          Delivered to {accepted} of {verdicts.length} relay{verdicts.length === 1 ? "" : "s"}.
        </p>
      )}
      {phase === "failed" && (
        <p className="text-sm text-error mt-3">{verdicts.length ? "No relay accepted the invite." : error}</p>
      )}

      <div className="modal-action">
        {phase === "confirm" && (
          <>
            <button className="btn btn-ghost" onClick={() => setPhase("pick")}>
              Back
            </button>
            <button className="btn btn-primary" disabled={!heldChannel} onClick={() => void send()}>
              Send invite
            </button>
          </>
        )}
        {phase === "sending" && (
          <button className="btn btn-primary" disabled>
            Sending…
          </button>
        )}
        {phase === "done" && (
          <>
            <button className="btn btn-ghost" onClick={reset}>
              Invite someone else
            </button>
            <button className="btn btn-primary" onClick={onClose}>
              Done
            </button>
          </>
        )}
        {phase === "failed" && (
          <>
            <button className="btn btn-ghost" onClick={() => setPhase("pick")}>
              Back
            </button>
            <button className="btn btn-primary" onClick={() => void send()}>
              Retry
            </button>
          </>
        )}
      </div>
    </Modal>
  );
}

function StepIcon({ state }: { state: "done" | "active" | "failed" | "todo" }) {
  if (state === "done") return <Check size={16} className="text-success shrink-0" />;
  if (state === "active") return <Loader2 size={16} className="animate-spin shrink-0" />;
  if (state === "failed") return <X size={16} className="text-error shrink-0" />;
  return <span className="w-4 h-4 shrink-0 flex items-center justify-center"><span className="w-1.5 h-1.5 rounded-full bg-current" /></span>;
}

function UserRow({ result, candidate, onClick }: { result: UserResult; candidate?: UserSearchEntry; onClick: () => void }) {
  return (
    <button className="w-full text-left flex items-center gap-3 px-2 py-2 rounded-lg hover:bg-base-200" onClick={onClick}>
      <UserAvatar pubkey={result.pubkey} className="w-9 h-9" />
      <span className="min-w-0 flex-1">
        <span className="font-medium block truncate">{candidate?.name ?? <UserName pubkey={result.pubkey} />}</span>
        <span className="text-xs opacity-50 font-mono truncate block">{shortNpub(result.pubkey)}</span>
      </span>
      {result.member && <span className="text-xs opacity-50 shrink-0">Member</span>}
    </button>
  );
}
