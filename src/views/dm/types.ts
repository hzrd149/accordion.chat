import type { Rumor } from "applesauce-common/helpers";

export interface UserSearchResult {
  pubkey: string;
  rank?: number;
  existing: boolean;
}

export interface PublishStatus {
  relay: string;
  ok: boolean;
  message?: string;
}

export type ConversationPreview = [peer: string, last: Rumor];
