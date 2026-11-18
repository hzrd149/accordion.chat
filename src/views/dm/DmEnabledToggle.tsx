import { use$ } from "applesauce-react/hooks";
import { ToggleCard } from "../../components/ToggleCard";
import { messagesAutoDecrypt$, messagesEnabled$, setMessagesAutoDecrypt, setMessagesEnabled } from "../../services/messages";

/** Card toggle for the opt-in NIP-17 inbox. */
export function DmEnabledToggle() {
  const enabled = use$(messagesEnabled$);
  return (
    <ToggleCard
      checked={enabled}
      onChange={setMessagesEnabled}
      label="Enable direct messages"
      hint={enabled ? "Connected to your DM relays" : "Accordion does not connect to DM relays or decrypt messages"}
    />
  );
}

/** Card toggle choosing automatic or manual decryption of incoming messages. */
export function DmAutoDecryptToggle() {
  const enabled = use$(messagesEnabled$);
  const auto = use$(messagesAutoDecrypt$);
  return (
    <ToggleCard
      checked={auto}
      disabled={!enabled}
      onChange={setMessagesAutoDecrypt}
      label="Decrypt messages automatically"
      hint={auto ? "Your signer decrypts new messages as they arrive" : "Manual: messages stay locked until you unlock them"}
    />
  );
}
