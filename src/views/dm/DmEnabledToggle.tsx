import { use$ } from "applesauce-react/hooks";
import { messagesEnabled$, setMessagesEnabled } from "../../services/messages";

/** Side-by-side Enabled / Disabled buttons for the opt-in NIP-17 inbox. */
export function DmEnabledToggle() {
  const enabled = use$(messagesEnabled$);
  const option = (value: boolean, label: string) => (
    <button
      type="button"
      className={`btn btn-sm join-item ${enabled === value ? (value ? "btn-primary" : "btn-neutral") : ""}`}
      aria-pressed={enabled === value}
      onClick={() => setMessagesEnabled(value)}
    >
      {label}
    </button>
  );
  return (
    <div className="join" role="group" aria-label="Direct messages">
      {option(true, "Enabled")}
      {option(false, "Disabled")}
    </div>
  );
}
