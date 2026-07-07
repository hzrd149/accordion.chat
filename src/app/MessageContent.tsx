import { useEffect, useMemo, useState } from "react";
import { getParsedContent } from "applesauce-content/text";
import type { Content } from "applesauce-content/nast";
import { decryptToObjectURL } from "../lib/image";
import type { MediaAttachment } from "../lib/imeta";

// Renders a chat message: applesauce-content parses the text into a NAST tree,
// and any link whose URL matches a NIP-92 attachment is rendered as decrypted
// inline media instead of a raw URL. Non-attachment links stay clickable.

const MAX_CACHED = 256;
const inflight = new Map<string, Promise<string>>();
const resolved = new Map<string, string>();

function attKey(a: MediaAttachment): string {
  return a.encryption ? `${a.url}\n${a.encryption.key}\n${a.encryption.nonce}` : a.url;
}

/** Decrypt an attachment to an object URL (or pass through a plaintext URL). */
function useAttachmentSrc(a: MediaAttachment): string | null {
  const [src, setSrc] = useState<string | null>(() => (a.encryption ? resolved.get(attKey(a)) ?? null : a.url));

  useEffect(() => {
    if (!a.encryption) {
      setSrc(a.url);
      return;
    }
    const ck = attKey(a);
    const ready = resolved.get(ck);
    if (ready) {
      setSrc(ready);
      return;
    }
    let cancelled = false;
    let promise = inflight.get(ck);
    if (!promise) {
      promise = decryptToObjectURL(a.url, a.encryption.key, a.encryption.nonce, {
        hash: a.originalHash,
        mime: a.mime,
      });
      inflight.set(ck, promise);
      promise
        .then((u) => {
          resolved.set(ck, u);
          if (resolved.size > MAX_CACHED) {
            const oldest = resolved.keys().next().value;
            if (oldest !== undefined && oldest !== ck) resolved.delete(oldest);
          }
        })
        .catch(() => inflight.get(ck) === promise && inflight.delete(ck));
    }
    setSrc(null);
    promise.then((u) => !cancelled && setSrc(u)).catch(() => !cancelled && setSrc(null));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [a.url, a.encryption?.key, a.encryption?.nonce]);

  return src;
}

function AttachmentView({ att }: { att: MediaAttachment }) {
  const src = useAttachmentSrc(att);
  const kind = att.mime?.split("/")[0];

  if (!src) return <div className="attachment loading" />;
  if (kind === "video") return <video className="attachment" src={src} controls />;
  if (kind === "audio") return <audio className="attachment audio" src={src} controls />;
  if (kind === "image" || kind === undefined) {
    return (
      <a href={src} target="_blank" rel="noreferrer" className="attachment-link">
        <img className="attachment" src={src} alt="" loading="lazy" />
      </a>
    );
  }
  // Non-previewable file — offer a download.
  return (
    <a href={src} target="_blank" rel="noreferrer" download className="attachment file">
      📎 {att.mime ?? "file"}
    </a>
  );
}

export function MessageContent({ text, attachments }: { text: string; attachments: MediaAttachment[] }) {
  const root = useMemo(() => getParsedContent(text), [text]);
  const byUrl = useMemo(() => new Map(attachments.map((a) => [a.url, a])), [attachments]);
  const rendered = new Set<string>();

  const nodes: React.ReactNode[] = [];
  root.children.forEach((node: Content, i: number) => {
    if (node.type === "link") {
      const att = byUrl.get(node.href);
      if (att) {
        rendered.add(att.url);
        nodes.push(<AttachmentView key={i} att={att} />);
      } else {
        nodes.push(
          <a key={i} href={node.href} target="_blank" rel="noreferrer">
            {node.value}
          </a>,
        );
      }
    } else if (node.type === "gallery") {
      node.links.forEach((href, j) => {
        const att = byUrl.get(href);
        if (att) {
          rendered.add(att.url);
          nodes.push(<AttachmentView key={`${i}-${j}`} att={att} />);
        } else {
          nodes.push(
            <a key={`${i}-${j}`} href={href} target="_blank" rel="noreferrer">
              {href}
            </a>,
          );
        }
      });
    } else {
      // text / mention / hashtag / emoji — render the raw written form.
      const value = "value" in node ? (node as { value?: string }).value : undefined;
      if (value) nodes.push(<span key={i}>{value}</span>);
    }
  });

  // Attachments whose URL never appeared in the text (e.g. other clients) get
  // appended so they're never silently dropped.
  const leftover = attachments.filter((a) => !rendered.has(a.url));

  return (
    <div className="msg-text">
      {nodes}
      {leftover.map((att, i) => (
        <AttachmentView key={`extra-${i}`} att={att} />
      ))}
    </div>
  );
}
