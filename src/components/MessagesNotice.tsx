import { use$ } from "applesauce-react/hooks";
import { dismissMessagesError, messagesError$, restartMessages } from "../services/messages";

export function MessagesNotice() {
  const error = use$(messagesError$);
  if (!error) return null;
  return (
    <div role="alert" className="alert alert-warning fixed bottom-4 left-4 z-50 max-w-sm">
      <span>Messages: {error}</span>
      <button className="btn btn-sm" onClick={restartMessages}>Restart inbox</button>
      <button className="btn btn-ghost btn-sm" onClick={dismissMessagesError}>Dismiss</button>
    </div>
  );
}
