import type { WrappedConversationSummary } from "applesauce-extra/messages";

export interface UserSearchResult {
  pubkey: string;
  rank?: number;
  existing: boolean;
}

export type ConversationPreview = WrappedConversationSummary & { peer: string };
