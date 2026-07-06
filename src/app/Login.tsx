import { useCallback, useEffect, useRef, useState } from "react";
import { Landmark, ArrowLeft, Copy, Check, Settings2 } from "lucide-react";
import { nip19 } from "nostr-tools";
import { ExtensionAccount, PrivateKeyAccount, NostrConnectAccount } from "applesauce-accounts/accounts";
import type { IAccount } from "applesauce-accounts";
import { NostrConnectSigner } from "applesauce-signers";
import { accounts, CONCORD_SIGNER_PERMISSIONS, NOSTR_CONNECT_RELAYS } from "../nostr";
import { QRCode } from "./QRCode";

const APP_METADATA = { name: "Concord", url: window.location.origin };

export function Login() {
  const [nsec, setNsec] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [remote, setRemote] = useState(false);

  function activate(account: IAccount) {
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

  // Wrap a connected NostrConnectSigner into a persistable account and log in.
  // Memoised so the remote view's effect doesn't re-run (and regenerate the
  // signer) on every render of this component.
  const activateRemote = useCallback(async (signer: NostrConnectSigner) => {
    const pubkey = await signer.getPublicKey();
    activate(new NostrConnectAccount(pubkey, signer));
  }, []);

  return (
    <div className="login-screen">
      <div className="login-card">
        <div className="logo"><Landmark size={48} /></div>
        <h1>Concord</h1>
        <p>Discord-style communities on Nostr, end-to-end encrypted.</p>

        {error && <div className="error">{error}</div>}

        {remote ? (
          <RemoteSignerLogin
            onBack={() => { setError(""); setRemote(false); }}
            onError={setError}
            onSigner={activateRemote}
          />
        ) : (
          <>
            <button className="btn full" onClick={generate}>
              Create a new identity
            </button>
            <button className="btn full ghost" onClick={extension} disabled={busy}>
              Sign in with extension (NIP-07)
            </button>
            <button className="btn full ghost" onClick={() => { setError(""); setRemote(true); }}>
              Sign in with remote signer (NIP-46)
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
          </>
        )}
      </div>
    </div>
  );
}

/**
 * Remote signer (NIP-46) login. Leads with a nostrconnect:// QR that a mobile
 * signer scans; the listening relays are customizable. Also accepts a pasted
 * bunker:// URI as an alternative.
 */
function RemoteSignerLogin({
  onBack,
  onError,
  onSigner,
}: {
  onBack: () => void;
  onError: (msg: string) => void;
  onSigner: (signer: NostrConnectSigner) => Promise<void>;
}) {
  const [relays, setRelays] = useState<string[]>(NOSTR_CONNECT_RELAYS);
  const [editingRelays, setEditingRelays] = useState(false);
  const [relaysDraft, setRelaysDraft] = useState(relays.join("\n"));
  const [uri, setUri] = useState("");
  const [copied, setCopied] = useState(false);
  const [bunkerUrl, setBunkerUrl] = useState("");
  const [bunkerBusy, setBunkerBusy] = useState(false);
  // Guards the QR session's completion handler from firing after a bunker
  // connect (or unmount) has already claimed the login.
  const doneRef = useRef(false);

  // (Re)start a nostrconnect:// session whenever the relay set changes.
  useEffect(() => {
    if (relays.length === 0) return;
    onError("");
    const signer = new NostrConnectSigner({ relays });
    setUri(signer.getNostrConnectURI({ ...APP_METADATA, permissions: CONCORD_SIGNER_PERMISSIONS }));

    const controller = new AbortController();
    signer
      .waitForSigner(controller.signal)
      .then(() => {
        if (controller.signal.aborted) return;
        doneRef.current = true;
        onSigner(signer);
      })
      .catch((e) => {
        if (!controller.signal.aborted) onError((e as Error).message || "Failed to connect");
      });

    return () => {
      controller.abort();
      // A connected signer is owned by the account now; only tidy up if this
      // QR session never completed.
      if (!signer.isConnected) signer.close();
    };
  }, [relays, onError, onSigner]);

  function applyRelays() {
    const next = relaysDraft
      .split(/[\s,]+/)
      .map((r) => r.trim())
      .filter(Boolean)
      .map((r) => (r.startsWith("ws") ? r : `wss://${r}`));
    setEditingRelays(false);
    if (next.length) {
      setRelaysDraft(next.join("\n"));
      setRelays(next);
    }
  }

  function copy() {
    navigator.clipboard.writeText(uri).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }

  async function connectBunker() {
    if (!bunkerUrl.trim()) return;
    onError("");
    setBunkerBusy(true);
    try {
      const signer = await NostrConnectSigner.fromBunkerURI(bunkerUrl.trim(), {
        permissions: CONCORD_SIGNER_PERMISSIONS,
      });
      doneRef.current = true;
      await onSigner(signer);
    } catch (e) {
      onError((e as Error).message || "Failed to connect to bunker");
      setBunkerBusy(false);
    }
  }

  return (
    <div style={{ textAlign: "center" }}>
      <p style={{ margin: "0 0 16px", color: "var(--text-muted)" }}>
        Scan with your Nostr signer app, or copy the link into it.
      </p>

      {uri && (
        <a href={uri} style={{ display: "inline-block" }}>
          <QRCode value={uri} />
        </a>
      )}

      <button className="btn full ghost" style={{ marginTop: 16 }} onClick={copy} disabled={!uri}>
        {copied ? <><Check size={16} /> Copied</> : <><Copy size={16} /> Copy connection link</>}
      </button>

      {/* Relay customization */}
      {editingRelays ? (
        <div className="field" style={{ marginTop: 12, textAlign: "left" }}>
          <label>Signer relays (one per line)</label>
          <textarea
            rows={3}
            value={relaysDraft}
            onChange={(e) => setRelaysDraft(e.target.value)}
            style={{ fontFamily: "monospace", fontSize: 12 }}
          />
          <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
            <button className="btn secondary" style={{ flex: 1 }} onClick={applyRelays}>
              Apply
            </button>
            <button
              className="btn ghost"
              style={{ flex: 1 }}
              onClick={() => { setRelaysDraft(relays.join("\n")); setEditingRelays(false); }}
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <button
          onClick={() => { setRelaysDraft(relays.join("\n")); setEditingRelays(true); }}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 4,
            margin: "10px auto 0",
            padding: 0,
            background: "none",
            border: "none",
            cursor: "pointer",
            color: "var(--text-muted)",
            fontSize: 12,
          }}
        >
          <Settings2 size={13} /> Relays: {relays.map((r) => r.replace(/^wss?:\/\//, "")).join(", ")}
        </button>
      )}

      {/* Bunker URI alternative */}
      <div className="field" style={{ marginTop: 20, textAlign: "left" }}>
        <label>Or paste a bunker:// URI</label>
        <input
          placeholder="bunker://…"
          value={bunkerUrl}
          onChange={(e) => setBunkerUrl(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && connectBunker()}
        />
      </div>
      <button className="btn full ghost" onClick={connectBunker} disabled={!bunkerUrl.trim() || bunkerBusy}>
        {bunkerBusy ? "Connecting…" : "Connect with bunker URI"}
      </button>

      <button className="btn full secondary" style={{ marginTop: 8 }} onClick={onBack}>
        <ArrowLeft size={16} /> Back
      </button>
    </div>
  );
}
