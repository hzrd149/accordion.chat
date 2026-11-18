import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ExtensionAccount, PasswordAccount } from "applesauce-accounts/accounts";
import { NostrConnectSigner, PasswordSigner, PrivateKeySigner } from "applesauce-signers";
import { EMPTY } from "rxjs";
import { nip19 } from "nostr-tools";
import { approvalUrl, credentialKind, hasBrowserSigner, privateKeyBytes, signerRelays } from "../src/helpers/sign-in";
import { SignInSession } from "../src/services/sign-in";

const key = "0".repeat(63) + "1";
const pubkey = await PrivateKeySigner.fromKey(key).getPublicKey();
const relay = "wss://signer.example";
const metadata = { name: "Accordion", url: "https://accordion.example", permissions: ["sign_event:13", "nip44_decrypt"] };
const sessions: SignInSession[] = [];

function session() {
  const activate = vi.fn();
  const owner = new SignInSession(metadata, activate);
  sessions.push(owner);
  return { owner, activate };
}

const originalSubscriptionMethod = NostrConnectSigner.subscriptionMethod;
const originalPublishMethod = NostrConnectSigner.publishMethod;
beforeEach(() => {
  NostrConnectSigner.subscriptionMethod = () => EMPTY;
  NostrConnectSigner.publishMethod = async () => [];
});

afterEach(() => {
  sessions.splice(0).forEach((owner) => owner.cancel());
  vi.restoreAllMocks();
  NostrConnectSigner.subscriptionMethod = originalSubscriptionMethod;
  NostrConnectSigner.publishMethod = originalPublishMethod;
  vi.useRealTimers();
});

describe("sign-in input recognition", () => {
  it.each([
    [" bunker://example ", "bunker"],
    ["nbunksec1test", "session"],
    ["ncryptsec1test", "encrypted-key"],
    ["nsec1test", "private-key"],
    [key, "private-key"],
    ["A".repeat(64), "private-key"],
    ["npub1test", "public-key"],
    ["nprofile1test", "public-key"],
    ["nostrconnect://example", "invitation"],
    ["not a credential", "unknown"],
  ])("recognizes %s locally", (input, expected) => {
    expect(credentialKind(input)).toBe(expected);
  });

  it("decodes nsec and requires exactly 32 bytes of hex", () => {
    const bytes = privateKeyBytes(key);
    expect(privateKeyBytes(nip19.nsecEncode(bytes))).toEqual(bytes);
    expect(() => privateKeyBytes(key + "00")).toThrow();
    expect(() => privateKeyBytes("no")).toThrow();
  });

  it("normalizes and deduplicates relay addresses without accepting other schemes", () => {
    expect(signerRelays("signer.example,\nwss://signer.example/ ws://localhost:8080")).toEqual([
      "wss://signer.example/", "ws://localhost:8080/",
    ]);
    for (const input of ["", "https://example.com", "wss://user:password@example.com", "wss://example.com/#secret"]) {
      expect(() => signerRelays(input)).toThrow();
    }
  });

  it("only detects a usable injected browser signer, without calling it", () => {
    const getPublicKey = vi.fn();
    expect(hasBrowserSigner({})).toBe(false);
    expect(hasBrowserSigner({ nostr: undefined })).toBe(false);
    expect(hasBrowserSigner({ nostr: { getPublicKey } })).toBe(false);
    expect(hasBrowserSigner({ nostr: { getPublicKey, signEvent: vi.fn() } })).toBe(true);
    expect(getPublicKey).not.toHaveBeenCalled();
  });

  it("only allows secure web approval links", () => {
    expect(approvalUrl("https://signer.example/approve?token=secret")).toContain("/approve");
    for (const input of ["javascript:alert(1)", "data:text/html,test", "http://example.com", "https://user:pass@example.com"]) {
      expect(() => approvalUrl(input)).toThrow();
    }
  });
});

describe("pending sign-in ownership", () => {
  beforeEach(() => {
    // No relay traffic in app adapter tests.
    NostrConnectSigner.subscriptionMethod = () => EMPTY;
    NostrConnectSigner.publishMethod = async () => [];
  });

  it("starts a QR immediately with the app metadata and requested permissions", () => {
    vi.spyOn(NostrConnectSigner.prototype, "waitForSigner").mockReturnValue(new Promise(() => {}));
    const { owner } = session();
    owner.startQr([relay]);
    const state = owner.state$.value;
    expect(state.status).toBe("waiting");
    const uri = new URL(state.uri!);
    expect(uri.protocol).toBe("nostrconnect:");
    expect(uri.searchParams.get("name")).toBe("Accordion");
    expect(uri.searchParams.get("perms")).toContain("nip44_decrypt");
  });

  it("closes an abandoned QR and ignores its late connection after a bunker wins", async () => {
    const qrReady = Promise.withResolvers<void>();
    const wait = vi.spyOn(NostrConnectSigner.prototype, "waitForSigner").mockReturnValue(qrReady.promise);
    const close = vi.spyOn(NostrConnectSigner.prototype, "close").mockResolvedValue();
    vi.spyOn(NostrConnectSigner.prototype, "connect").mockResolvedValue(pubkey);
    vi.spyOn(NostrConnectSigner.prototype, "getPublicKey").mockResolvedValue(pubkey);
    const { owner, activate } = session();
    owner.startQr([relay]);
    const qr = wait.mock.instances[0];
    await owner.credential(`bunker://${pubkey}?relay=${encodeURIComponent(relay)}`, "");
    qrReady.resolve();
    await Promise.resolve();
    expect(activate).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledOnce();
    expect(close.mock.instances[0]).toBe(qr);
    expect(activate.mock.calls[0][0].signer).not.toBe(qr);
  });

  it("does not close the successful QR signer when the login UI unmounts", async () => {
    vi.spyOn(NostrConnectSigner.prototype, "waitForSigner").mockResolvedValue();
    vi.spyOn(NostrConnectSigner.prototype, "getPublicKey").mockResolvedValue(pubkey);
    const close = vi.spyOn(NostrConnectSigner.prototype, "close").mockResolvedValue();
    const { owner, activate } = session();
    owner.startQr([relay]);
    await vi.waitFor(() => expect(activate).toHaveBeenCalledOnce());
    owner.cancel();
    expect(close).not.toHaveBeenCalled();
    expect(activate.mock.calls[0][0].pubkey).toBe(pubkey);
  });

  it("ignores a QR identity response that arrives after cancellation", async () => {
    vi.spyOn(NostrConnectSigner.prototype, "waitForSigner").mockResolvedValue();
    const publicKey = Promise.withResolvers<string>();
    const getPublicKey = vi.spyOn(NostrConnectSigner.prototype, "getPublicKey").mockReturnValue(publicKey.promise);
    const close = vi.spyOn(NostrConnectSigner.prototype, "close").mockResolvedValue();
    const { owner, activate } = session();
    owner.startQr([relay]);
    await vi.waitFor(() => expect(getPublicKey).toHaveBeenCalled());
    owner.cancel();
    publicKey.resolve(pubkey);
    await Promise.resolve();
    expect(activate).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
  });

  it("ignores an extension result after cancellation", async () => {
    const pending = Promise.withResolvers<ExtensionAccount>();
    vi.spyOn(ExtensionAccount, "fromExtension").mockReturnValue(pending.promise);
    const { owner, activate } = session();
    const login = owner.extension();
    owner.cancel();
    pending.resolve(new ExtensionAccount(pubkey, { getPublicKey: async () => pubkey, signEvent: vi.fn() }));
    await login;
    expect(activate).not.toHaveBeenCalled();
    expect(owner.state$.value.status).toBe("idle");
  });

  it("owns and closes even a failed bunker handshake and never displays its secret", async () => {
    vi.spyOn(NostrConnectSigner.prototype, "connect").mockRejectedValue(new Error("secret-value"));
    const close = vi.spyOn(NostrConnectSigner.prototype, "close").mockResolvedValue();
    const { owner, activate } = session();
    await owner.credential(`bunker://${pubkey}?relay=${encodeURIComponent(relay)}&secret=secret-value`, "");
    expect(close).toHaveBeenCalledOnce();
    expect(activate).not.toHaveBeenCalled();
    expect(owner.state$.value.error).not.toContain("secret-value");
    expect(owner.state$.value.status).toBe("error");
  });

  it("restores nbunksec sessions without initiating another connect handshake", async () => {
    const connect = vi.spyOn(NostrConnectSigner.prototype, "connect");
    vi.spyOn(NostrConnectSigner.prototype, "requireConnection").mockResolvedValue();
    vi.spyOn(NostrConnectSigner.prototype, "getPublicKey").mockResolvedValue(pubkey);
    const { owner, activate } = session();
    const encoded = NostrConnectSigner.createNbunksec({ remote: pubkey, clientKey: key, relays: [relay] });
    await owner.credential(encoded, "");
    expect(connect).not.toHaveBeenCalled();
    expect(activate).toHaveBeenCalledOnce();
    expect(activate.mock.calls[0][0].signer.getNbunksec()).toBe(encoded);
  });

  it("exposes an explicit approval link and restores the signer's normal handler on handoff", async () => {
    const ready = Promise.withResolvers<void>();
    const wait = vi.spyOn(NostrConnectSigner.prototype, "waitForSigner").mockReturnValue(ready.promise);
    vi.spyOn(NostrConnectSigner.prototype, "getPublicKey").mockResolvedValue(pubkey);
    const { owner, activate } = session();
    owner.startQr([relay]);
    const signer = wait.mock.instances[0] as NostrConnectSigner;
    const pendingHandler = signer.onAuth;
    await signer.onAuth("https://signer.example/approve");
    expect(owner.state$.value.approval).toBe("https://signer.example/approve");
    ready.resolve();
    await vi.waitFor(() => expect(activate).toHaveBeenCalledOnce());
    expect(signer.onAuth).not.toBe(pendingHandler);
  });

  it("expires a waiting QR and allows a fresh attempt", () => {
    vi.useFakeTimers();
    vi.spyOn(NostrConnectSigner.prototype, "waitForSigner").mockReturnValue(new Promise(() => {}));
    const close = vi.spyOn(NostrConnectSigner.prototype, "close").mockResolvedValue();
    const { owner, activate } = session();
    owner.startQr([relay]);
    const first = owner.state$.value.uri;
    vi.advanceTimersByTime(180_000);
    expect(close).toHaveBeenCalledOnce();
    expect(owner.state$.value.error).toContain("timed out");
    expect(activate).not.toHaveBeenCalled();
    owner.startQr([relay]);
    expect(owner.state$.value.uri).not.toBe(first);
    expect(owner.state$.value.status).toBe("waiting");
  });
});

describe("password-protected identities", () => {
  it("never lets a cancelled unlock replace or lock a newer successful signer", async () => {
    const storedSigner = new PasswordSigner();
    storedSigner.ncryptsec = "ncryptsec1test";
    const account = new PasswordAccount(pubkey, storedSigner);
    const pending = Promise.withResolvers<void>();
    const unlock = vi.spyOn(PasswordSigner.prototype, "unlock")
      .mockImplementationOnce(async function (this: PasswordSigner) {
        await pending.promise;
        this.key = privateKeyBytes(key);
      })
      .mockImplementationOnce(async function (this: PasswordSigner) { this.key = privateKeyBytes(key); });
    const { owner, activate } = session();
    const first = owner.unlock(account, "first-password");
    owner.cancel();
    await owner.unlock(account, "second-password");
    const activeSigner = account.signer;
    pending.resolve();
    await first;
    expect(activate).toHaveBeenCalledOnce();
    expect(account.signer).toBe(activeSigner);
    expect(activeSigner.unlocked).toBe(true);
    expect((unlock.mock.instances[0] as PasswordSigner).unlocked).toBe(false);
  });

  it("encrypts raw key imports, persists only NIP-49, and can unlock after restoration", async () => {
    const { owner, activate } = session();
    await owner.credential(key, "test-password");
    expect(activate).toHaveBeenCalledOnce();
    const account = activate.mock.calls[0][0] as PasswordAccount;
    expect(account).toBeInstanceOf(PasswordAccount);
    expect(account.pubkey).toBe(pubkey);
    const json = account.toJSON();
    expect(JSON.stringify(json)).not.toContain(key);
    expect(json.signer.ncryptsec).toMatch(/^ncryptsec1/);
    const restored = PasswordAccount.fromJSON(json);
    expect(restored.unlocked).toBe(false);
    const next = session();
    await next.owner.unlock(restored, "wrong-password");
    expect(next.activate).not.toHaveBeenCalled();
    await next.owner.unlock(restored, "test-password");
    expect(next.activate).toHaveBeenCalledWith(restored);
    expect(restored.unlocked).toBe(true);
  }, 20_000);

  it("imports an encrypted key without replacing its encryption", async () => {
    const signer = await PasswordSigner.fromPrivateKey(key, "test-password");
    const { owner, activate } = session();
    await owner.credential(signer.ncryptsec!, "test-password");
    expect(activate).toHaveBeenCalledOnce();
    expect(activate.mock.calls[0][0].toJSON().signer.ncryptsec).toBe(signer.ncryptsec);
  }, 20_000);

  it("waits for backup acknowledgement before activating a generated identity", async () => {
    const { owner, activate } = session();
    const created = await owner.create("test-password");
    expect(created?.encryptedKey).toMatch(/^ncryptsec1/);
    expect(activate).not.toHaveBeenCalled();
    owner.finishCreation(created!);
    expect(activate).toHaveBeenCalledWith(created!.account);
    owner.finishCreation(created!);
    expect(activate).toHaveBeenCalledOnce();
    owner.cancel();
    expect(created!.account.unlocked).toBe(true);
  }, 20_000);

  it("locks a generated identity if the backup step is abandoned", async () => {
    const { owner, activate } = session();
    const created = await owner.create("test-password");
    owner.cancel();
    expect(created!.account.unlocked).toBe(false);
    owner.finishCreation(created!);
    expect(activate).not.toHaveBeenCalled();
  }, 20_000);
});
