import { useState } from "react";
import { nip19 } from "nostr-tools";
import { ExtensionAccount, PrivateKeyAccount } from "applesauce-accounts/accounts";
import { accounts } from "../nostr";

export function Login() {
  const [nsec, setNsec] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  function activate(account: PrivateKeyAccount | ExtensionAccount) {
    accounts.addAccount(account);
    accounts.setActive(account);
  }

  function generate() {
    activate(PrivateKeyAccount.generateNew());
  }

  function importKey() {
    setError("");
    try {
      let key: string | Uint8Array = nsec.trim();
      if (typeof key === "string" && key.startsWith("nsec")) {
        const decoded = nip19.decode(key);
        if (decoded.type !== "nsec") throw new Error("not an nsec");
        key = decoded.data;
      }
      activate(PrivateKeyAccount.fromKey(key));
    } catch {
      setError("Invalid nsec or hex private key");
    }
  }

  async function extension() {
    setError("");
    setBusy(true);
    try {
      if (!("nostr" in window)) throw new Error("No NIP-07 extension found");
      activate(await ExtensionAccount.fromExtension());
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login-screen">
      <div className="login-card">
        <div className="logo">🏛️</div>
        <h1>Concord</h1>
        <p>Discord-style communities on Nostr, end-to-end encrypted.</p>

        {error && <div className="error">{error}</div>}

        <button className="btn full" onClick={generate}>
          Create a new identity
        </button>
        <button className="btn full ghost" onClick={extension} disabled={busy}>
          Sign in with extension (NIP-07)
        </button>

        <div className="field" style={{ marginTop: 20, textAlign: "left" }}>
          <label>Or import a private key</label>
          <input
            placeholder="nsec1… or hex"
            value={nsec}
            onChange={(e) => setNsec(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && importKey()}
          />
        </div>
        <button className="btn full secondary" onClick={importKey} disabled={!nsec.trim()}>
          Import & sign in
        </button>
      </div>
    </div>
  );
}
