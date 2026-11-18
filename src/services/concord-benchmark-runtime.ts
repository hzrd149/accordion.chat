import { ConcordClient, ConcordCommunity, KeyValue } from "@applesauce/concord";
import type { ConcordPlaneSyncCoverage, JoinMaterial } from "@applesauce/concord";
import { ConcordInviteBundle } from "@applesauce/concord/casts";
import { getInviteBundleExpiry, INVITE_BUNDLE_KIND, isSafeInviteRelayURL, parseInviteLink, STOCK_RELAYS, verifyOwner } from "@applesauce/concord/helpers";
import { EventStore } from "applesauce-core";
import type { VerifyEventMethod } from "applesauce-core/helpers";
import { RelayPool } from "applesauce-relay";
import { createEventLoaderForStore } from "applesauce-loaders/loaders";
import type { ISigner } from "applesauce-signers";
import { firstValueFrom, Subscription, takeUntil, Subject, toArray } from "rxjs";

export type BenchmarkVerification = "wasm" | "javascript" | "none";

export type BenchmarkTarget =
  | { kind: "list" }
  | { kind: "community"; material: JoinMaterial }
  | { kind: "invite"; url: string };

export interface BenchmarkCommunity {
  id: string;
  name: string;
  phase: string;
  liveMs?: number;
  completeMs?: number;
  planes: number;
  completePlanes: number;
  retained: number;
}

export interface BenchmarkReport {
  status: "running" | "complete" | "cancelled" | "timeout" | "error";
  source: BenchmarkTarget["kind"];
  verification: BenchmarkVerification;
  preparationMs?: number;
  startedAt: string;
  elapsedMs: number;
  startupMs?: number;
  firstEventMs?: number;
  listKnowledge?: string;
  receivedEvents: number;
  uniqueEvents: number;
  receivedEventBytes: number;
  maxEventLoopLagMs: number;
  diagnostics: Record<string, number>;
  communities: BenchmarkCommunity[];
  error?: string;
}

/** Live readiness alone is not evidence that finite historical reads finished. */
export function hasCompleteCoverage(phase: string, coverage: ReadonlyMap<string, ConcordPlaneSyncCoverage>) {
  return phase === "live" && coverage.size > 0 && [...coverage.values()].every((plane) => plane.state === "complete");
}

/**
 * One disposable, memory-only read session. No application caches or connections
 * are injected. Single-community runs use the SDK's standalone community engine,
 * avoiding joinByLink's real membership/list publications.
 */
export function startConcordBenchmark(
  signer: ISigner,
  target: BenchmarkTarget,
  timeoutMs: number,
  onUpdate: (report: BenchmarkReport) => void,
  options: { verification: BenchmarkVerification; verifyEvent: VerifyEventMethod; lookupRelays: string[] },
) {
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 900_000) {
    throw new Error("Choose a timeout between 1 and 900 seconds.");
  }
  const start = performance.now();
  const elapsed = () => performance.now() - start;
  const pool = new RelayPool();
  const store = new EventStore({ verifyEvent: options.verifyEvent });
  const storage = KeyValue.memoryStorage();
  const subscriptions = new Subscription();
  const stopped = new Subject<void>();
  const engines = new Map<string, ConcordCommunity>();
  const rows = new Map<string, BenchmarkCommunity>();
  const privateReady = new Map<string, boolean>();
  const encoder = new TextEncoder();
  const report: BenchmarkReport = {
    status: "running", source: target.kind, verification: options.verification,
    startedAt: new Date().toISOString(),
    elapsedMs: 0, receivedEvents: 0, uniqueEvents: 0, receivedEventBytes: 0,
    maxEventLoopLagMs: 0, diagnostics: {}, communities: [],
  };
  let client: ConcordClient | undefined;
  let done = false;
  let started = false;
  let eligibleSince: number | undefined;
  let settleTimer: ReturnType<typeof setTimeout> | undefined;
  let previousTick = performance.now();
  const emit = () => {
    report.elapsedMs = elapsed();
    report.communities = [...rows.values()].map((row) => ({ ...row }));
    onUpdate({ ...report, diagnostics: { ...report.diagnostics } });
  };
  const finish = (status: BenchmarkReport["status"], error?: string) => {
    if (done) return;
    done = true;
    report.status = status;
    report.error = error;
    clearTimeout(deadline);
    clearTimeout(settleTimer);
    clearInterval(ticker);
    stopped.next();
    stopped.complete();
    subscriptions.unsubscribe();
    try {
      client?.dispose();
      if (!client) for (const engine of engines.values()) engine.dispose();
    } finally {
      pool.close();
      loader.stop();
      store.dispose();
      emit();
    }
  };
  const issue = (stage: string) => {
    report.diagnostics[stage] = (report.diagnostics[stage] ?? 0) + 1;
  };
  const check = () => {
    if (done) return;
    const memberships = client?.memberships();
    if (memberships) report.listKnowledge = memberships.knowledge;
    const listReady = !memberships || (!memberships.locked &&
      (memberships.knowledge === "complete" || memberships.knowledge === "confirmed-empty") &&
      memberships.entries.length === engines.size);
    const ready = started && listReady && [...engines.values()].every((engine) =>
      hasCompleteCoverage(engine.phase$.value, engine.syncCoverage$.value) &&
      privateReady.get(engine.material.community_id));
    if (!ready) {
      eligibleSince = undefined;
      clearTimeout(settleTimer);
      settleTimer = undefined;
    } else if (eligibleSince === undefined) {
      // Allow follow-on channel/epoch discovery to invalidate apparent completion.
      eligibleSince = elapsed();
      settleTimer = setTimeout(() => { check(); if (!done && eligibleSince !== undefined) finish("complete"); }, 1_000);
    }
  };
  const attach = (engine: ConcordCommunity) => {
    const id = engine.material.community_id;
    if (engines.has(id)) return;
    engines.set(id, engine);
    privateReady.set(id, false);
    const row: BenchmarkCommunity = {
      id, name: engine.material.name ?? id.slice(0, 12), phase: "idle",
      planes: 0, completePlanes: 0, retained: 0,
    };
    rows.set(id, row);
    const update = () => {
      row.phase = engine.phase$.value;
      const coverage = [...engine.syncCoverage$.value.values()];
      row.planes = coverage.length;
      row.completePlanes = coverage.filter((plane) => plane.state === "complete").length;
      row.retained = coverage.reduce((sum, plane) => sum + plane.retained, 0);
      if (row.phase === "live") row.liveMs ??= elapsed();
      if (hasCompleteCoverage(row.phase, engine.syncCoverage$.value)) row.completeMs ??= elapsed();
      else row.completeMs = undefined;
      check();
    };
    subscriptions.add(engine.phase$.subscribe(update));
    subscriptions.add(engine.syncCoverage$.subscribe(update));
    subscriptions.add(engine.privateChannelStatus$.subscribe((channels) => {
      privateReady.set(id, [...channels.values()].every((channel) => channel.phase === "live"));
      check();
    }));
    subscriptions.add(engine.metadata$.subscribe((metadata) => { if (metadata) row.name = metadata.name; }));
  };
  subscriptions.add(pool.add$.subscribe((relay) => {
    subscriptions.add(relay.message$.subscribe((message: unknown) => {
      if (!Array.isArray(message) || message[0] !== "EVENT") return;
      report.firstEventMs ??= elapsed();
      report.receivedEvents++;
      // Serialized EVENT payload bytes, not WebSocket framing or compressed wire bytes.
      report.receivedEventBytes += encoder.encode(JSON.stringify(message)).byteLength;
    }));
  }));
  subscriptions.add(store.insert$.subscribe(() => { report.uniqueEvents++; }));
  const loader = createEventLoaderForStore(store, pool, {
    lookupRelays: options.lookupRelays, extraRelays: STOCK_RELAYS,
  });
  const deadline = setTimeout(() => finish("timeout"), timeoutMs);
  const ticker = setInterval(() => {
    const now = performance.now();
    report.maxEventLoopLagMs = Math.max(report.maxEventLoopLagMs, now - previousTick - 250);
    previousTick = now;
    check();
    emit();
  }, 250);
  emit();
  void (async () => {
    try {
      if (target.kind === "list") {
        client = new ConcordClient({
          signer, pool, eventStore: store, storage,
          autoUnlock: true, autoSaveCommunityList: false, watchDirectInvites: false,
          pinUpkeep: false, historySync: "background",
        });
        subscriptions.add(client.diagnostics$.subscribe(({ stage }) => issue(stage)));
        subscriptions.add(client.communities$.subscribe((states) => {
          for (const state of states) {
            const engine = client!.getCommunity(state.material.community_id);
            if (engine) attach(engine);
          }
          const active = new Set(states.map((state) => state.material.community_id));
          for (const id of engines.keys()) if (!active.has(id)) {
            engines.delete(id); rows.delete(id); privateReady.delete(id);
          }
          check();
        }));
        subscriptions.add(client.memberships$.subscribe(check));
        await client.start();
      } else {
        let material: JoinMaterial;
        if (target.kind === "community") material = structuredClone(target.material);
        else {
          const parsed = parseInviteLink(target.url);
          const relays = parsed.bootstrapRelays.length ? parsed.bootstrapRelays : STOCK_RELAYS;
          const events = await firstValueFrom(pool.request(relays, [{
            kinds: [INVITE_BUNDLE_KIND], authors: [parsed.linkSigner], "#d": [""],
          }]).pipe(takeUntil(stopped), toArray()));
          if (done) return;
          for (const event of events) store.add(event);
          const event = store.getReplaceable(INVITE_BUNDLE_KIND, parsed.linkSigner, "");
          if (!event) throw new Error("No verified invite bundle found.");
          const invite = new ConcordInviteBundle(event, store);
          if (!invite.live) throw new Error("This invite has been revoked.");
          const bundle = invite.unlock(parsed.token);
          const expiry = getInviteBundleExpiry(bundle);
          if (expiry !== undefined && expiry <= Date.now() / 1_000) throw new Error("This invite has expired.");
          material = { ...bundle, channels: bundle.channels ?? [], relays: (bundle.relays ?? relays).filter(isSafeInviteRelayURL) };
        }
        if (!verifyOwner(material)) throw new Error("Community owner verification failed.");
        const pubkey = await signer.getPublicKey();
        if (done) return;
        const engine = new ConcordCommunity({
          material, signer, pubkey, pool, eventStore: store, storage,
          historySync: "background", pinUpkeep: false,
          onDiagnostic: ({ stage }) => issue(stage),
        });
        attach(engine);
        await engine.start();
      }
      if (done) return;
      started = true;
      report.startupMs = elapsed();
      check();
      emit();
    } catch {
      // Do not retain SDK exception objects: they can carry invite/key material.
      if (!done) finish("error", "Synchronization failed. Check the source, signer access, and relay availability.");
    }
  })();
  return { cancel: () => finish("cancelled") };
}
