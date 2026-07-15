import { memo, useEffect, useMemo, useState } from "react";
import { getParsedContent } from "applesauce-content/text";
import type { Content } from "applesauce-content/nast";
import { getPubkeyFromDecodeResult } from "applesauce-core/helpers";
import Lightbox from "yet-another-react-lightbox";
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
type ImageSlide = { src: string };

// Gallery tile: square, cover-fit media; a lone last tile (odd count) spans the
// full row and goes 16:9 via the last:odd variant (mirrors the old CSS rule).
const TILE =
  "relative block overflow-hidden rounded-lg aspect-square bg-base-200 cursor-zoom-in last:odd:col-span-2 last:odd:aspect-video";
const TILE_MEDIA = "w-full h-full object-cover block m-0";
const LINK_CLASS = "text-info hover:text-info/80 underline underline-offset-2";

function attKey(a: UrlAttachment): string {
  return a.encryption ? `${a.url}\n${a.encryption.key}\n${a.encryption.nonce}` : a.url;
}

function attachmentSrc(a: UrlAttachment): string | null {
  return a.encryption ? resolved.get(attKey(a)) ?? null : a.url;
}

/** Decrypt attachments to object URLs. Plaintext URLs pass straight through. */
function useAttachmentSources(attachments: UrlAttachment[]) {
  const [, bump] = useState(0);
  const encryptedKeys = useMemo(
    () => attachments.filter((a) => a.encryption).map(attKey).join("\0"),
    [attachments],
  );

  useEffect(() => {
    const encrypted = attachments.filter((a) => a.encryption);
    if (encrypted.length === 0) return;
    let cancelled = false;
    encrypted.forEach((a) => {
      const ck = attKey(a);
      if (!a.encryption || resolved.has(ck)) return;
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
      promise
        .then(
          () => !cancelled && bump((n) => n + 1),
          () => !cancelled && bump((n) => n + 1),
        );
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [encryptedKeys]);
}

/** Images and videos tile into a gallery grid; audio/files always stand alone. */
function isGalleryMedia(att: UrlAttachment): boolean {
  const kind = att.type?.split("/")[0];
  return kind === "image" || kind === "video" || kind === undefined;
}

function isImageMedia(att: UrlAttachment): boolean {
  const kind = att.type?.split("/")[0];
  return kind === "image" || kind === undefined;
}

function AttachmentView({
  att,
  src,
  gallery,
  onImageOpen,
}: {
  att: UrlAttachment;
  src: string | null;
  gallery?: boolean;
  onImageOpen?: (src: string) => void;
}) {
  const kind = att.type?.split("/")[0];

  if (!src)
    return (
      <div
        className={
          gallery
            ? `${TILE} animate-pulse`
            : "block mt-1.5 rounded-lg w-full max-w-[240px] h-[160px] bg-base-200 animate-pulse"
        }
      />
    );
  if (kind === "video") {
    if (gallery)
      return (
        <div className={TILE}>
          <video className={TILE_MEDIA} src={src} controls playsInline />
        </div>
      );
    return (
      <video
        className="block mt-1.5 rounded-lg max-w-[min(400px,100%)] max-h-[340px]"
        src={src}
        controls
      />
    );
  }
  if (kind === "audio")
    return <audio className="block mt-1.5 rounded-lg w-full max-w-[320px] h-[40px]" src={src} controls />;
  if (kind === "image" || kind === undefined) {
    return (
      <button
        type="button"
        className={gallery ? `${TILE} appearance-none p-0 border-0` : "block appearance-none p-0 border-0 bg-transparent"}
        aria-label="Open image"
        onClick={() => onImageOpen?.(src)}
      >
        <img
          className={
            gallery
              ? TILE_MEDIA
              : "block mt-1.5 rounded-lg max-w-[min(400px,100%)] max-h-[340px] object-contain cursor-zoom-in"
          }
          src={src}
          alt=""
          loading="lazy"
        />
      </button>
    );
  }
  // Non-previewable file — offer a download.
  return (
    <a
      href={src}
      target="_blank"
      rel="noreferrer"
      download
      className="inline-block mt-1.5 rounded-lg px-3 py-2 bg-base-200 text-base-content no-underline"
    >
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
  useAttachmentSources(withUrl);
  const byUrl = useMemo(() => new Map(withUrl.map((a) => [a.url, a])), [withUrl]);
  const rendered = new Set<string>();
  const [lightbox, setLightbox] = useState<{ slides: ImageSlide[]; index: number } | null>(null);

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
            <a key={i} href={node.href} target="_blank" rel="noreferrer" className={LINK_CLASS}>
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
              <a key={`${i}-${j}`} href={href} target="_blank" rel="noreferrer" className={LINK_CLASS}>
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
            <span key={i} className="text-primary bg-primary/15 rounded px-0.5 font-medium">
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
        node: <img key={i} className="h-[1.35em] w-auto align-middle object-contain" src={e.url} alt={e.raw} title={e.code} loading="lazy" />,
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
      const att = run[0];
      out.push(
        <AttachmentView
          key={`m${key++}`}
          att={att}
          src={attachmentSrc(att)}
          onImageOpen={(src) => setLightbox({ slides: [{ src }], index: 0 })}
        />,
      );
    } else {
      const group = run;
      const imageSlides = () => group.filter(isImageMedia).map(attachmentSrc).filter((src): src is string => Boolean(src));
      out.push(
        <div className="grid grid-cols-2 gap-1 mt-1.5 max-w-[min(420px,100%)]" data-count={Math.min(group.length, 4)} key={`g${key++}`}>
          {group.map((att, j) => {
            const src = attachmentSrc(att);
            return (
              <AttachmentView
                key={j}
                att={att}
                src={src}
                gallery
                onImageOpen={(openedSrc) => {
                  const slides = imageSlides().map((src) => ({ src }));
                  const index = Math.max(0, slides.findIndex((slide) => slide.src === openedSrc));
                  setLightbox({ slides, index });
                }}
              />
            );
          })}
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
      if ("media" in it) {
        const att = it.media;
        out.push(
          <AttachmentView
            key={`m${key++}`}
            att={att}
            src={attachmentSrc(att)}
            onImageOpen={(src) => setLightbox({ slides: [{ src }], index: 0 })}
          />,
        );
      } else out.push(it.node);
    }
  }
  flushRun();

  return (
    <>
      <div className="whitespace-pre-wrap break-words text-base-content">{out}</div>
      <Lightbox
        open={Boolean(lightbox)}
        close={() => setLightbox(null)}
        index={lightbox?.index ?? 0}
        slides={lightbox?.slides ?? []}
        controller={{ closeOnBackdropClick: true }}
      />
    </>
  );
});
