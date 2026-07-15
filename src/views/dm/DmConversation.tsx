import { useMemo, useState, type FormEvent, type ReactNode } from "react";
import { ActionRunner } from "applesauce-actions";
import { SendWrappedMessage } from "applesauce-actions/actions";
import { WrappedMessagesGroup } from "applesauce-common/models";
import { unixNow } from "applesauce-core/helpers";
import { use$, useActiveAccount } from "applesauce-react/hooks";
import { eventStore, pool } from "../../nostr";
import { userFor } from "../../lib/settings-actions";
import type { PublishStatus } from "./types";
import { DmComposer } from "./DmComposer";
import { DmHeader } from "./DmHeader";
import { DmMessageList } from "./DmMessageList";
import { DmSettingsDrawer } from "./DmSettingsDrawer";
import { expirationKey, EXPIRATIONS, inferExpiration, NO_MESSAGES, NO_RELAYS, oneToOnePeer, readStoredExpiration, type ExpirationValue, writeStoredExpiration } from "./utils";

export function DmConversation({ self, peer, mobileListButton }: { self: string; peer: string; mobileListButton: ReactNode }) {
  const account = useActiveAccount();
  const selfUser = useMemo(() => userFor(self), [self]);
  const peerUser = useMemo(() => userFor(peer), [peer]);
  const selfRelays = use$(() => selfUser.directMessageRelays$, [selfUser]) ?? NO_RELAYS;
  const peerRelays = use$(() => peerUser.directMessageRelays$, [peerUser]) ?? NO_RELAYS;
  const allMessages = use$(() => eventStore.model(WrappedMessagesGroup, self, peer), [self, peer]) ?? NO_MESSAGES;
  const messages = useMemo(
    () => allMessages.filter((message) => oneToOnePeer(self, message) === peer).sort((a, b) => a.created_at - b.created_at),
    [allMessages, self, peer],
  );
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [lastPublish, setLastPublish] = useState<PublishStatus[]>([]);
  const inferredExpiration = useMemo(() => inferExpiration(messages), [messages]);
  const [expirationOverrides, setExpirationOverrides] = useState<Record<string, ExpirationValue>>({});
  const expiration = expirationOverrides[expirationKey(self, peer)] ?? readStoredExpiration(self, peer) ?? inferredExpiration;

  const runner = useMemo(
    () =>
      account
        ? new ActionRunner(eventStore, account, async (event, relays) => {
            const targets = relays?.length ? relays : peerRelays;
            if (!targets.length) throw new Error("No NIP-17 inbox relays found for this user");
            setLastPublish(targets.map((relay) => ({ relay, ok: false, message: "Publishing..." })));
            const responses = await pool.publish(targets, event);
            setLastPublish(
              responses.map((response) => ({
                relay: response.from,
                ok: response.ok,
                message: response.message,
              })),
            );
          })
        : null,
    [account, peerRelays],
  );

  async function send(e: FormEvent) {
    e.preventDefault();
    const content = text.trim();
    if (!content || !runner || sending) return;
    const selected = EXPIRATIONS.find((item) => item.value === expiration);
    setSending(true);
    setError("");
    try {
      await runner.run(SendWrappedMessage, peer, content, {
        expiration: selected?.seconds ? unixNow() + selected.seconds : undefined,
      });
      setText("");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSending(false);
    }
  }

  function updateExpiration(value: ExpirationValue) {
    setExpirationOverrides((prev) => ({ ...prev, [expirationKey(self, peer)]: value }));
    writeStoredExpiration(self, peer, value);
  }

  return (
    <div className="flex-1 flex min-w-0 min-h-0 relative">
      <div className="flex-1 flex flex-col min-w-0 min-h-0">
        <DmHeader peer={peer} mobileListButton={mobileListButton} onToggleSettings={() => setSettingsOpen((open) => !open)} />
        <DmMessageList messages={messages} self={self} peer={peer} />
        <DmComposer peer={peer} text={text} sending={sending} error={error} onTextChange={setText} onSubmit={send} />
      </div>
      {settingsOpen && (
        <DmSettingsDrawer
          self={self}
          peer={peer}
          selfRelays={selfRelays}
          peerRelays={peerRelays}
          expiration={expiration}
          onExpirationChange={updateExpiration}
          lastPublish={lastPublish}
          onClose={() => setSettingsOpen(false)}
        />
      )}
    </div>
  );
}
