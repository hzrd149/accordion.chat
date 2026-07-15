import { memo, useEffect, useMemo, useState } from "react";
import { getParsedContent } from "applesauce-content/text";
import type { Content } from "applesauce-content/nast";
import {
  decodeAddressPointer,
  decodeEventPointer,
  getProfileContent,
  getPubkeyFromDecodeResult,
  isAddressPointer,
  isEventPointer,
  type AddressPointer,
  type EventPointer,
} from "applesauce-core/helpers";
import { use$, useEventStore, useRenderedContent, type ComponentMap } from "applesauce-react/hooks";
import { kinds, type NostrEvent } from "nostr-tools";
import Lightbox from "yet-another-react-lightbox";
import { decryptToObjectURL } from "../lib/image";
import type { MediaAttachment } from "applesauce-concord/helpers";
import { shortNpub } from "../lib/util";
import { UserAvatar, UserName } from "./User";

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
const MAX_EMBED_DEPTH = 1;

type NostrPointer = EventPointer | AddressPointer;

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

function tagValue(event: NostrEvent, name: string): string | undefined {
  return event.tags.find((tag) => tag[0] === name)?.[1];
}

function eventTitle(event: NostrEvent): string | undefined {
  if (event.kind === kinds.Metadata) return getProfileContent(event)?.display_name ?? getProfileContent(event)?.name;
  return tagValue(event, "title") ?? tagValue(event, "name") ?? tagValue(event, "summary") ?? tagValue(event, "alt");
}

function eventSummary(event: NostrEvent): string | undefined {
  return tagValue(event, "summary") ?? tagValue(event, "description") ?? tagValue(event, "alt");
}

function eventImage(event: NostrEvent): string | undefined {
  if (event.kind === kinds.Metadata) return getProfileContent(event)?.picture;
  return tagValue(event, "image") ?? tagValue(event, "thumb") ?? tagValue(event, "thumbnail");
}

function shortId(id: string): string {
  return `${id.slice(0, 8)}…${id.slice(-6)}`;
}

function formatTime(timestamp: number): string {
  if (!timestamp) return "Unknown time";
  return new Date(timestamp * 1000).toLocaleString();
}

function pointerFromMention(encoded: string): NostrPointer | null {
  const value = encoded.replace(/^nostr:/, "");
  return decodeEventPointer(value) ?? decodeAddressPointer(value);
}

function externalNostrUrl(encoded: string): string {
  return `https://njump.me/${encoded.replace(/^nostr:/, "")}`;
}

const embeddedContentComponents: ComponentMap = {
  text: ({ node }) => <span>{node.value}</span>,
  link: ({ node }) => (
    <a href={node.href} target="_blank" rel="noreferrer" className={LINK_CLASS}>
      {node.value}
    </a>
  ),
  mention: ({ node }) => {
    const pubkey = getPubkeyFromDecodeResult(node.decoded);
    if (pubkey) {
      return (
        <span className="text-primary bg-primary/15 rounded px-0.5 font-medium">
          @<UserName pubkey={pubkey} />
        </span>
      );
    }
    return (
      <a href={externalNostrUrl(node.encoded)} target="_blank" rel="noreferrer" className={LINK_CLASS}>
        {node.encoded}
      </a>
    );
  },
  hashtag: ({ node }) => <span className="text-info">#{node.name}</span>,
  emoji: ({ node }) => <img className="h-[1.35em] w-auto align-middle object-contain" src={node.url} alt={node.raw} title={node.code} loading="lazy" />,
};

function EmbeddedEventContent({ event }: { event: NostrEvent }) {
  return <>{useRenderedContent(event, embeddedContentComponents, { maxLength: 360, cacheKey: null })}</>;
}

function EventMeta({ event, label }: { event: NostrEvent; label?: string }) {
  return (
    <div className="flex items-center gap-2 min-w-0 text-xs text-base-content/60">
      <UserAvatar pubkey={event.pubkey} className="w-5 h-5" />
      <span className="font-medium text-base-content truncate">
        <UserName pubkey={event.pubkey} />
      </span>
      <span className="shrink-0">·</span>
      <span className="shrink-0">{label ?? `kind ${event.kind}`}</span>
      <span className="shrink-0">·</span>
      <span className="truncate">{formatTime(event.created_at)}</span>
    </div>
  );
}

function ProfileEmbed({ event, encoded }: { event: NostrEvent; encoded: string }) {
  const profile = getProfileContent(event);
  const name = profile?.display_name || profile?.name || shortNpub(event.pubkey);
  return (
    <EmbedShell encoded={encoded}>
      <div className="flex items-start gap-3">
        <UserAvatar pubkey={event.pubkey} className="w-10 h-10" />
        <div className="min-w-0 flex-1">
          <div className="font-semibold truncate">{name}</div>
          <div className="text-xs text-base-content/60 font-mono truncate">{shortNpub(event.pubkey)}</div>
          {profile?.about && <div className="mt-1 text-sm line-clamp-3 whitespace-pre-wrap break-words">{profile.about}</div>}
        </div>
      </div>
    </EmbedShell>
  );
}

function TextEventEmbed({ event, encoded, label }: { event: NostrEvent; encoded: string; label?: string }) {
  return (
    <EmbedShell encoded={encoded}>
      <EventMeta event={event} label={label} />
      <div className="mt-2 text-sm whitespace-pre-wrap break-words">
        <EmbeddedEventContent event={event} />
      </div>
    </EmbedShell>
  );
}

function ArticleEmbed({ event, encoded }: { event: NostrEvent; encoded: string }) {
  const title = eventTitle(event) ?? "Long-form article";
  const summary = eventSummary(event);
  const image = eventImage(event);
  return (
    <EmbedShell encoded={encoded}>
      <EventMeta event={event} label="article" />
      <div className="mt-2 flex gap-3">
        {image && <img src={image} alt="" className="h-16 w-16 rounded object-cover bg-base-300 shrink-0" loading="lazy" />}
        <div className="min-w-0 flex-1">
          <div className="font-semibold line-clamp-2">{title}</div>
          {summary ? (
            <div className="mt-1 text-sm text-base-content/75 line-clamp-3 whitespace-pre-wrap break-words">{summary}</div>
          ) : (
            <div className="mt-1 text-sm text-base-content/75 line-clamp-3 whitespace-pre-wrap break-words">
              <EmbeddedEventContent event={event} />
            </div>
          )}
        </div>
      </div>
    </EmbedShell>
  );
}

function ShareEmbed({ event, encoded }: { event: NostrEvent; encoded: string }) {
  return (
    <EmbedShell encoded={encoded}>
      <EventMeta event={event} label={event.kind === kinds.Repost ? "repost" : "share"} />
      <div className="mt-2 text-sm text-base-content/75 whitespace-pre-wrap break-words">
        {event.content ? <EmbeddedEventContent event={event} /> : "Shared another Nostr event."}
      </div>
      <ReferencedTags event={event} />
    </EmbedShell>
  );
}

function ReactionEmbed({ event, encoded }: { event: NostrEvent; encoded: string }) {
  return (
    <EmbedShell encoded={encoded}>
      <EventMeta event={event} label="reaction" />
      <div className="mt-2 text-sm">
        Reacted with <span className="font-semibold">{event.content || "+"}</span>
      </div>
      <ReferencedTags event={event} />
    </EmbedShell>
  );
}

function LiveEventEmbed({ event, encoded }: { event: NostrEvent; encoded: string }) {
  const title = eventTitle(event) ?? "Live event";
  const summary = eventSummary(event);
  const image = eventImage(event);
  const status = tagValue(event, "status");
  return (
    <EmbedShell encoded={encoded}>
      <EventMeta event={event} label="live" />
      <div className="mt-2 flex gap-3">
        {image && <img src={image} alt="" className="h-16 w-16 rounded object-cover bg-base-300 shrink-0" loading="lazy" />}
        <div className="min-w-0 flex-1">
          <div className="font-semibold line-clamp-2">{title}</div>
          {status && <div className="mt-1 badge badge-sm badge-primary">{status}</div>}
          {summary && <div className="mt-1 text-sm text-base-content/75 line-clamp-3 whitespace-pre-wrap break-words">{summary}</div>}
        </div>
      </div>
    </EmbedShell>
  );
}

function ReferencedTags({ event }: { event: NostrEvent }) {
  const refs = event.tags.filter((tag) => (tag[0] === "e" || tag[0] === "a") && tag[1]).slice(0, 2);
  if (!refs.length) return null;
  return (
    <div className="mt-2 flex flex-wrap gap-1.5 text-xs text-base-content/60">
      {refs.map((tag, i) => (
        <span key={`${tag[0]}-${tag[1]}-${i}`} className="rounded bg-base-300 px-1.5 py-0.5 font-mono">
          {tag[0]}:{tag[1].length > 28 ? `${tag[1].slice(0, 18)}…${tag[1].slice(-8)}` : tag[1]}
        </span>
      ))}
    </div>
  );
}

function GenericEventEmbed({ event, encoded }: { event: NostrEvent; encoded: string }) {
  const title = eventTitle(event);
  const summary = eventSummary(event);
  const content = event.content.trim();
  return (
    <EmbedShell encoded={encoded}>
      <EventMeta event={event} />
      {title && <div className="mt-2 font-semibold line-clamp-2">{title}</div>}
      {(summary || content) && (
        <div className="mt-1 text-sm text-base-content/75 line-clamp-4 whitespace-pre-wrap break-words">
          {summary ?? content}
        </div>
      )}
      <div className="mt-2 text-xs text-base-content/50 font-mono">{shortId(event.id)}</div>
      <ReferencedTags event={event} />
    </EmbedShell>
  );
}

function EmbedShell({ encoded, children }: { encoded: string; children: React.ReactNode }) {
  return (
    <a
      href={externalNostrUrl(encoded)}
      target="_blank"
      rel="noreferrer"
      className="block mt-2 max-w-[min(520px,100%)] rounded-xl border border-base-300 bg-base-200/70 px-3 py-2.5 text-base-content no-underline hover:border-primary/50 hover:bg-base-200"
    >
      {children}
    </a>
  );
}

function LoadedEventEmbed({ event, encoded }: { event: NostrEvent; encoded: string }) {
  if (event.kind === kinds.Metadata) return <ProfileEmbed event={event} encoded={encoded} />;
  if (event.kind === kinds.ShortTextNote) return <TextEventEmbed event={event} encoded={encoded} label="note" />;
  if (event.kind === 1111) return <TextEventEmbed event={event} encoded={encoded} label="comment" />;
  if (event.kind === kinds.Repost || event.kind === kinds.GenericRepost) return <ShareEmbed event={event} encoded={encoded} />;
  if (event.kind === kinds.Reaction) return <ReactionEmbed event={event} encoded={encoded} />;
  if (event.kind === kinds.LongFormArticle) return <ArticleEmbed event={event} encoded={encoded} />;
  if (event.kind === kinds.LiveEvent) return <LiveEventEmbed event={event} encoded={encoded} />;
  return <GenericEventEmbed event={event} encoded={encoded} />;
}

function NostrEventEmbed({ pointer, encoded, depth = 0 }: { pointer: NostrPointer; encoded: string; depth?: number }) {
  const store = useEventStore();
  const event = use$(
    () => {
      if (depth > MAX_EMBED_DEPTH) return undefined;
      if (isEventPointer(pointer) || isAddressPointer(pointer)) return store.event(pointer);
      return undefined;
    },
    [store, pointer, depth],
  );

  if (depth > MAX_EMBED_DEPTH) {
    return (
      <a href={externalNostrUrl(encoded)} target="_blank" rel="noreferrer" className={LINK_CLASS}>
        {encoded}
      </a>
    );
  }
  if (!event) {
    return (
      <EmbedShell encoded={encoded}>
        <div className="flex items-center gap-2 text-sm text-base-content/60">
          <span className="loading loading-spinner loading-xs" />
          <span>Loading Nostr event…</span>
        </div>
      </EmbedShell>
    );
  }
  return <LoadedEventEmbed event={event} encoded={encoded} />;
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
      // NIP-19 mention. Profile pointers stay inline; event/address pointers
      // become linked event embeds with kind-specific previews.
      const pointer = pointerFromMention(node.encoded);
      if (pointer) {
        items.push({ node: <NostrEventEmbed key={i} pointer={pointer} encoded={node.encoded} /> });
      } else {
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
