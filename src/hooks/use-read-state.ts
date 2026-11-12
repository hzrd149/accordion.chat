import { useEffect, useState } from "react";
import { getReadState, READ_STATE_CHANGE_EVENT, type ReadState } from "../services/read-state";

/** Read/subscribe to an account's read state; re-renders when it changes. */
export function useReadState(pubkey: string): ReadState {
  const [state, setState] = useState<ReadState>(() => getReadState(pubkey));

  useEffect(() => {
    const onChange = () => setState(getReadState(pubkey));
    // Re-read on pubkey change too: the effect body runs on mount and whenever
    // the account switches, so the state follows the active account.
    onChange();
    window.addEventListener(READ_STATE_CHANGE_EVENT, onChange);
    return () => window.removeEventListener(READ_STATE_CHANGE_EVENT, onChange);
  }, [pubkey]);

  return state;
}
