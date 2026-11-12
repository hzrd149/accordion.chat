import type { ISigner } from "applesauce-signers";
import type { PublishOptions } from "applesauce-relay";

/** A managed pool publish resolves even when every relay rejects the event. */
export interface PublishVerdict {
  from: string;
  ok: boolean;
  message?: string;
}

export class PublishRejectedError extends Error {
  readonly outcomes: readonly PublishVerdict[];

  constructor(outcomes: readonly PublishVerdict[]) {
    const details = outcomes.map((outcome) => `${outcome.from}: ${outcome.message || "rejected"}`).join("; ");
    super(details ? `No relay accepted this event. ${details}` : "No relay accepted this event");
    this.name = "PublishRejectedError";
    this.outcomes = outcomes;
  }
}

/** One acknowledged relay is enough for an account-level send. Retain partial
 * outcomes for status UI; a caller needing quorum must use a stricter policy. */
export function requireAccepted<T extends PublishVerdict>(outcomes: readonly T[]): readonly T[] {
  if (!outcomes.some((outcome) => outcome.ok)) throw new PublishRejectedError(outcomes);
  return outcomes;
}

/** User-identity auth is scoped to account-level delivery, never installed as a
 * global pool handler for Concord's independently authenticated plane keys. */
export function accountPublishOptions(signer: ISigner, pubkey: string): PublishOptions {
  return {
    waitForAuth: pubkey,
    onAuthRequired: async ({ relay }) => {
      const result = await relay.authenticate(signer);
      if (!result.ok) throw new Error(result.message || "Relay authentication rejected");
    },
  };
}
