import { use$ } from "applesauce-react/hooks";
import { verifiedAuthorOf, type VoicePresenceFold } from "../voice/presence";
import { useVoiceEngine } from "../voice/registry";

const EMPTY_FOLD: VoicePresenceFold = { present: [], claims: new Map<string, string[]>() };

/** Roster entries (identity → verified author) for a channel's live call (§4). */
export function useChannelRoster(cid: string, channelId: string) {
  const engine = useVoiceEngine(cid);
  const fold = use$(() => (engine ? engine.getVoicePresence$(channelId) : undefined), [engine, channelId]) ?? EMPTY_FOLD;
  return {
    fold,
    roster: fold.present.map((p) => ({ identity: p.identity, author: verifiedAuthorOf(fold, p.identity) })),
  };
}
