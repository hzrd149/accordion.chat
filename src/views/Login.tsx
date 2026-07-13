import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, Copy, Check, Settings2 } from "lucide-react";
import { nip19 } from "nostr-tools";
import { ExtensionAccount, PrivateKeyAccount, NostrConnectAccount } from "applesauce-accounts/accounts";
import type { IAccount } from "applesauce-accounts";
import { NostrConnectSigner } from "applesauce-signers";
import { accounts, CONCORD_SIGNER_PERMISSIONS, NOSTR_CONNECT_RELAYS } from "../nostr";
import { QRCode } from "../components/QRCode";

const APP_METADATA = { name: "Accordion", url: window.location.origin };

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
    <div className="flex h-screen items-center justify-center bg-gradient-to-b from-base-300 to-base-200">
      <div className="card w-[420px] max-w-[calc(100vw-2rem)] bg-base-100 p-8 text-center shadow-xl">
        <div className="mb-2 text-[40px] leading-none" aria-hidden="true">🪗</div>
        <h1 className="mb-1 text-xl font-bold">Accordion</h1>
        <p className="mb-6 text-sm opacity-60">Discord-style communities on Nostr, end-to-end encrypted.</p>

        {error && <div className="alert alert-error mb-3 text-sm">{error}</div>}

        {remote ? (
          <RemoteSignerLogin
            onBack={() => { setError(""); setRemote(false); }}
            onError={setError}
            onSigner={activateRemote}
          />
        ) : (
          <>
            <button className="btn btn-primary btn-block mb-2.5" onClick={generate}>
              Create a new identity
            </button>
            <button className="btn btn-ghost btn-block mb-2.5" onClick={extension} disabled={busy}>
              Sign in with extension (NIP-07)
            </button>
            <button className="btn btn-ghost btn-block mb-2.5" onClick={() => { setError(""); setRemote(true); }}>
              Sign in with remote signer (NIP-46)
            </button>

            <div className="mb-4 mt-5 text-left">
              <label className="label text-xs font-semibold uppercase opacity-70">Or import a private key</label>
              <input
                className="input input-bordered w-full"
                placeholder="nsec1… or hex"
                value={nsec}
                onChange={(e) => setNsec(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && importKey()}
              />
            </div>
            <button className="btn btn-ghost btn-block" onClick={importKey} disabled={!nsec.trim()}>
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
  const [copied, setCopied] = useState(false);
  const [bunkerUrl, setBunkerUrl] = useState("");
  const [bunkerBusy, setBunkerBusy] = useState(false);
  // Guards the QR session's completion handler from firing after a bunker
  // connect (or unmount) has already claimed the login.
  const doneRef = useRef(false);

  // Create one signer per relay set and derive its QR URI, rather than setting
  // `uri` state from the effect (which would cascade a render). The signer's
  // start/stop lifecycle stays in the effect below.
  const signer = useMemo(() => (relays.length ? new NostrConnectSigner({ relays }) : null), [relays]);
  const uri = useMemo(
    () => signer?.getNostrConnectURI({ ...APP_METADATA, permissions: CONCORD_SIGNER_PERMISSIONS }) ?? "",
    [signer],
  );

  // (Re)start the nostrconnect:// session whenever the signer changes.
  useEffect(() => {
    if (!signer) return;
    onError("");
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
  }, [signer, onError, onSigner]);

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
    <div className="text-center">
      <p className="mb-4 text-sm opacity-60">
        Scan with your Nostr signer app, or copy the link into it.
      </p>

      {uri && (
        <a href={uri} className="inline-block">
          <QRCode value={uri} />
        </a>
      )}

      <button className="btn btn-ghost btn-block mt-4" onClick={copy} disabled={!uri}>
        {copied ? <><Check size={16} /> Copied</> : <><Copy size={16} /> Copy connection link</>}
      </button>

      {/* Relay customization */}
      {editingRelays ? (
        <div className="mt-3 text-left">
          <label className="label text-xs font-semibold uppercase opacity-70">Signer relays (one per line)</label>
          <textarea
            className="textarea textarea-bordered w-full font-mono text-xs"
            rows={3}
            value={relaysDraft}
            onChange={(e) => setRelaysDraft(e.target.value)}
          />
          <div className="mt-2 flex gap-2">
            <button className="btn btn-primary flex-1" onClick={applyRelays}>
              Apply
            </button>
            <button
              className="btn btn-ghost flex-1"
              onClick={() => { setRelaysDraft(relays.join("\n")); setEditingRelays(false); }}
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <button
          className="btn btn-ghost btn-xs mt-2.5 gap-1 opacity-60"
          onClick={() => { setRelaysDraft(relays.join("\n")); setEditingRelays(true); }}
        >
          <Settings2 size={13} /> Relays: {relays.map((r) => r.replace(/^wss?:\/\//, "")).join(", ")}
        </button>
      )}

      {/* Bunker URI alternative */}
      <div className="mb-4 mt-5 text-left">
        <label className="label text-xs font-semibold uppercase opacity-70">Or paste a bunker:// URI</label>
        <input
          className="input input-bordered w-full"
          placeholder="bunker://…"
          value={bunkerUrl}
          onChange={(e) => setBunkerUrl(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && connectBunker()}
        />
      </div>
      <button className="btn btn-ghost btn-block" onClick={connectBunker} disabled={!bunkerUrl.trim() || bunkerBusy}>
        {bunkerBusy ? "Connecting…" : "Connect with bunker URI"}
      </button>

      <button className="btn btn-ghost btn-block mt-2" onClick={onBack}>
        <ArrowLeft size={16} /> Back
      </button>
    </div>
  );
}
