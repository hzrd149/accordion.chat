import type { PreparedWrappedMessage, WrappedConversation, WrappedConversationSendRequest, WrappedMessagesClient } from "applesauce-extra/messages";

// Keep prepared envelopes across route changes. The SDK owns all encryption,
// recipient routing and retry decisions; this map only retains its handles.
const pending = new WeakMap<WrappedMessagesClient, Map<string, PreparedWrappedMessage>>();
const active = new WeakMap<WrappedConversation, Promise<PreparedWrappedMessage>>();
export function pendingPublication(conversation: WrappedConversation) {
  return pending.get(conversation.client)?.get(conversation.id);
}

export function publishConversationDraft(conversation: WrappedConversation, request: WrappedConversationSendRequest): Promise<PreparedWrappedMessage> {
  const existing = active.get(conversation);
  if (existing) return existing;
  const operation = publish(conversation, request).finally(() => active.delete(conversation));
  active.set(conversation, operation);
  return operation;
}

async function publish(conversation: WrappedConversation, request: WrappedConversationSendRequest) {
  let sends = pending.get(conversation.client);
  if (!sends) { sends = new Map(); pending.set(conversation.client, sends); }
  let prepared = sends.get(conversation.id);
  if (!prepared) {
    prepared = await conversation.prepareSend(request);
    sends.set(conversation.id, prepared);
  }
  await prepared.publish();
  // Retain the accepted handle until the draft is cleared too: a storage failure
  // must not turn "retry" into a freshly encrypted, duplicate message.
  const draft = await conversation.loadDraft();
  if (draft?.content === prepared.message.content) await conversation.clearDraft();
  sends.delete(conversation.id);
  return prepared;
}
