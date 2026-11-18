import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Subject } from "rxjs";
import type { ConcordClient, ConcordDiagnostic } from "@applesauce/concord";

// Exercise subscriptions and async handlers without adding a browser test runtime.
const hooks = vi.hoisted(() => ({
  state: undefined as unknown,
  memo: undefined as unknown,
  memoDeps: undefined as unknown[] | undefined,
  effectDeps: undefined as unknown[] | undefined,
  cleanup: undefined as (() => void) | undefined,
  ref: undefined as { current: unknown } | undefined,
}));
vi.mock("react", async (importOriginal) => {
  const original = await importOriginal<typeof import("react")>();
  const changed = (a: unknown[] | undefined, b: unknown[]) =>
    !a || a.length !== b.length || a.some((value, index) => value !== b[index]);
  return {
    ...original,
    useRef: (initial: unknown) => {
      hooks.ref ??= { current: initial };
      return hooks.ref;
    },
    useState: (initial: () => unknown) => {
      hooks.state ??= initial();
      return [hooks.state, (next: unknown) => {
        hooks.state = typeof next === "function" ? next(hooks.state) : next;
      }];
    },
    useMemo: (factory: () => unknown, deps: unknown[]) => {
      if (changed(hooks.memoDeps, deps)) {
        hooks.memo = factory();
        hooks.memoDeps = deps;
      }
      return hooks.memo;
    },
    useEffect: (effect: () => (() => void), deps: unknown[]) => {
      if (changed(hooks.effectDeps, deps)) {
        hooks.cleanup?.();
        hooks.cleanup = effect();
        hooks.effectDeps = deps;
      }
    },
  };
});

import { ConcordDiagnostics } from "../src/components/ConcordDiagnostics";

function fixture() {
  const diagnostics$ = new Subject<ConcordDiagnostic>();
  const retryStorageCleanup = vi.fn<() => Promise<void>>().mockResolvedValue();
  const client = { diagnostics$, retryStorageCleanup } as unknown as ConcordClient;
  return { client, diagnostics$, retryStorageCleanup };
}

function issue(stage: ConcordDiagnostic["stage"] = "storage-cleanup", error: unknown = "disk unavailable") {
  return { stage, error, communityId: "community", key: "private-channel" } as ConcordDiagnostic;
}

function view(client: ConcordClient) {
  const tree = ConcordDiagnostics({ client });
  const buttons: ReactElement<{ children: string; onClick: () => void; disabled?: boolean }>[] = [];
  function visit(node: unknown) {
    if (Array.isArray(node)) return node.forEach(visit);
    if (!node || typeof node !== "object" || !("props" in node)) return;
    const element = node as ReactElement<{ children?: unknown }>;
    if (element.type === "button") buttons.push(element as typeof buttons[number]);
    visit(element.props.children);
  }
  visit(tree);
  return {
    html: tree ? renderToStaticMarkup(tree) : "",
    retry: buttons.find(({ props }) => props.children.includes("cleanup")),
    dismiss: buttons.find(({ props }) => props.children === "Dismiss"),
  };
}

beforeEach(() => {
  hooks.cleanup?.();
  hooks.state = hooks.memo = hooks.memoDeps = hooks.effectDeps = hooks.cleanup = hooks.ref = undefined;
});

describe("SDK local storage cleanup recovery", () => {
  it("offers retry only for storage-cleanup, retaining unrelated diagnostics after recovery", async () => {
    const f = fixture();
    view(f.client);
    for (const stage of ["plane-publish", "material-persist", "expiration-purge"] as const) {
      f.diagnostics$.next(issue(stage));
    }
    expect(view(f.client).retry).toBeUndefined();
    f.diagnostics$.next(issue("direct-invite-receive", "hidden invite error"));
    expect(view(f.client).html).not.toContain("hidden invite error");
    f.diagnostics$.next(issue());
    view(f.client).retry!.props.onClick();
    await Promise.resolve();
    expect(f.retryStorageCleanup).toHaveBeenCalledTimes(1);
    expect(view(f.client).retry).toBeUndefined();
    expect(view(f.client).html).toContain("plane-publish");
  });

  it("keeps cleanup actionable after unrelated diagnostics overflow the journal", () => {
    const f = fixture();
    view(f.client);
    f.diagnostics$.next(issue());
    for (let i = 0; i < 10; i++) f.diagnostics$.next(issue("material-persist", `error ${i}`));
    expect(view(f.client).retry).toBeDefined();
    expect(view(f.client).html).not.toContain("error 0");
  });

  it("retains fresh SDK cleanup failures even when retry resolves, and prevents concurrent attempts", async () => {
    const f = fixture();
    const deferred = Promise.withResolvers<void>();
    f.retryStorageCleanup.mockReturnValue(deferred.promise);
    view(f.client);
    f.diagnostics$.next(issue());
    const retry = view(f.client).retry!;
    retry.props.onClick();
    retry.props.onClick();
    expect(f.retryStorageCleanup).toHaveBeenCalledTimes(1);
    expect(view(f.client).retry!.props.disabled).toBe(true);
    f.diagnostics$.next(issue("storage-cleanup", "still blocked"));
    deferred.resolve();
    await deferred.promise;
    expect(view(f.client).html).toContain("still blocked");
    expect(view(f.client).html).not.toContain("disk unavailable");
    expect(view(f.client).retry!.props.disabled).toBe(false);
  });

  it("surfaces rejected retries and allows another attempt", async () => {
    const f = fixture();
    f.retryStorageCleanup.mockRejectedValue(new Error("retry failed"));
    view(f.client);
    f.diagnostics$.next(issue());
    view(f.client).retry!.props.onClick();
    await Promise.resolve();
    expect(view(f.client).html).toContain("Cleanup retry failed: retry failed");
    expect(view(f.client).retry!.props.disabled).toBe(false);
    f.retryStorageCleanup.mockResolvedValue();
    view(f.client).retry!.props.onClick();
    await Promise.resolve();
    expect(view(f.client).html).toBe("");
  });

  it("dismisses notices without retrying or altering SDK cleanup work", () => {
    const f = fixture();
    view(f.client);
    f.diagnostics$.next(issue());
    view(f.client).dismiss!.props.onClick();
    expect(view(f.client).html).toBe("");
    expect(f.retryStorageCleanup).not.toHaveBeenCalled();
    f.diagnostics$.next(issue());
    expect(view(f.client).retry).toBeDefined();
  });

  it.each(["resolve", "reject"] as const)("isolates a switched client's diagnostics from late %s", async (outcome) => {
    const old = fixture();
    const next = fixture();
    const deferred = Promise.withResolvers<void>();
    old.retryStorageCleanup.mockReturnValue(deferred.promise);
    view(old.client);
    old.diagnostics$.next(issue());
    view(old.client).retry!.props.onClick();
    expect(view(next.client).html).toBe("");
    next.diagnostics$.next(issue("storage-cleanup", "next account"));
    old.diagnostics$.next(issue("material-persist", "old account"));
    if (outcome === "resolve") deferred.resolve();
    else deferred.reject(new Error("old retry failed"));
    await Promise.resolve();
    expect(view(next.client).html).toContain("next account");
    expect(view(next.client).html).not.toContain("old account");
    expect(view(next.client).html).not.toContain("old retry failed");
    expect(view(next.client).retry!.props.disabled).toBe(false);
    hooks.cleanup?.();
    expect(next.diagnostics$.observed).toBe(false);
  });
});
