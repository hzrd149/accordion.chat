import { createContext, useContext } from "react";

/** What a call UI knows about an SFU participant identity (CORD-07 §4). */
export interface VoiceIdentityInfo {
  /** The member pubkey behind the identity (or the raw identity if unverified). */
  pubkey: string;
  /** True only under a sole fresh presence claim (or our own identity). */
  verified: boolean;
}

export type VoiceIdentityResolver = (identity: string) => VoiceIdentityInfo;

/** Default: everything is unverified until a presence-backed resolver overrides. */
export const VoiceIdentityContext = createContext<VoiceIdentityResolver>((identity) => ({
  pubkey: identity,
  verified: false,
}));

export function useVoiceIdentity(): VoiceIdentityResolver {
  return useContext(VoiceIdentityContext);
}
