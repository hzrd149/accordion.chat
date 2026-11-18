import { useCallback, useEffect, useRef, useState } from "react";
import type { ConcordChannelDraft, ConcordSendMessageOptions, Drafts } from "@applesauce/concord";

const EMPTY: Drafts.ConcordMessageDraft = { text: "", files: [] };

/** Keep typing synchronous while the SDK serializes durable writes and sends. */
export function useChannelDraft(draft: ConcordChannelDraft) {
  const [value, setValue] = useState<Drafts.ConcordMessageDraft>(EMPTY);
  const current = useRef(value);
  const preparing = useRef(false);
  const buffered = useRef<Drafts.ConcordMessageDraft[]>([]);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    void draft.load().then((saved) => {
      if (!active) return;
      current.current = saved ?? EMPTY;
      setValue(current.current);
      setReady(true);
    }).catch((reason: unknown) => {
      if (active) setError(`Could not restore draft: ${String(reason)}`);
    });
    return () => { active = false; };
  }, [draft]);

  const persist = useCallback((next: Drafts.ConcordMessageDraft) => {
    void draft.set(next).catch((reason: unknown) => setError(`Could not save draft: ${String(reason)}`));
  }, [draft]);

  const update = useCallback((change: Partial<Drafts.ConcordMessageDraft>) => {
    const next = { ...current.current, ...change };
    current.current = next;
    setValue(next);
    if (preparing.current) buffered.current.push(next);
    else persist(next);
  }, [persist]);

  function flushEdits() {
    preparing.current = false;
    for (const next of buffered.current.splice(0)) persist(next);
  }

  async function send(options?: ConcordSendMessageOptions, publish?: (text: string) => Promise<void>) {
    const sent = current.current;
    preparing.current = true;
    try {
      await draft.set(sent);
      // Queue the SDK's send snapshot before persisting typing that happened
      // during the initial IndexedDB write. Otherwise send() captures the newer
      // text and clears it, even though this UI intended to send the old text.
      const publication = publish ? publish(sent.text) : draft.send(options);
      flushEdits();
      await publication;
      if (publish && current.current === sent) await draft.clear();
    } finally {
      flushEdits();
    }
    if (current.current === sent) {
      current.current = EMPTY;
      setValue(EMPTY);
    }
  }

  return { value, ready, error, update, send };
}
