import { memo, useEffect, useMemo, useState } from "react";
import { getParsedContent } from "applesauce-content/text";
import type { Content } from "applesauce-content/nast";
import { getPubkeyFromDecodeResult } from "applesauce-core/helpers";
import { decryptToObjectURL } from "../lib/image";
import type { MediaAttachment } from "applesauce-concord/helpers";
import { UserName } from "./User";

// Renders a chat message: applesauce-content parses the text into a NAST tree,
// and any link whose URL matches a NIP-92 attachment is rendered as decrypted
// inline media instead of a raw URL. Non-attachment links stay clickable.

const MAX_CACHED = 256;
const inflight = new Map<string, Promise<string>>();
const resolved = new Map<string, string>();

/** A media attachment with a resolved URL (the only kind we render). */
type UrlAttachment = MediaAttachment & { url: string };

function attKey(a: UrlAttachment): string {
  return a.encryption ? `${a.url}\n${a.encryption.key}\n${a.encryption.nonce}` : a.url;
}

/** Decrypt an attachment to an object URL (or pass through a plaintext URL). */
function useAttachmentSrc(a: UrlAttachment): string | null {
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
        hash: a.originalSha256,
        mime: a.type,
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

/** Images and videos tile into a gallery grid; audio/files always stand alone. */
function isGalleryMedia(att: UrlAttachment): boolean {
  const kind = att.type?.split("/")[0];
  return kind === "image" || kind === "video" || kind === undefined;
}

function AttachmentView({ att, gallery }: { att: UrlAttachment; gallery?: boolean }) {
  const src = useAttachmentSrc(att);
  const kind = att.type?.split("/")[0];

  if (!src) return <div className={gallery ? "attachment-tile loading" : "attachment loading"} />;
  if (kind === "video") {
    if (gallery)
      return (
        <div className="attachment-tile">
          <video src={src} controls playsInline />
        </div>
      );
    return <video className="attachment" src={src} controls />;
  }
  if (kind === "audio") return <audio className="attachment audio" src={src} controls />;
  if (kind === "image" || kind === undefined) {
    return (
      <a
        href={src}
        target="_blank"
        rel="noreferrer"
        className={gallery ? "attachment-tile" : "attachment-link"}
      >
        <img className={gallery ? undefined : "attachment"} src={src} alt="" loading="lazy" />
      </a>
    );
  }
  // Non-previewable file — offer a download.
  return (
    <a href={src} target="_blank" rel="noreferrer" download className="attachment file">
      📎 {att.type ?? "file"}
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
  const withUrl = useMemo(
    () => attachments.filter((a): a is UrlAttachment => Boolean(a.url)),
    [attachments],
  );
  const byUrl = useMemo(() => new Map(withUrl.map((a) => [a.url, a])), [withUrl]);
  const rendered = new Set<string>();

  // Build an interleaved list of text nodes and media attachments; a second pass
  // coalesces consecutive runs of image/video media into a gallery grid.
  type Item = { media: UrlAttachment } | { node: React.ReactNode };
  const items: Item[] = [];
  root.children.forEach((node: Content, i: number) => {
    if (node.type === "link") {
      const att = byUrl.get(node.href);
      if (att) {
        rendered.add(att.url);
        items.push({ media: att });
      } else {
        items.push({
          node: (
            <a key={i} href={node.href} target="_blank" rel="noreferrer">
              {node.value}
            </a>
          ),
        });
      }
    } else if (node.type === "gallery") {
      node.links.forEach((href, j) => {
        const att = byUrl.get(href);
        if (att) {
          rendered.add(att.url);
          items.push({ media: att });
        } else {
          items.push({
            node: (
              <a key={`${i}-${j}`} href={href} target="_blank" rel="noreferrer">
                {href}
              </a>
            ),
          });
        }
      });
    } else if (node.type === "mention") {
      // NIP-19 `nostr:` mention — render "@Name" from the resolved profile,
      // falling back to the raw text if the pointer carries no pubkey.
      const pubkey = getPubkeyFromDecodeResult(node.decoded);
      if (pubkey) {
        items.push({
          node: (
            <span key={i} className="mention">
              @<UserName pubkey={pubkey} />
            </span>
          ),
        });
      } else {
        items.push({ node: <span key={i}>{node.encoded}</span> });
      }
    } else if (node.type === "emoji") {
      // NIP-30 custom emoji — render the tagged image inline.
      const e = node as unknown as { url: string; code: string; raw: string };
      items.push({
        node: <img key={i} className="inline-emoji" src={e.url} alt={e.raw} title={e.code} loading="lazy" />,
      });
    } else {
      // text / mention / hashtag — render the raw written form.
      const value = "value" in node ? (node as { value?: string }).value : undefined;
      if (value) items.push({ node: <span key={i}>{value}</span> });
    }
  });

  // Attachments whose URL never appeared in the text (e.g. other clients) get
  // appended so they're never silently dropped.
  withUrl.filter((a) => !rendered.has(a.url)).forEach((att) => items.push({ media: att }));

  // Coalesce consecutive image/video media into gallery grids. Text between two
  // images breaks the run, so only truly adjacent media tile together.
  const out: React.ReactNode[] = [];
  let run: UrlAttachment[] = [];
  let key = 0;
  const flushRun = () => {
    if (run.length === 0) return;
    if (run.length === 1) {
      out.push(<AttachmentView key={`m${key++}`} att={run[0]} />);
    } else {
      const group = run;
      out.push(
        <div className="msg-gallery" data-count={Math.min(group.length, 4)} key={`g${key++}`}>
          {group.map((att, j) => (
            <AttachmentView key={j} att={att} gallery />
          ))}
        </div>,
      );
    }
    run = [];
  };
  for (const it of items) {
    if ("media" in it && isGalleryMedia(it.media)) {
      run.push(it.media);
    } else {
      flushRun();
      if ("media" in it) out.push(<AttachmentView key={`m${key++}`} att={it.media} />);
      else out.push(it.node);
    }
  }
  flushRun();

  return <div className="msg-text">{out}</div>;
});
