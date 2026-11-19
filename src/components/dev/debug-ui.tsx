/** Small presentational primitives shared by the developer debug views. */
import { useState } from "react";
import type { ReactNode } from "react";
import { Check, ChevronRight, Copy } from "lucide-react";
import { UserLabel } from "../User";
import { shortHex } from "../../helpers/concord-history";

/** Clipboard write with a short-lived copied/failed flag for button feedback. */
function useCopy(ms = 1200) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const copy = (text: string) => {
    const done = (s: "copied" | "failed") => {
      setState(s);
      setTimeout(() => setState("idle"), ms);
    };
    navigator.clipboard.writeText(text).then(() => done("copied"), () => done("failed"));
  };
  return { state, copy };
}

/**
 * A small copy button. `text` is evaluated on click so large snapshots are only built
 * when needed. Click handling is contained, so it also works inside a `<summary>`.
 */
export function CopyButton({ text, label = "Copy", title, className = "btn-ghost btn-xs" }: { text: () => string; label?: string; title?: string; className?: string }) {
  const { state, copy } = useCopy();
  return (
    <button
      type="button"
      className={`btn gap-1 ${className}`}
      title={title ?? "Copy to the clipboard"}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        copy(text());
      }}
    >
      {state === "copied" ? <Check size={14} className="text-success" /> : <Copy size={14} />}
      {state === "failed" ? "Copy failed" : label}
    </button>
  );
}

/** A titled block of a debug tab, with an optional one-line summary and copy action beside the title. */
export function DebugSection({ title, summary, copy, children }: { title: string; summary?: ReactNode; copy?: () => string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-base-300 pb-1.5">
        <h3 className="font-bold uppercase tracking-wide opacity-70">{title}</h3>
        {summary && <span className="opacity-70 min-w-0">{summary}</span>}
        {copy && (
          <span className="ml-auto">
            <CopyButton text={copy} title={`Copy ${title.toLowerCase()} as JSON`} />
          </span>
        )}
      </div>
      {children}
    </section>
  );
}

/** Horizontal tab strip; scrolls sideways instead of wrapping on narrow screens. */
export function DebugTabs<T extends string>({
  tabs,
  value,
  onChange,
  size,
}: {
  tabs: readonly { id: T; label: ReactNode }[];
  value: T;
  onChange: (id: T) => void;
  size?: "sm";
}) {
  return (
    <div role="tablist" className={`tabs tabs-border flex-nowrap overflow-x-auto overflow-y-hidden ${size === "sm" ? "tabs-sm" : ""}`}>
      {tabs.map((t) => (
        <button
          key={t.id}
          role="tab"
          aria-selected={t.id === value}
          className={`tab shrink-0 whitespace-nowrap gap-1.5 ${t.id === value ? "tab-active" : ""}`}
          onClick={() => onChange(t.id)}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

export function KV({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline gap-3 min-w-0">
      <span className="w-40 shrink-0 opacity-60">{label}</span>
      <span className="min-w-0 break-all">{children}</span>
    </div>
  );
}

export function Mono({ children, title }: { children: ReactNode; title?: string }) {
  return (
    <code className="font-mono opacity-80" title={title}>
      {children}
    </code>
  );
}

/** A hex value shown shortened (or in full), copied whole on click. */
export function Hex({ value, full = false }: { value: string | undefined; full?: boolean }) {
  const { state, copy } = useCopy();
  if (!value) return <Mono>—</Mono>;
  return (
    <button
      type="button"
      className="inline-flex items-center gap-1 font-mono opacity-80 hover:opacity-100 hover:text-primary cursor-copy align-baseline break-all text-left"
      title={`${value}\nClick to copy`}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        copy(value);
      }}
    >
      <span>{full ? value : shortHex(value)}</span>
      {state === "copied" ? <Check size={16} className="shrink-0 text-success" /> : <Copy size={16} className={`shrink-0 ${state === "failed" ? "text-error" : "opacity-50"}`} />}
    </button>
  );
}

export function UserList({ pubkeys, empty = "None." }: { pubkeys: Iterable<string>; empty?: string }) {
  const list = [...pubkeys];
  if (list.length === 0) return <p className="opacity-60">{empty}</p>;
  return (
    <div className="flex flex-col gap-1">
      {list.map((p) => (
        <div key={p} className="flex items-center gap-2">
          <UserLabel pubkey={p} />
          <Hex value={p} />
        </div>
      ))}
    </div>
  );
}

/** A copyable, scrollable JSON block. */
export function JsonBlock({ json, maxHeight = "max-h-[50vh]" }: { json: string; maxHeight?: string }) {
  return (
    <div className="relative">
      <span className="absolute right-2 top-2">
        <CopyButton text={() => json} className="btn-ghost btn-sm" />
      </span>
      <pre className={`${maxHeight} overflow-auto rounded-box bg-base-200 p-3 pr-24 font-mono whitespace-pre select-text`}>{json}</pre>
    </div>
  );
}

/** A collapsible block with a title and a one-line summary visible while closed. */
export function Expandable({ title, summary, open, copy, children }: { title: string; summary?: ReactNode; open?: boolean; copy?: () => string; children: ReactNode }) {
  return (
    <details className="group" open={open}>
      <summary className="cursor-pointer list-none [&::-webkit-details-marker]:hidden px-3 py-2 flex items-center gap-3 select-none hover:bg-base-200">
        <ChevronRight size={16} className="shrink-0 opacity-60 transition-transform group-open:rotate-90" />
        <span className="font-semibold">{title}</span>
        {summary && <span className="opacity-60 truncate min-w-0">{summary}</span>}
        {copy && (
          <span className="ml-auto shrink-0">
            <CopyButton text={copy} title={`Copy ${title.toLowerCase()} as JSON`} />
          </span>
        )}
      </summary>
      <div className="px-3 pb-3 pt-1 pl-10 flex flex-col gap-2">{children}</div>
    </details>
  );
}

/** Vertical tab list for a side rail; falls back to a horizontal strip on narrow screens. */
export function DebugSideTabs<T extends string>({
  tabs,
  value,
  onChange,
}: {
  tabs: readonly { id: T; label: ReactNode }[];
  value: T;
  onChange: (id: T) => void;
}) {
  return (
    <>
      <ul role="tablist" className="menu w-44 shrink-0 p-0 gap-0.5 self-start max-md:hidden">
        {tabs.map((t) => (
          <li key={t.id}>
            <button role="tab" aria-selected={t.id === value} className={`justify-between ${t.id === value ? "menu-active" : ""}`} onClick={() => onChange(t.id)}>
              {t.label}
            </button>
          </li>
        ))}
      </ul>
      <div className="md:hidden">
        <DebugTabs tabs={tabs} value={value} onChange={onChange} size="sm" />
      </div>
    </>
  );
}
