// Shared mention detection: whether a chat message's content mentions a pubkey.
//
// Concord chat messages carry no `p` tags that are *mentions* — the gift wrap's
// only `p` tag is the decoy recipient — so a mention only exists as a NIP-19
// `nostr:` token in the content. The composer inserts `nostr:npub…` links and
// the message factory turns those into `p` tags, but those `p` tags are used as
// a fast index/filter for the mentions view, NOT as proof of a content mention.
// This function is the content-confirmation step: it parses the NAST and checks
// for a `mention` node whose decoded pubkey matches.
//
// Parsing is gated on a cheap substring test so the common (unmentioned) message
// costs a scan rather than a full NAST parse.

import { kinds } from "nostr-tools";
import { getParsedContent } from "applesauce-content/text";
import type { Content } from "applesauce-content/nast";
import { getPubkeyFromDecodeResult } from "applesauce-core/helpers";

/**
 * Whether `content` contains a NIP-19 `nostr:` mention of `pubkey`.
 */
export function mentions(content: string, pubkey: string): boolean {
  if (!pubkey || !content.includes("nostr:")) return false;
  try {
    const root = getParsedContent({ kind: kinds.ChatMessage, content, tags: [], created_at: 0 });
    return root.children.some(
      (node: Content) => node.type === "mention" && getPubkeyFromDecodeResult(node.decoded) === pubkey,
    );
  } catch {
    /* An unparseable pointer is not a mention. */
    return false;
  }
}
