// Descriptive Concord status surfaces (built on the package's `status$`
// observables). Two views of the same signal:
//   • ClientStatusRailIndicator — the whole client at a glance (always-visible
//     dot at the bottom of the community rail).
//   • CommunityStatusDot — a per-community sync/connection dot, overlaid on a
//     rail icon.
import { use$ } from "applesauce-react/hooks";
import { Loader2 } from "lucide-react";
import type { ConcordClientStatus, ConcordCommunityStatus } from "applesauce-concord";
import { useConcord } from "../lib/concord-context";
import { useCommunity } from "../hooks/use-community";

// A DaisyUI semantic tone → the literal background class for a status dot. Kept
// literal (not interpolated) so Tailwind never purges these utilities.
type Tone = "success" | "info" | "warning" | "error" | "ghost";
const DOT_BG: Record<Tone, string> = {
  success: "bg-success",
  info: "bg-info",
  warning: "bg-warning",
  error: "bg-error",
  ghost: "bg-base-content/30",
};

interface Derived {
  tone: Tone;
  label: string;
  /** Animate the dot (a sync/startup in progress). */
  spin: boolean;
  /** The longer tooltip / detail line. */
  detail: string;
}

/** Fold a whole-client status snapshot into a single visual state. */
function deriveClient(s: ConcordClientStatus): Derived {
  if (s.phase !== "ready") return { tone: "info", label: "Starting…", spin: true, detail: "Starting up…" };
  const counts = `${s.live}/${s.communities} live${s.syncing ? ` · ${s.syncing} syncing` : ""}`;
  if (!s.connected) return { tone: "ghost", label: "Offline", spin: false, detail: `Offline · ${counts}` };
  if (s.syncing > 0) return { tone: "info", label: "Syncing…", spin: true, detail: counts };
  if (!s.authenticated)
    return { tone: "warning", label: "Auth pending", spin: false, detail: `${counts} · stream keys pending` };
  return { tone: "success", label: "Connected", spin: false, detail: `${counts} · stream keys authed` };
}

/** Fold a single community's status snapshot into a single visual state. */
function deriveCommunity(s: ConcordCommunityStatus): Derived {
  if (s.error) return { tone: "error", label: "Error", spin: false, detail: s.error };
  if (s.phase === "dissolved") return { tone: "error", label: "Dissolved", spin: false, detail: "Community dissolved" };
  if (s.phase === "removed") return { tone: "ghost", label: "Removed", spin: false, detail: "No longer a member" };
  if (!s.connected) return { tone: "ghost", label: "Offline", spin: false, detail: "No relay connected" };
  if (s.phase !== "live") return { tone: "info", label: "Syncing…", spin: true, detail: "Catching up with relays…" };
  if (!s.authenticated)
    return { tone: "warning", label: "Auth pending", spin: false, detail: "Authenticating stream keys…" };
  return { tone: "success", label: "Live", spin: false, detail: `Live · epoch ${s.epoch}` };
}

/** A colored status dot; spins a small loader overlay while `spin` is set. */
function StatusDot({ tone, spin, className = "" }: { tone: Tone; spin: boolean; className?: string }) {
  if (spin)
    return <Loader2 className={`animate-spin text-info ${className}`} size={12} strokeWidth={3} aria-hidden="true" />;
  return <span className={`inline-block rounded-full ${DOT_BG[tone]} ${className}`} aria-hidden="true" />;
}

/** The whole-client status, as an always-visible dot with a hover tooltip. */
export function ClientStatusRailIndicator() {
  const client = useConcord();
  const status = use$(client.status$);
  if (!status) return null;
  const d = deriveClient(status);
  return (
    <div
      className="w-12 h-6 shrink-0 flex items-center justify-center gap-1 text-base-content/60"
      title={`${d.label} — ${d.detail}`}
    >
      <StatusDot tone={d.tone} spin={d.spin} className="w-2.5 h-2.5" />
    </div>
  );
}

/** A per-community dot for the rail icon overlay. `undefined` renders nothing. */
export function CommunityStatusDot({ cid }: { cid: string }) {
  const community = useCommunity(cid);
  const status = use$(() => community?.status$, [community]);
  if (!status) return null;
  const d = deriveCommunity(status);
  // A live + authenticated community is the steady state — no dot, to keep the
  // rail quiet; only surface the states worth noticing.
  if (d.tone === "success") return null;
  return (
    <span
      className="absolute -bottom-0.5 -right-0.5 flex items-center justify-center w-4 h-4 rounded-full bg-base-300 ring-2 ring-base-300"
      title={`${d.label} — ${d.detail}`}
    >
      <StatusDot tone={d.tone} spin={d.spin} className="w-2 h-2" />
    </span>
  );
}
