// Observes the requests the app makes of the user's signer, so long-running flows
// (joining by invite, creating a community) can show what is waiting for approval.
// Extension, remote (NIP-46) and Amber signers may prompt for every request; without
// this the UI just spins while the user is expected to approve something elsewhere.
import { BehaviorSubject } from "rxjs";
import type { ISigner } from "applesauce-signers";
import {
  COMMUNITY_LIST_KIND,
  ENCRYPTED_SEAL_KIND,
  INVITE_LIST_KIND,
  PLAINTEXT_SEAL_KIND,
} from "@applesauce/concord/helpers";

export type SignerRequest = {
  id: number;
  method: "sign" | "encrypt" | "decrypt";
  /** Event kind for `sign`. */
  kind?: number;
  /** Counterparty pubkey for `encrypt`/`decrypt`. */
  peer?: string;
  /** Whether the counterparty is the signer's own key (self-encryption). */
  self?: boolean;
  status: "pending" | "done" | "failed";
  error?: string;
};

/** Keep the most recent requests only; observers filter by `id` from when they started. */
const HISTORY = 50;
let nextId = 1;

export const signerRequests$ = new BehaviorSubject<SignerRequest[]>([]);

/** The id the next signer request will receive; requests with `id >=` it started after this call. */
export function nextSignerRequestId(): number {
  return nextId;
}

function update(id: number, patch: Partial<SignerRequest>) {
  signerRequests$.next(signerRequests$.value.map((request) => (request.id === id ? { ...request, ...patch } : request)));
}

async function track<T>(request: Omit<SignerRequest, "id" | "status">, run: () => Promise<T>): Promise<T> {
  const id = nextId++;
  signerRequests$.next([...signerRequests$.value.slice(-(HISTORY - 1)), { ...request, id, status: "pending" }]);
  try {
    const result = await run();
    update(id, { status: "done" });
    return result;
  } catch (error) {
    update(id, { status: "failed", error: error instanceof Error ? error.message : String(error) });
    throw error;
  }
}

/** Wrap a signer so every sign/encrypt/decrypt call is published on {@link signerRequests$}.
 *  `nip04`/`nip44` stay getters so a signer that gains them later (extensions inject late) still works. */
export function observeSigner(signer: ISigner, self: string): ISigner {
  const cipher = (scheme: "nip04" | "nip44") => {
    const inner = signer[scheme];
    if (!inner) return undefined;
    return {
      encrypt: (pubkey: string, plaintext: string) =>
        track({ method: "encrypt", peer: pubkey, self: pubkey === self }, () => inner.encrypt(pubkey, plaintext)),
      decrypt: (pubkey: string, ciphertext: string) =>
        track({ method: "decrypt", peer: pubkey, self: pubkey === self }, () => inner.decrypt(pubkey, ciphertext)),
    };
  };
  return {
    getPublicKey: () => signer.getPublicKey(),
    signEvent: (template) => track({ method: "sign", kind: template.kind }, () => signer.signEvent(template)),
    get nip04() {
      return cipher("nip04");
    },
    get nip44() {
      return cipher("nip44");
    },
  };
}

/** A short human description of what the signer is being asked to do. */
export function describeSignerRequest(request: SignerRequest): string {
  if (request.method === "sign") {
    switch (request.kind) {
      case ENCRYPTED_SEAL_KIND:
      case PLAINTEXT_SEAL_KIND:
        return "Sign a community message (your membership announcement)";
      case COMMUNITY_LIST_KIND:
        return "Sign your encrypted community list";
      case INVITE_LIST_KIND:
        return "Sign your encrypted invite list";
      case 22242:
        return "Authenticate with a relay";
      case 13:
        return "Sign a direct-invite seal";
      default:
        return `Sign an event (kind ${request.kind})`;
    }
  }
  if (request.method === "encrypt")
    return request.self ? "Encrypt your private community keys" : "Encrypt a message";
  return request.self ? "Decrypt your private community data" : "Decrypt a message";
}

/** Where the user should look to approve a request, by applesauce account type. */
export function signerApprovalHint(accountType: string | undefined): string {
  switch (accountType) {
    case "extension":
      return "Approve it in your browser extension.";
    case "nostr-connect":
      return "Approve it in your remote signer app.";
    case "amber-clipboard":
    case "android-native":
      return "Approve it in Amber.";
    case "serial-port":
      return "Approve it on your hardware signer.";
    default:
      return "Approve it in your signer.";
  }
}
