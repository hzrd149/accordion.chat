import { use$ } from "applesauce-react/hooks";
import { useConcord } from "./use-concord";

/** The client owns receiving, validation, expiry and durable dismissal. */
export function useInvites() {
  const client = useConcord();
  const inbox = use$(client.directInvites$) ?? client.directInvites$.value;
  return {
    invites: inbox.invites,
    count: inbox.invites.length,
    status: inbox.pending.length ? `${inbox.pending.length} invites waiting to unlock` : "",
  };
}
