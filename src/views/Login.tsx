import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { ArrowLeft, Check, Copy, ExternalLink, Eye, EyeOff, LockKeyhole, RefreshCw, Settings2, ShieldCheck } from "lucide-react";
import { use$ } from "applesauce-react/hooks";
import { NostrConnectAccount } from "applesauce-accounts/accounts";
import { distinctUntilChanged, fromEvent, interval, map, merge, startWith } from "rxjs";
import { accountAwaitingUnlock$, accounts, CONCORD_SIGNER_PERMISSIONS, NOSTR_CONNECT_RELAYS } from "../nostr";
import { QRCode } from "../components/QRCode";
import { ThemeToggle } from "../components/ThemeToggle";
import { credentialKind, hasBrowserSigner, signerRelays } from "../helpers/sign-in";
import { SignInSession } from "../services/sign-in";

const APP_METADATA = { name: "Accordion", url: window.location.origin, permissions: CONCORD_SIGNER_PERMISSIONS };
const CREDENTIAL_HINTS = {
  bunker: "Bunker link",
  session: "Bunker session",
  "private-key": "Private key",
  "encrypted-key": "Encrypted private key",
  "public-key": "This is a public key. Use your signer app or a private key to sign in.",
  invitation: "This invitation belongs in a signer app. Paste a bunker:// link to connect here.",
  unknown: "",
};

export function Login() {
  const lockedAccount = use$(accountAwaitingUnlock$);
  const [session] = useState(() => new SignInSession(APP_METADATA, (account) => {
    const existing = accounts.accounts.find((saved) => saved.type === account.type && saved.pubkey === account.pubkey &&
      (!(saved instanceof NostrConnectAccount) || (account instanceof NostrConnectAccount && saved.signer.remote === account.signer.remote)));
    if (existing && existing !== account) {
      account.metadata = existing.metadata;
      accounts.replaceAccount(existing, account);
    } else if (!existing) accounts.addAccount(account);
    accountAwaitingUnlock$.next(undefined);
    accounts.setActive(account);
  }));
  const state = use$(session.state$)!;
  const extensionAvailable = use$(() => merge(interval(1000), fromEvent(window, "focus")).pipe(
    startWith(0),
    map(() => hasBrowserSigner(window)),
    distinctUntilChanged(),
  ), []);
  const [relays, setRelays] = useState(NOSTR_CONNECT_RELAYS);
  const [relayDraft, setRelayDraft] = useState(relays.join("\n"));
  const [relayError, setRelayError] = useState("");
  const [credential, setCredential] = useState("");
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<Awaited<ReturnType<SignInSession["create"]>>>();
  const [backedUp, setBackedUp] = useState(false);
  const [copied, setCopied] = useState("");
  const [copyError, setCopyError] = useState("");
  const kind = credentialKind(credential);
  const needsPassword = kind === "private-key" || kind === "encrypted-key";
  const newPassword = creating || kind === "private-key";
  const busy = state.status === "connecting";
  const keyPasswordValid = password.length >= 8 && password === confirmation;
  const canSubmit = !!credential.trim() && !["public-key", "invitation", "unknown"].includes(kind) &&
    (!needsPassword || (newPassword ? keyPasswordValid : !!password));

  useEffect(() => {
    if (!lockedAccount && !creating) session.startQr(relays);
    return () => session.cancel();
  }, [session, relays, lockedAccount, creating]);

  useEffect(() => {
    if (!copied) return;
    const timeout = setTimeout(() => setCopied(""), 2000);
    return () => clearTimeout(timeout);
  }, [copied]);

  async function copy(value: string, label: string) {
    setCopyError("");
    try {
      await navigator.clipboard.writeText(value);
      setCopied(label);
    } catch {
      setCopyError("Could not copy. Select and copy the link or backup manually.");
    }
  }

  function resetFields() {
    setCredential("");
    setPassword("");
    setConfirmation("");
    setCreated(undefined);
    setBackedUp(false);
    setCopied("");
    setCopyError("");
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setCopyError("");
    if (lockedAccount) {
      if (password) await session.unlock(lockedAccount, password);
    } else if (creating) {
      if (keyPasswordValid) {
        const result = await session.create(password);
        setCreated(result);
        if (result) { setPassword(""); setConfirmation(""); }
      }
    } else if (canSubmit) {
      await session.credential(credential, password);
    }
  }

  return (
    <main className="relative flex min-h-dvh items-center justify-center bg-base-200 px-4 py-8 sm:py-12">
      <div className="absolute right-3 top-3"><ThemeToggle /></div>
      <section aria-labelledby="sign-in-title" className={`card w-full max-w-md border border-base-300 bg-base-100 p-6 shadow-xl sm:p-8 ${!lockedAccount && !creating ? "md:max-w-3xl" : ""}`}>
        <header className="mb-7 flex items-center justify-center gap-3">
          <span className="text-3xl" aria-hidden="true">🪗</span>
          <h1 id="sign-in-title" className="text-2xl font-bold">
            {lockedAccount ? "Welcome back" : creating ? (created ? "Save your identity" : "Create an identity") : "Sign in to Accordion"}
          </h1>
        </header>

        {state.error && <div role="alert" className="alert alert-error mb-4 text-sm">{state.error}</div>}

        {created ? (
          <div className="space-y-4">
            <div className="alert text-sm">
              <ShieldCheck size={20} />
              <span>This backup is encrypted with your password. You need both to restore your identity. Accordion cannot recover either.</span>
            </div>
            <label className="block text-sm font-medium" htmlFor="identity-backup">Encrypted identity backup</label>
            <textarea id="identity-backup" readOnly value={created.encryptedKey} rows={4}
              className="textarea w-full select-all break-all font-mono text-xs" />
            <button className="btn btn-outline w-full" onClick={() => void copy(created.encryptedKey, "backup")}>
              {copied === "backup" ? <Check size={16} /> : <Copy size={16} />}
              {copied === "backup" ? "Copied backup" : "Copy encrypted backup"}
            </button>
            <label className="flex cursor-pointer items-start gap-3 text-sm">
              <input type="checkbox" className="checkbox checkbox-sm mt-0.5" checked={backedUp} onChange={(e) => setBackedUp(e.target.checked)} />
              I saved my encrypted backup and password somewhere safe.
            </label>
            <button className="btn btn-primary w-full" disabled={!backedUp} onClick={() => session.finishCreation(created)}>Continue to Accordion</button>
          </div>
        ) : (
          <div className={!lockedAccount && !creating ? "grid gap-6 md:grid-cols-2 md:items-center md:gap-8" : ""}>
            {!lockedAccount && !creating && (
                <div className="text-center">
                  <h2 className="mb-4 text-sm font-medium">Scan to connect</h2>
                  {state.uri ? (
                    <div className="flex justify-center">
                      <a href={state.uri} aria-label="Open Nostr Connect in your signer app" className="block w-full min-w-0 max-w-[250px] rounded-lg border border-base-300 bg-white p-3">
                        <QRCode value={state.uri} />
                      </a>
                    </div>
                  ) : (
                    <div className="flex min-h-48 items-center justify-center rounded-lg bg-base-200 p-6">
                      <button className="btn btn-outline" disabled={busy} onClick={() => session.startQr(relays)}>
                        <RefreshCw size={16} /> {state.status === "idle" ? "Show connection code" : "New connection code"}
                      </button>
                    </div>
                  )}
                  <details className="mx-auto my-3 w-full max-w-[250px] text-left text-sm">
                    <summary className="flex cursor-pointer items-center justify-center gap-1.5 text-xs text-base-content/60">
                      <Settings2 size={14} /> Change signer relay
                    </summary>
                    <form className="mt-3 space-y-2" onSubmit={(event) => {
                      event.preventDefault();
                      try {
                        const next = signerRelays(relayDraft);
                        setRelayError("");
                        setRelayDraft(next.join("\n"));
                        setCopied("");
                        // Restart explicitly even if the addresses are unchanged.
                        if (next.join("\n") === relays.join("\n")) session.startQr(next);
                        else setRelays(next);
                      } catch (error) { setRelayError((error as Error).message); }
                    }}>
                      <label htmlFor="signer-relays" className="text-xs font-medium">Signer relays</label>
                      <textarea id="signer-relays" className="textarea w-full font-mono text-xs" rows={3} value={relayDraft}
                        placeholder="wss://relay.example.com" disabled={busy} onChange={(e) => setRelayDraft(e.target.value)} />
                      {relayError && <p role="alert" className="text-xs text-error">{relayError}</p>}
                      <button className="btn btn-outline btn-sm w-full" disabled={busy}>Apply & refresh code</button>
                    </form>
                  </details>
                  {busy && (
                    <p role="status" aria-live="polite" className="my-3 text-xs text-base-content/60">
                      {state.method === "extension" ? "Approve in your browser signer…" : "Connecting securely…"}
                    </p>
                  )}
                  {state.uri && (
                    <div className="flex justify-center gap-2">
                      <a href={state.uri} className="btn btn-sm btn-primary"><ExternalLink size={14} /> Open signer app</a>
                      <button className="btn btn-sm btn-ghost" onClick={() => void copy(state.uri!, "link")}>
                        {copied === "link" ? <Check size={14} /> : <Copy size={14} />}
                        {copied === "link" ? "Copied" : "Copy link"}
                      </button>
                    </div>
                  )}
                </div>
            )}

            <div className={!lockedAccount && !creating ? "min-w-0 border-t border-base-300 pt-6 md:border-l md:border-t-0 md:py-4 md:pl-8" : ""}>
              {!lockedAccount && !creating && extensionAvailable && (
                <>
                  <button className="btn btn-outline w-full" disabled={busy} onClick={() => void session.extension()}>
                    Use browser signer
                  </button>
                  <div className="divider my-4 text-xs text-base-content/45">or</div>
                </>
              )}

            <form onSubmit={(event) => void submit(event)} className="space-y-4">
              {lockedAccount ? (
                <div className="flex items-center gap-3 rounded-lg bg-base-200 p-3">
                  <LockKeyhole size={20} className="shrink-0 text-primary" />
                  <div className="min-w-0">
                    <p className="text-sm font-medium">Password-protected identity</p>
                    <p className="truncate font-mono text-xs text-base-content/60">{lockedAccount.pubkey.slice(0, 12)}…{lockedAccount.pubkey.slice(-8)}</p>
                  </div>
                </div>
              ) : !creating && (
                <div>
                  <SecretInput id="sign-in-credential" label="Connection link or key" placeholder="bunker://, nsec, ncryptsec…"
                    value={credential} disabled={busy} onChange={(value) => {
                      setCredential(value); setPassword(""); setConfirmation("");
                    }} describedBy="credential-hint" />
                  <p id="credential-hint" aria-live="polite" className="mt-2 text-xs text-base-content/60">
                    {kind === "unknown" && credential.trim() ? "Unrecognized link or key." : CREDENTIAL_HINTS[kind] && (["public-key", "invitation"].includes(kind)
                      ? CREDENTIAL_HINTS[kind]
                      : <span className="badge badge-soft badge-sm">{CREDENTIAL_HINTS[kind]}</span>)}
                  </p>
                </div>
              )}
              {(lockedAccount || creating || needsPassword) && (
                <>
                  <SecretInput id="sign-in-password" label={lockedAccount || !newPassword ? "Password" : "Choose a password"}
                    placeholder={newPassword && !lockedAccount ? "At least 8 characters" : "Enter your password"}
                    value={password} disabled={busy} onChange={setPassword}
                    autoComplete={newPassword && !lockedAccount ? "new-password" : "current-password"} />
                  {!lockedAccount && newPassword && (
                    <>
                      <SecretInput id="sign-in-confirmation" label="Confirm password" value={confirmation} disabled={busy}
                        onChange={setConfirmation} autoComplete="new-password" />
                      {confirmation && password !== confirmation && <p className="text-xs text-error">Passwords do not match.</p>}
                      <p className="text-xs text-base-content/60">Encrypts your key on this device. Passwords cannot be reset.</p>
                    </>
                  )}
                </>
              )}
              <button type="submit" className="btn btn-primary w-full"
                disabled={busy || (lockedAccount ? !password : creating ? !keyPasswordValid : !canSubmit)}>
                {busy ? <><span className="loading loading-spinner loading-sm" /> Please wait…</>
                  : lockedAccount || kind === "encrypted-key" ? "Unlock & sign in"
                    : creating ? "Create encrypted identity"
                      : kind === "private-key" ? "Encrypt & sign in" : "Connect"}
              </button>
            </form>
            </div>
          </div>
        )}

        {state.approval && (
          <div role="status" className="alert mt-4 text-sm">
            <div>
              <a href={state.approval} target="_blank" rel="noopener noreferrer" className="btn btn-primary btn-sm mt-2">
                <ExternalLink size={14} /> Approve connection
              </a>
            </div>
          </div>
        )}
        {copyError && <p role="alert" className="mt-3 text-sm text-error">{copyError}</p>}
        {busy && !created && (
          <button className="btn btn-ghost btn-sm mt-3 w-full" onClick={() => session.cancel()}>Cancel sign-in</button>
        )}

        <footer className="mt-6 border-t border-base-300 pt-4 text-center text-sm">
          {lockedAccount ? (
            <button className="btn btn-ghost btn-sm" onClick={() => {
              session.cancel(); resetFields(); accountAwaitingUnlock$.next(undefined); accounts.clearActive();
            }}>Use another identity</button>
          ) : creating ? (
            <button className="btn btn-ghost btn-sm" onClick={() => { session.cancel(); resetFields(); setCreating(false); }}>
              <ArrowLeft size={14} /> Back to sign in
            </button>
          ) : (
            <div>
              <button className="link link-primary font-medium" disabled={busy} onClick={() => {
                session.cancel(); resetFields(); setCreating(true);
              }}>Create an identity</button>
            </div>
          )}
        </footer>
      </section>
    </main>
  );
}

function SecretInput({ id, label, value, onChange, placeholder, disabled, autoComplete = "off", describedBy }: {
  id: string; label: string; value: string; onChange: (value: string) => void;
  placeholder?: string; disabled?: boolean; autoComplete?: string; describedBy?: string;
}) {
  const [visible, setVisible] = useState(false);
  return (
    <div>
      <label htmlFor={id} className="mb-2 block text-sm font-medium">{label}</label>
      <div className="input flex w-full items-center gap-2">
        <input id={id} type={visible ? "text" : "password"} className="min-w-0 grow" value={value}
          onChange={(e) => onChange(e.target.value)} placeholder={placeholder} disabled={disabled}
          autoComplete={autoComplete} autoCapitalize="none" autoCorrect="off" spellCheck={false} aria-describedby={describedBy} />
        <button type="button" className="btn btn-ghost btn-xs btn-square shrink-0" aria-label={`${visible ? "Hide" : "Show"} ${label.toLowerCase()}`}
          aria-pressed={visible} onClick={() => setVisible(!visible)}>
          {visible ? <EyeOff size={16} /> : <Eye size={16} />}
        </button>
      </div>
    </div>
  );
}
