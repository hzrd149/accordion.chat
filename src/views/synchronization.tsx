import type { ConcordCommunityStatus, ConcordDiagnostic, ConcordPrivateChannelStatus } from "@applesauce/concord";
import { normalizeURL } from "applesauce-core/helpers/url";
import { use$ } from "applesauce-react/hooks";
import { Activity, Loader2, Lock, Radio } from "lucide-react";
import type { ReactNode } from "react";
import { distinctUntilChanged, map } from "rxjs";
import { useCommunity } from "../hooks/use-community";
import { useConcord } from "../hooks/use-concord";
import { pool } from "../nostr";
import { syncActivity$ } from "../services/concord-sync-activity";

const phaseLabels = {
  idle: "Waiting to sync",
  syncing: "Catching up",
  live: "Up to date",
  removed: "Access removed",
  error: "Sync failed",
  dissolved: "Dissolved",
};

function Status({ status }: { status: ConcordCommunityStatus | ConcordPrivateChannelStatus }) {
  const tone = status.error || status.phase === "error" ? "badge-error"
    : status.phase === "syncing" ? "badge-info"
    : status.phase === "live" && status.connected ? "badge-success" : "badge-ghost";
  const label = status.error ? phaseLabels.error
    : status.phase === "live" && !status.connected ? "Caught up · offline"
    : phaseLabels[status.phase];
  return (
    <span className={`badge badge-soft h-auto py-1 text-base ${tone}`}>
      {status.phase === "syncing" && !status.error && <Loader2 size={16} className="motion-safe:animate-spin" aria-hidden="true" />}
      {label}
    </span>
  );
}

function Issues({ issues }: { issues: readonly ConcordDiagnostic[] }) {
  if (!issues.length) return <p className="text-base-content/70">No issues reported</p>;
  return (
    <ul className="space-y-2">
      {issues.map(({ stage, error, key }, index) => (
        <li key={index} className="rounded-box bg-warning/10 px-3 py-2 wrap-anywhere">
          <span className="font-medium">{stage.replaceAll("-", " ")}</span>
          {key && <span className="ml-2 font-mono text-base">{key}</span>}
          <p>{error instanceof Error ? error.message : String(error)}</p>
        </li>
      ))}
    </ul>
  );
}

function Relays({ urls }: { urls: string[] }) {
  const statuses = use$(pool.status$);
  if (!urls.length) return <p className="text-base-content/70">No relays yet</p>;
  return (
    <ul className="space-y-2">
      {urls.map((url) => {
        let connected = statuses?.[url]?.connected ?? false;
        try {
          connected = statuses?.[normalizeURL(url)]?.connected ?? connected;
        } catch {
          // Keep invalid relay targets visible as disconnected.
        }
        return <li key={url} className="flex items-start justify-between gap-3">
          <span className="font-mono text-base wrap-anywhere">{url}</span>
          <span className={`badge badge-soft h-auto shrink-0 py-1 text-base ${connected ? "badge-success" : "badge-ghost"}`}>
            {connected ? "Connected" : "Disconnected"}
          </span>
        </li>;
      })}
    </ul>
  );
}

function CommunitySync({ id }: { id: string }) {
  const client = useConcord();
  const community = useCommunity(id);
  const metadata = use$(community?.metadata$);
  const channels = use$(community?.channelViews$);
  const status = use$(community?.status$);
  const privateStatus = use$(community?.privateChannelStatus$);
  const relays = use$(community?.relays$);
  const activity = use$(() => syncActivity$(client, id), [client, id]);
  if (!community) return null;

  const publicCount = channels?.filter((channel) => !channel.private && !channel.deleted).length ?? 0;
  const privateChannels = new Map(
    community.material.channels.map(({ id, name }) => [id, { name, accessible: true }]),
  );
  for (const channel of channels ?? []) {
    if (channel.private && !channel.deleted) privateChannels.set(channel.channel_id, channel);
    if (channel.deleted) privateChannels.delete(channel.channel_id);
  }

  return (
    <section className="rounded-box border border-base-300 bg-base-100">
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-base-300 px-4 py-3">
        <h2 className="text-lg font-semibold wrap-anywhere">{metadata?.name ?? community.material.name}</h2>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <span className="text-base-content/70">{publicCount} public {publicCount === 1 ? "channel" : "channels"}</span>
          {status && <>
            <span className="text-base-content/70">Epoch {status.epoch}</span>
            <Status status={status} />
          </>}
        </div>
      </header>

      <div className="grid gap-5 p-4 lg:grid-cols-2">
        <section className="min-w-0 space-y-2">
          <h3 className="flex items-center gap-2 font-semibold"><Lock size={18} /> Private channels</h3>
          {privateChannels.size ? (
            <ul className="divide-y divide-base-300">
              {[...privateChannels].map(([channelId, channel]) => {
                const sync = privateStatus?.get(channelId);
                return (
                  <li key={channelId} className="py-2">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="min-w-0 wrap-anywhere">{channel.name}</span>
                      <span className="flex flex-wrap items-center gap-2">
                        {sync && <span className="text-base-content/70">Epoch {sync.epoch}</span>}
                        {sync ? <Status status={sync} /> : <span className="badge badge-ghost h-auto py-1 text-base">
                          {channel.accessible ? "Waiting to sync" : "No access"}
                        </span>}
                      </span>
                    </div>
                    {sync?.error && <p className="text-error wrap-anywhere">{sync.error}</p>}
                  </li>
                );
              })}
            </ul>
          ) : <p className="text-base-content/70">No private channels yet</p>}
        </section>

        <section className="min-w-0 space-y-2">
          <h3 className="flex items-center gap-2 font-semibold"><Radio size={18} /> Relays</h3>
          <Relays urls={relays ?? []} />
        </section>

        <section className="min-w-0 space-y-2">
          <h3 className="flex items-center gap-2 font-semibold"><Activity size={18} /> Recent local activity</h3>
          {activity?.events.length ? (
            <ul className="max-h-52 space-y-1 overflow-y-auto">
              {activity.events.map(({ id, kind, observedAt, source }, index) => (
                <li key={`${source}:${id}:${observedAt}:${index}`} className="flex flex-wrap justify-between gap-x-2 rounded bg-base-200 px-3 py-2">
                  <span className="min-w-0 wrap-anywhere">{privateChannels.get(source)?.name ?? source} · Kind {kind}</span>
                  <span className="font-mono" title={id}>{id.slice(0, 10)}</span>
                  <time dateTime={new Date(observedAt).toISOString()}>{new Date(observedAt).toLocaleTimeString()}</time>
                </li>
              ))}
            </ul>
          ) : <p className="text-base-content/70">No events yet</p>}
        </section>

        <section className="min-w-0 space-y-2">
          <h3 className="font-semibold">Issues</h3>
          {status?.error && <p className="text-error wrap-anywhere">{status.error}</p>}
          {(!status?.error || !!activity?.issues.length) && <Issues issues={activity?.issues ?? []} />}
        </section>
      </div>
    </section>
  );
}

export function SynchronizationView({ mobileNav }: { mobileNav: ReactNode }) {
  const client = useConcord();
  const status = use$(client.status$);
  const list = use$(() => client.memberships$.pipe(map(({ knowledge, locked, pending }) => ({ knowledge, locked, pending }))), [client]);
  const dirty = use$(client.communityListDirty$);
  const activity = use$(() => syncActivity$(client), [client]);
  const ids = use$(() => client.communities$.pipe(
    map((states) => states.map(({ material }) => material.community_id)),
    distinctUntilChanged((a, b) => a.length === b.length && a.every((id, index) => id === b[index])),
  ), [client]);
  const listStatus = list?.locked ? "Decryption pending"
    : list?.knowledge === "complete" ? "Restored"
    : list?.knowledge === "confirmed-empty" ? "No saved communities on relays"
    : list?.knowledge === "partial" ? "Partially restored"
    : status?.phase === "ready" ? "Relay copy unconfirmed" : "Looking up encrypted list";

  const communityCount = ids?.length ?? 0;
  const liveCount = status?.live ?? 0;
  const lookingUpList = !list?.locked && (!list || list.knowledge === "unknown") && status?.phase !== "ready";

  return (
    <main className="flex min-w-0 flex-1 flex-col bg-base-200">
      <header className="flex shrink-0 items-center gap-3 border-b border-base-300 bg-base-100 px-4 py-3">
        {mobileNav}
        <h1 className="text-xl font-semibold">Synchronization</h1>
      </header>
      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto flex max-w-6xl flex-col gap-4 p-4 md:p-6">
          <section className="rounded-box border border-base-300 bg-base-100 p-4">
            <h2 className="text-lg font-semibold">Community list</h2>
            <div role="status" className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-2">
              <span className="flex items-center gap-2">
                {lookingUpList && <Loader2 size={18} className="text-info motion-safe:animate-spin" aria-hidden="true" />}
                {listStatus}
              </span>
              {(dirty || list?.pending) && <span className="badge badge-warning badge-soft h-auto py-1 text-base">Changes pending</span>}
            </div>
            {communityCount > 0 && <div className="mt-3 max-w-md">
              <label className="font-medium" htmlFor="community-sync-progress">
                {liveCount} of {communityCount} communities up to date
              </label>
              <progress id="community-sync-progress" className="progress progress-primary mt-2 block w-full" value={liveCount} max={communityCount} />
            </div>}
            {!!activity?.issues.length && <div className="mt-3"><Issues issues={activity.issues} /></div>}
          </section>
          {ids?.map((id) => <CommunitySync key={id} id={id} />)}
          {!communityCount && status?.phase === "ready" && list?.knowledge !== "confirmed-empty" && (
            <p className="px-1 text-base-content/70">No communities loaded</p>
          )}
        </div>
      </div>
    </main>
  );
}
