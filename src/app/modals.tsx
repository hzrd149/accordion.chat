import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { useConcord } from "./context";

export function Modal({ children, onClose }: { children: ReactNode; onClose: () => void }) {
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        {children}
      </div>
    </div>
  );
}

export function CreateCommunityModal({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => void }) {
  const client = useConcord();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [relays, setRelays] = useState("wss://relay.damus.io\nwss://nos.lol");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function create() {
    setBusy(true);
    setError("");
    try {
      const relayList = relays.split("\n").map((r) => r.trim()).filter(Boolean);
      const id = await client.createNewCommunity(name.trim(), description.trim(), relayList);
      onCreated(id);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  return (
    <Modal onClose={onClose}>
      <h2>Create a community</h2>
      <p className="sub">Your community, your rules. It's yours forever — you're the owner.</p>
      {error && <div className="error">{error}</div>}
      <div className="field">
        <label>Community name</label>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="My Community" maxLength={64} autoFocus />
      </div>
      <div className="field">
        <label>Description (optional)</label>
        <input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What's it about?" />
      </div>
      <div className="field">
        <label>Relays (one per line)</label>
        <textarea value={relays} onChange={(e) => setRelays(e.target.value)} rows={3} />
      </div>
      <div className="modal-actions">
        <button className="btn secondary" onClick={onClose}>
          Cancel
        </button>
        <button className="btn" onClick={create} disabled={!name.trim() || busy}>
          {busy ? "Creating…" : "Create"}
        </button>
      </div>
    </Modal>
  );
}

export function JoinModal({ onClose, onJoined }: { onClose: () => void; onJoined: (id: string) => void }) {
  const client = useConcord();
  const [link, setLink] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function join() {
    setBusy(true);
    setError("");
    try {
      const id = await client.joinByLink(link.trim());
      onJoined(id);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  return (
    <Modal onClose={onClose}>
      <h2>Join a community</h2>
      <p className="sub">Paste an invite link. Only people with the link can join.</p>
      {error && <div className="error">{error}</div>}
      <div className="field">
        <label>Invite link</label>
        <input
          value={link}
          onChange={(e) => setLink(e.target.value)}
          placeholder="https://…/invite/naddr…#…"
          autoFocus
        />
      </div>
      <div className="modal-actions">
        <button className="btn secondary" onClick={onClose}>
          Cancel
        </button>
        <button className="btn" onClick={join} disabled={!link.trim() || busy}>
          {busy ? "Joining…" : "Join"}
        </button>
      </div>
    </Modal>
  );
}

export function CreateChannelModal({ cid, onClose }: { cid: string; onClose: () => void }) {
  const client = useConcord();
  const [name, setName] = useState("");
  const [priv, setPriv] = useState(false);
  const [busy, setBusy] = useState(false);

  async function create() {
    setBusy(true);
    try {
      await client.createChannel(cid, name.trim().toLowerCase().replace(/\s+/g, "-"), priv);
      onClose();
    } catch {
      setBusy(false);
    }
  }

  return (
    <Modal onClose={onClose}>
      <h2>Create channel</h2>
      <div className="field">
        <label>Channel name</label>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="new-channel" autoFocus maxLength={64} />
      </div>
      <div className="check-row">
        <input type="checkbox" id="priv" checked={priv} onChange={(e) => setPriv(e.target.checked)} />
        <label htmlFor="priv" style={{ margin: 0 }}>
          Private channel (its own key, only role-holders can read)
        </label>
      </div>
      <div className="modal-actions">
        <button className="btn secondary" onClick={onClose}>
          Cancel
        </button>
        <button className="btn" onClick={create} disabled={!name.trim() || busy}>
          Create
        </button>
      </div>
    </Modal>
  );
}

export function InviteModal({ cid, onClose }: { cid: string; onClose: () => void }) {
  const client = useConcord();
  const [link, setLink] = useState("");
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return; // mint one link per modal open (StrictMode-safe)
    started.current = true;
    (async () => {
      try {
        const base = window.location.origin;
        setLink(await client.createInvite(cid, base));
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setBusy(false);
      }
    })();
  }, [cid, client]);

  return (
    <Modal onClose={onClose}>
      <h2>Invite people</h2>
      <p className="sub">Anyone with this link can join. The link carries no keys — those live encrypted on relays.</p>
      {error && <div className="error">{error}</div>}
      {busy ? (
        <p>Minting invite…</p>
      ) : (
        <>
          <div className="invite-link">{link}</div>
          <button className="btn full" onClick={() => navigator.clipboard.writeText(link)}>
            Copy link
          </button>
        </>
      )}
    </Modal>
  );
}
