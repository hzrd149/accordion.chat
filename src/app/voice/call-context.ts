import { createContext, useContext } from "react";

/** The one call a user can be in at a time (CORD-07): a community + channel. */
export interface ActiveCall {
  cid: string;
  channelId: string;
  channelName: string;
  /** The broker origin we connected through (rendezvous winner, §5). */
  broker: string;
}

/** A join request before the broker is resolved (§5 rendezvous picks it). */
export interface CallRequest {
  cid: string;
  channelId: string;
  channelName: string;
}

export interface CallController {
  /** The active (broker-resolved) call, or null when not in one. */
  active: ActiveCall | null;
  /** The call we're resolving a broker for, before it goes live. */
  pending: CallRequest | null;
  /** Join a voice channel's call (resolves a broker, connects, heartbeats). */
  join(req: CallRequest): void;
  /** Leave the active or pending call. */
  leave(): void;
}

export const CallContext = createContext<CallController | null>(null);

export function useCall(): CallController {
  const c = useContext(CallContext);
  if (!c) throw new Error("CallProvider not available");
  return c;
}
