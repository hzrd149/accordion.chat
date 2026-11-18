import type { ConcordCommunity } from "@applesauce/concord";
import { createPinProof, deriveConcordKeys, getDecodedWrap, getSealRumor, getWrapSeal, GIFT_WRAP_KIND } from "@applesauce/concord/helpers";
import { eventStore } from "../nostr";

/** Proofs must disclose the original authenticated seal, never a re-signed rumor. */
export async function pinMessage(community: ConcordCommunity, channelId: string, messageId: string) {
  const keys = deriveConcordKeys(community.material, community.state$.value.channels);
  const planes = [...keys.planes].filter(([, plane]) => plane.type === "channel" && plane.channelId === channelId);
  for (const [author, plane] of planes) {
    for (const wrap of eventStore.getByFilters({ kinds: [GIFT_WRAP_KIND], authors: [author] })) {
      const decoded = getDecodedWrap(wrap);
      if (decoded && decoded.rumor.id !== messageId) continue;
      const seal = getWrapSeal(wrap, plane.convKey);
      if (!seal || getSealRumor(seal, plane.convKey)?.id !== messageId) continue;
      const current = await community.pins(channelId, { showBanned: true });
      if (current.some((pin) => pin.rumor.id === messageId)) return;
      await community.setPins(channelId, [...current.map((pin) => pin.entry), createPinProof(seal, plane.convKey)]);
      return;
    }
  }
  throw new Error("The original encrypted envelope is not loaded. Sync channel history before pinning this message.");
}
