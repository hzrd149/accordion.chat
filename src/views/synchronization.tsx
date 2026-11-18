import type { ConcordCommunityStatus, ConcordDiagnostic, ConcordPrivateChannelStatus } from "@applesauce/concord";
import { normalizeURL } from "applesauce-core/helpers/url";
import { use$ } from "applesauce-react/hooks";
import { Activity, CircleCheck, CircleMinus, Inbox, Loader2, Lock, Radio } from "lucide-react";
import type { ReactNode } from "react";
import { debounce, distinctUntilChanged, map, of, timer } from "rxjs";
import type { Observable } from "rxjs";
import { RelayInfo } from "../components/ServerInfo";
import { ConcordDataCoverage } from "../components/ConcordDataCoverage";
import { useCommunity } from "../hooks/use-community";
import { useConcord } from "../hooks/use-concord";
import { pool } from "../nostr";
import { activeConcordAutomation } from "../services/concord-automation";
import { DIRECT_INVITE_ACTIVITY, syncActivity$ } from "../services/concord-sync-activity";

const phaseLabels = {
  idle: "Waiting to sync",
  syncing: "Preparing live sync",
  live: "Live sync ready",
  removed: "Access removed",
  error: "Sync failed",
  dissolved: "Dissolved",
};

function Status({ status }: { status: ConcordCommunityStatus | ConcordPrivateChannelStatus }) {
  const tone = status.error || status.phase === "error" ? "badge-error"
    : status.phase === "syncing" ? "badge-info"
    : status.phase === "live" && status.connected ? "badge-success" : "badge-ghost";
  const label = status.error ? phaseLabels.error
    : status.phase === "live" && !status.connected ? "Live sync ready · offline"
    : phaseLabels[status.phase];
  return (
    <span className={`badge badge-soft h-auto py-1 text-base ${tone}`}>
      {status.phase === "syncing" && !status.error && <Loader2 size={16} className="motion-safe:animate-spin" aria-hidden="true" />}
      {label}
    </span>
  );
}

// Show discoveries immediately. Give a transient empty snapshot time to recover
// before removing a section and moving everything below it.
function settleEmpty<T>(isEmpty: (value: T) => boolean) {
  return (source: Observable<T>) => source.pipe(
    debounce((value) => isEmpty(value) ? timer(500) : of(0)),
  );
}

const settleRelayTargets = settleEmpty<string[]>((urls) => !urls.length);

function Issues({ issues }: { issues: readonly ConcordDiagnostic[] }) {
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
  return (
    <ul className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,10rem),1fr))] gap-2">
      {urls.map((url) => {
        let connected = statuses?.[url]?.connected ?? false;
        try {
          connected = statuses?.[normalizeURL(url)]?.connected ?? connected;
        } catch {
          // Keep invalid relay targets visible as disconnected.
        }
        const StatusIcon = connected ? CircleCheck : CircleMinus;
        const label = connected ? "Connected" : "Disconnected";
        return <li key={url} className="flex min-w-0 items-center gap-2 rounded-md bg-base-200 px-2 py-1.5">
          <RelayInfo url={url} identityOnly />
          <span className={`shrink-0 ${connected ? "text-success" : "text-base-content/60"}`} title={label}>
            <StatusIcon size={17} aria-hidden="true" />
            <span className="sr-only">{label}</span>
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
  const channels = use$(() => community?.channelViews$.pipe(
    settleEmpty((views) => !views.some((channel) => channel.private && !channel.deleted)),
  ), [community]);
  const status = use$(community?.status$);
  const privateStatus = use$(community?.privateChannelStatus$);
  const syncError = use$(() => community?.status$.pipe(
    map(({ error }) => error),
    distinctUntilChanged(),
    settleEmpty((error) => !error),
  ), [community]);
  const relays = use$(() => community?.relays$.pipe(settleRelayTargets), [community]);
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

  const hasEvents = !!activity?.events.length;
  const hasIssues = !!syncError || !!activity?.issues.length;
  const hasRelays = !!relays?.length;
  const hasChannels = privateChannels.size > 0;

  return (
    <section className="rounded-box border border-base-300 bg-base-100">
      <header className="flex flex-wrap items-center justify-between gap-2 px-4 py-3">
        <h2 className="text-lg font-semibold wrap-anywhere">{metadata?.name ?? community.material.name}</h2>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          {publicCount > 0 && <span className="text-base-content/70">{publicCount} public {publicCount === 1 ? "channel" : "channels"}</span>}
          {status && <>
            <span className="text-base-content/70">Epoch {status.epoch}</span>
            <Status status={status} />
          </>}
        </div>
      </header>
      <ConcordDataCoverage community={community} historyEnabled={activeConcordAutomation.historySync === "background"} />

      {(hasChannels || hasRelays || hasEvents || hasIssues) && <div className="grid items-start gap-5 border-t border-base-300 p-4 lg:grid-cols-2">
        {hasChannels && <section className="min-w-0 space-y-2 lg:col-start-1 lg:only:col-span-2">
          <h3 className="flex items-center gap-2 font-semibold"><Lock size={18} /> Private channels</h3>
          <p className="text-base-content/70">Current-key readiness only; older private messages may still be loading.</p>
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
        </section>}

        {hasRelays && <section className="min-w-0 space-y-2 lg:col-start-2 lg:only:col-span-2 lg:only:col-start-1">
          <h3 className="flex items-center gap-2 font-semibold"><Radio size={18} /> Relays</h3>
          <Relays urls={relays} />
        </section>}

        {hasEvents && <section className="min-w-0 space-y-2 lg:col-start-1 lg:only:col-span-2">
          <h3 className="flex items-center gap-2 font-semibold"><Activity size={18} /> Recent local activity</h3>
          <ul className="max-h-52 space-y-1 overflow-y-auto">
            {activity.events.map(({ id, kind, observedAt, source }) => (
              <li key={`${source}:${id}:${observedAt}`} className="flex flex-wrap justify-between gap-x-2 rounded bg-base-200 px-3 py-2">
                <span className="min-w-0 wrap-anywhere">{privateChannels.get(source)?.name ?? source} · Kind {kind}</span>
                <span className="font-mono" title={id}>{id.slice(0, 10)}</span>
                <time dateTime={new Date(observedAt).toISOString()}>{new Date(observedAt).toLocaleTimeString()}</time>
              </li>
            ))}
          </ul>
        </section>}

        {hasIssues && <section className="min-w-0 space-y-2 lg:col-start-2 lg:only:col-span-2 lg:only:col-start-1">
          <h3 className="font-semibold">Issues</h3>
          {syncError && <p className="text-error wrap-anywhere">{syncError}</p>}
          {!!activity?.issues.length && <Issues issues={activity.issues} />}
        </section>}
      </div>}
    </section>
  );
}

function DirectInviteSync() {
  const client = useConcord();
  const phase = use$(client.phase$);
  const invites = use$(client.directInvites$);
  const receiver = client.giftWrapReceiver;
  const lifecycle = use$(receiver?.lifecycle$);
  const relays = use$(() => receiver?.readRelays$.pipe(settleRelayTargets), [receiver]);
  const activity = use$(() => syncActivity$(client, DIRECT_INVITE_ACTIVITY), [client]);
  const count = invites?.invites.length ?? 0;
  const watching = lifecycle === "running";
  const label = watching ? "Listening"
    : !activeConcordAutomation.watchDirectInvites ? "Background sync off"
    : phase === "starting" ? "Starting" : "Stopped";

  return (
    <section className="rounded-box border border-base-300 bg-base-100">
      <header className="flex flex-wrap items-center justify-between gap-2 px-4 py-3">
        <h2 className="flex items-center gap-2 text-lg font-semibold"><Inbox size={18} /> Direct invite receiver</h2>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          {count > 0 && <span className="text-base-content/70">{count} {count === 1 ? "invite" : "invites"}</span>}
          <span className={`badge badge-soft h-auto py-1 text-base ${watching ? "badge-success" : "badge-ghost"}`}>{label}</span>
        </div>
      </header>
      {(!!relays?.length || !!activity?.issues.length) && <div className="grid gap-5 border-t border-base-300 p-4 lg:grid-cols-2">
        {!!relays?.length && <section className="min-w-0 space-y-2">
          <h3 className="flex items-center gap-2 font-semibold"><Radio size={18} /> Relays</h3>
          <Relays urls={relays} />
        </section>}
        {!!activity?.issues.length && <section className="min-w-0 space-y-2">
          <h3 className="font-semibold">Issues</h3>
          <Issues issues={activity.issues} />
        </section>}
      </div>}
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
    : list?.knowledge === "complete" || list?.knowledge === "confirmed-empty" ? "Checked"
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
                {liveCount} of {communityCount} communities ready for live sync
              </label>
              <progress id="community-sync-progress" className="progress progress-primary mt-2 block w-full" value={liveCount} max={communityCount} />
            </div>}
            {!!activity?.issues.length && <div className="mt-3"><Issues issues={activity.issues} /></div>}
          </section>
          {ids?.map((id) => <CommunitySync key={id} id={id} />)}
          <DirectInviteSync />
        </div>
      </div>
    </main>
  );
}
