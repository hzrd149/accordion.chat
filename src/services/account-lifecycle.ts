interface AccountLifetime {
  retired: boolean;
  resources: Set<() => Promise<void>>;
  pending: Set<Promise<unknown>>;
}

const lifetimes = new Map<string, AccountLifetime>();
function lifetime(pubkey: string): AccountLifetime {
  let value = lifetimes.get(pubkey);
  if (!value) {
    value = { retired: false, resources: new Set(), pending: new Set() };
    lifetimes.set(pubkey, value);
  }
  return value;
}

/** Capture the lifetime, not just the pubkey: old adapters stay retired after a new login. */
export function accountStorageLease(pubkey: string) {
  const owner = lifetime(pubkey);
  const assertActive = () => {
    if (owner.retired) throw new Error("This account's storage was retired by sign-out");
  };
  return Object.assign(assertActive, {
    track<T>(task: Promise<T>): Promise<T> {
      owner.pending.add(task);
      void task.then(() => owner.pending.delete(task), () => owner.pending.delete(task));
      return task;
    },
  });
}

/** The returned idempotent close is also used by ordinary unmount/account switching. */
export function registerAccountResource(pubkey: string, dispose: () => Promise<void>) {
  const owner = lifetime(pubkey);
  let closing: Promise<void> | undefined;
  const close = () => {
    closing ??= Promise.resolve().then(dispose).finally(() => owner.resources.delete(close));
    return closing;
  };
  if (owner.retired) {
    void close().catch(() => {});
    throw new Error("Cannot open storage during sign-out");
  }
  owner.resources.add(close);
  return close;
}

/** A terminal barrier for this lifetime, including adapters already closed normally. */
export async function retireAccountResources(pubkey: string): Promise<void> {
  const owner = lifetime(pubkey);
  owner.retired = true;
  const results = await Promise.allSettled([...owner.pending, ...[...owner.resources].map((close) => close())]);
  const failures = results.filter((result) => result.status === "rejected");
  if (failures.length) throw new AggregateError(failures.map((result) => result.reason), "Could not close account storage");
}

/** Only after erasure succeeds may newly constructed adapters serve this pubkey again. */
export function finishAccountErasure(pubkey: string) {
  lifetimes.delete(pubkey);
}
