import type { IAccount } from "applesauce-accounts";
import { ExtensionAccount, NostrConnectAccount, PasswordAccount } from "applesauce-accounts/accounts";
import { NostrConnectSigner, PasswordSigner, PrivateKeySigner } from "applesauce-signers";
import type { NostrConnectAppMetadata } from "applesauce-signers/helpers";
import { BehaviorSubject } from "rxjs";
import { approvalUrl, credentialKind, privateKeyBytes } from "../helpers/sign-in";

type Method = "qr" | "credential" | "extension" | "create" | "unlock";
export interface SignInState {
  method?: Method;
  status: "idle" | "waiting" | "connecting" | "error";
  uri?: string;
  approval?: string;
  error?: string;
}
interface Attempt {
  controller: AbortController;
  handedOff?: boolean;
  signer?: NostrConnectSigner;
  passwordSigner?: PasswordSigner;
  restoreAuth?: () => void;
  timer?: ReturnType<typeof setTimeout>;
}

/**
 * One owner for every pending sign-in. Switching methods invalidates the previous
 * attempt before closing it, so late QR/extension/decryption results cannot log in.
 * A successful remote signer is handed to the account, not closed on UI unmount.
 */
export class SignInSession {
  readonly state$ = new BehaviorSubject<SignInState>({ status: "idle" });
  private attempt?: Attempt;
  private readonly metadata: NostrConnectAppMetadata;
  private readonly onAccount: (account: IAccount) => void;

  constructor(metadata: NostrConnectAppMetadata, onAccount: (account: IAccount) => void) {
    this.metadata = metadata;
    this.onAccount = onAccount;
  }

  cancel() {
    const attempt = this.attempt;
    this.attempt = undefined;
    if (attempt) {
      attempt.controller.abort();
      clearTimeout(attempt.timer);
      attempt.restoreAuth?.();
      void attempt.signer?.close().catch(() => {});
      attempt.passwordSigner?.lock();
    }
    this.state$.next({ status: "idle" });
  }

  private begin(method: Method, status: "waiting" | "connecting" = "connecting") {
    this.cancel();
    const attempt: Attempt = { controller: new AbortController() };
    this.attempt = attempt;
    this.state$.next({ method, status });
    return attempt;
  }

  private attach(attempt: Attempt, signer: NostrConnectSigner) {
    attempt.signer = signer;
    const previous = signer.onAuth;
    signer.onAuth = async (url) => {
      if (this.attempt !== attempt) return;
      this.state$.next({ ...this.state$.value, approval: approvalUrl(url) });
    };
    attempt.restoreAuth = () => { signer.onAuth = previous; };
    return signer;
  }

  private complete(attempt: Attempt, account: IAccount) {
    if (this.attempt !== attempt) {
      if (!attempt.handedOff) attempt.passwordSigner?.lock();
      return;
    }
    clearTimeout(attempt.timer);
    attempt.restoreAuth?.();
    attempt.handedOff = true;
    this.attempt = undefined;
    this.onAccount(account);
  }

  private fail(attempt: Attempt, message: string) {
    if (this.attempt !== attempt) return;
    const method = this.state$.value.method;
    this.cancel();
    this.state$.next({ method, status: "error", error: message });
  }

  startQr(relays: string[]) {
    const attempt = this.begin("qr", "waiting");
    try {
      const signer = this.attach(attempt, new NostrConnectSigner({ relays, metadata: this.metadata }));
      this.state$.next({ method: "qr", status: "waiting", uri: signer.getNostrConnectURI(this.metadata) });
      attempt.timer = setTimeout(() => this.fail(attempt, "This connection code timed out. Generate a new code to try again."), 180_000);
      void (async () => {
        await signer.waitForSigner(attempt.controller.signal);
        if (this.attempt !== attempt) return;
        this.state$.next({ ...this.state$.value, status: "connecting", approval: undefined });
        const pubkey = await signer.getPublicKey();
        this.complete(attempt, new NostrConnectAccount(pubkey, signer));
      })().catch(() => this.fail(attempt, "Could not connect to your signer. Try a new code or another sign-in method."));
    } catch {
      this.fail(attempt, "Could not create a connection code. Check your signer relays and try again.");
    }
  }

  async extension() {
    const attempt = this.begin("extension");
    try { this.complete(attempt, await ExtensionAccount.fromExtension()); }
    catch { this.fail(attempt, "Browser sign-in was declined or unavailable. Try again or use your signer app."); }
  }

  async credential(input: string, password: string) {
    const attempt = this.begin("credential");
    const value = input.trim();
    const kind = credentialKind(value);
    try {
      if (kind === "bunker" || kind === "session") {
        // Construct before awaiting so even a failed or cancelled handshake has
        // an owned signer to close (the async convenience factories hide it).
        const signer = this.attach(attempt, kind === "bunker"
          ? new NostrConnectSigner({ ...NostrConnectSigner.parseBunkerURI(value), metadata: this.metadata })
          : (() => {
              const data = NostrConnectSigner.parseNbunksec(value);
              return new NostrConnectSigner({
                remote: data.remote, relays: data.relays, bunkerSecret: data.bunkerSecret,
                signer: PrivateKeySigner.fromKey(data.clientKey), metadata: this.metadata,
              });
            })());
        if (kind === "bunker") await signer.connect(signer.bunkerSecret, this.metadata.permissions);
        else await signer.requireConnection();
        if (this.attempt !== attempt) return;
        const pubkey = await signer.getPublicKey();
        this.complete(attempt, new NostrConnectAccount(pubkey, signer));
      } else if (kind === "private-key" || kind === "encrypted-key") {
        if (!password) throw new Error("Password required");
        if (kind === "private-key" && password.length < 8) throw new Error("Choose a longer password");
        const signer = new PasswordSigner();
        attempt.passwordSigner = signer;
        if (kind === "encrypted-key") {
          signer.ncryptsec = value;
          await signer.unlock(password);
        } else {
          signer.key = privateKeyBytes(value);
          await signer.setPassword(password);
        }
        if (this.attempt !== attempt) { signer.lock(); return; }
        this.complete(attempt, new PasswordAccount(await signer.getPublicKey(), signer));
      } else {
        this.fail(attempt, kind === "public-key"
          ? "A public key cannot sign in. Use your signer app or a private key."
          : kind === "invitation"
            ? "Open a Nostr Connect invitation in your signer app. To connect here, paste a bunker:// link instead."
            : "Enter a bunker:// link, nbunksec session, nsec private key, hex private key, or ncryptsec encrypted key.");
      }
    } catch {
      // SDK parse/decryption errors may contain the supplied credential.
      this.fail(attempt, kind === "encrypted-key"
        ? "Could not unlock this encrypted key. Check the key and password."
        : kind === "private-key"
          ? "Could not import this private key. Check the key and try again."
          : "Could not connect to this signer. Check the connection credential and approve the request in your signer.");
    }
  }

  async create(password: string) {
    const attempt = this.begin("create");
    const signer = new PasswordSigner();
    attempt.passwordSigner = signer;
    try {
      if (password.length < 8) throw new Error("Choose a longer password");
      signer.key = new PrivateKeySigner().key;
      await signer.setPassword(password);
      if (this.attempt !== attempt) { signer.lock(); return undefined; }
      // The UI must offer a backup before activating the new identity.
      return { account: new PasswordAccount(await signer.getPublicKey(), signer), encryptedKey: signer.ncryptsec!, attempt };
    } catch {
      this.fail(attempt, "Could not create an identity. Please try again.");
    }
  }

  finishCreation(created: NonNullable<Awaited<ReturnType<SignInSession["create"]>>>) {
    this.complete(created.attempt, created.account);
  }

  async unlock(account: PasswordAccount, password: string) {
    const attempt = this.begin("unlock");
    // Unlock an isolated signer. A cancelled password attempt must not later
    // unlock (or re-lock) the account that another attempt has activated.
    const signer = new PasswordSigner();
    signer.ncryptsec = account.signer.ncryptsec;
    attempt.passwordSigner = signer;
    try {
      await signer.unlock(password);
      if (await signer.getPublicKey() !== account.pubkey) throw new Error("Stored identity does not match the key");
      if (this.attempt !== attempt) { signer.lock(); return; }
      account.signer = signer;
      this.complete(attempt, account);
    } catch {
      this.fail(attempt, "Could not unlock your identity. Check your password and try again.");
    }
  }
}
