import { useState } from "react";
import { use$ } from "applesauce-react/hooks";
import type { WrappedMessagesClient } from "applesauce-extra/messages";

export function DmAuthNotice({ client }: { client: WrappedMessagesClient }) {
  const requests = use$(client.authRequests$);
  const [error, setError] = useState("");
  if (!requests?.length) return null;
  async function authenticate() {
    setError("");
    try {
      const results = await client.authenticateAll();
      if (results.some((result) => result.status === "failed")) setError("Some message relays rejected authentication. Retry or check your signer.");
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
  }
  return (
    <div className="alert alert-info rounded-none">
      <span>{error || `${requests.length} message relay(s) require authentication.`}</span>
      <button className="btn btn-sm" disabled={requests.some((request) => request.state === "authenticating")} onClick={() => void authenticate()}>Authenticate</button>
    </div>
  );
}
