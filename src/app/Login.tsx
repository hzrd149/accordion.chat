import { useEffect, useRef, useState } from "react";
import { Landmark, ArrowLeft, Copy, Check } from "lucide-react";
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
  // Which remote-signer sub-view is showing (null = main login screen).
  const [remote, setRemote] = useState<null | "menu" | "bunker" | "connect">(null);

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
  async function activateRemote(signer: NostrConnectSigner) {
    const pubkey = await signer.getPublicKey();
    activate(new NostrConnectAccount(pubkey, signer));
  }

  return (
    <div className="login-screen">
      <div className="login-card">
        <div className="logo"><Landmark size={48} /></div>
        <h1>Concord</h1>
        <p>Discord-style communities on Nostr, end-to-end encrypted.</p>

        {error && <div className="error">{error}</div>}

        {remote === "bunker" ? (
          <BunkerLogin
            onBack={() => setRemote("menu")}
            onError={setError}
            onSigner={activateRemote}
          />
        ) : remote === "connect" ? (
          <NostrConnectLogin
            onBack={() => setRemote("menu")}
            onError={setError}
            onSigner={activateRemote}
          />
        ) : remote === "menu" ? (
          <div className="remote-menu">
            <button className="btn full" onClick={() => { setError(""); setRemote("connect"); }}>
              Scan QR (Nostr Connect)
            </button>
            <button className="btn full ghost" onClick={() => { setError(""); setRemote("bunker"); }}>
              Paste a bunker:// URL
            </button>
            <button className="btn full secondary" onClick={() => setRemote(null)}>
              Back
            </button>
          </div>
        ) : (
          <>
            <button className="btn full" onClick={generate}>
              Create a new identity
            </button>
            <button className="btn full ghost" onClick={extension} disabled={busy}>
              Sign in with extension (NIP-07)
            </button>
            <button className="btn full ghost" onClick={() => { setError(""); setRemote("menu"); }}>
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

/** Connect to an existing remote signer by pasting its bunker:// URL. */
function BunkerLogin({
  onBack,
  onError,
  onSigner,
}: {
  onBack: () => void;
  onError: (msg: string) => void;
  onSigner: (signer: NostrConnectSigner) => Promise<void>;
}) {
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);

  async function connect() {
    if (!url.trim()) return;
    onError("");
    setBusy(true);
    try {
      const signer = await NostrConnectSigner.fromBunkerURI(url.trim(), {
        permissions: CONCORD_SIGNER_PERMISSIONS,
      });
      await onSigner(signer);
    } catch (e) {
      onError((e as Error).message || "Failed to connect to bunker");
      setBusy(false);
    }
  }

  return (
    <div style={{ textAlign: "left" }}>
      <div className="field">
        <label>Bunker URL</label>
        <input
          placeholder="bunker://…"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && connect()}
          autoFocus
        />
      </div>
      <button className="btn full" onClick={connect} disabled={!url.trim() || busy}>
        {busy ? "Connecting…" : "Connect"}
      </button>
      <button className="btn full secondary" onClick={onBack} disabled={busy}>
        <ArrowLeft size={16} /> Back
      </button>
    </div>
  );
}

/** Start a nostrconnect:// session: show a QR/link and wait for a signer to connect. */
function NostrConnectLogin({
  onBack,
  onError,
  onSigner,
}: {
  onBack: () => void;
  onError: (msg: string) => void;
  onSigner: (signer: NostrConnectSigner) => Promise<void>;
}) {
  const [uri, setUri] = useState("");
  const [copied, setCopied] = useState(false);
  const signerRef = useRef<NostrConnectSigner | null>(null);

  useEffect(() => {
    onError("");
    const signer = new NostrConnectSigner({ relays: NOSTR_CONNECT_RELAYS });
    signerRef.current = signer;
    setUri(signer.getNostrConnectURI({ ...APP_METADATA, permissions: CONCORD_SIGNER_PERMISSIONS }));

    const controller = new AbortController();
    signer
      .waitForSigner(controller.signal)
      .then(() => onSigner(signer))
      .catch((e) => {
        if (controller.signal.aborted) return; // cancelled by unmount
        onError((e as Error).message || "Failed to connect");
      });

    return () => {
      controller.abort();
      // Only tear down if this session never completed; a connected signer is
      // owned by the account now.
      if (!signer.isConnected) signer.close();
    };
  }, [onError, onSigner]);

  function copy() {
    navigator.clipboard.writeText(uri).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }

  return (
    <div style={{ textAlign: "center" }}>
      <p style={{ margin: "0 0 16px", color: "var(--text-muted)" }}>
        Scan with your Nostr signer app, or copy the link into it.
      </p>
      {uri && (
        <>
          <a href={uri} style={{ display: "inline-block" }}>
            <QRCode value={uri} />
          </a>
          <button className="btn full ghost" style={{ marginTop: 16 }} onClick={copy}>
            {copied ? <><Check size={16} /> Copied</> : <><Copy size={16} /> Copy connection link</>}
          </button>
        </>
      )}
      <button className="btn full secondary" onClick={onBack}>
        <ArrowLeft size={16} /> Back
      </button>
    </div>
  );
}
