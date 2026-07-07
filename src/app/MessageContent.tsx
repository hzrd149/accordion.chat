import { memo, useEffect, useMemo, useState } from "react";
import { getParsedContent } from "applesauce-content/text";
import type { Content } from "applesauce-content/nast";
import { getPubkeyFromDecodeResult } from "applesauce-core/helpers";
import { decryptToObjectURL } from "../lib/image";
import type { MediaAttachment } from "../lib/imeta";
import { UserName } from "./User";

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
  // Plaintext URLs pass straight through; encrypted ones resolve through the
  // module cache, which is the source of truth. `src` is derived from it each
  // render; `bump` only re-renders once the async decrypt lands (in a callback),
  // so nothing is set synchronously inside the effect.
  const ck = a.encryption ? attKey(a) : null;
  const cached = a.encryption ? resolved.get(ck!) ?? null : a.url;
  const [, bump] = useState(0);

  useEffect(() => {
    if (!ck || !a.encryption || resolved.has(ck)) return;
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
    // Re-render on settle (success or failure). Two-arg form so this subscriber
    // handles its own rejection — `.finally` would leave it unhandled.
    const rerender = () => !cancelled && bump((n) => n + 1);
    promise.then(rerender, rerender);
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ck]);

  return cached;
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

export const MessageContent = memo(function MessageContent({
  text,
  attachments,
  emojiTags,
}: {
  text: string;
  attachments: MediaAttachment[];
  emojiTags?: string[][];
}) {
  // Parse against a minimal event template so applesauce's `emojis` transformer
  // can resolve `:shortcode:` against the message's NIP-30 emoji tags.
  const root = useMemo(
    () => getParsedContent({ kind: 9, content: text, tags: emojiTags ?? [], created_at: 0 }),
    [text, emojiTags],
  );
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
    } else if (node.type === "mention") {
      // NIP-19 `nostr:` mention — render "@Name" from the resolved profile,
      // falling back to the raw text if the pointer carries no pubkey.
      const pubkey = getPubkeyFromDecodeResult(node.decoded);
      if (pubkey) {
        nodes.push(
          <span key={i} className="mention">
            @<UserName pubkey={pubkey} />
          </span>,
        );
      } else {
        nodes.push(<span key={i}>{node.encoded}</span>);
      }
    } else if (node.type === "emoji") {
      // NIP-30 custom emoji — render the tagged image inline.
      const e = node as unknown as { url: string; code: string; raw: string };
      nodes.push(<img key={i} className="inline-emoji" src={e.url} alt={e.raw} title={e.code} loading="lazy" />);
    } else {
      // text / mention / hashtag — render the raw written form.
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
});
