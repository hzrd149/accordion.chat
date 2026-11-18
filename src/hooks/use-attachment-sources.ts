import { useEffect, useMemo, useRef, useState } from "react";
import { use$, useActiveAccount } from "applesauce-react/hooks";
import type { ConcordCommunity, ConcordMediaUnavailableReason } from "@applesauce/concord";
import type { MediaAttachment } from "@applesauce/concord/helpers";
import { createMediaURLScope } from "../services/concord-media";
import { MAX_ATTACHMENT_DOWNLOAD_BYTES } from "../helpers/media-policy";
import { attachmentIdentity } from "../helpers/attachment-identity";

export type AttachmentSource = { src: string } | { reason: ConcordMediaUnavailableReason };
type Scope = ReturnType<typeof createMediaURLScope>;

export function useAttachmentSources(community: ConcordCommunity | undefined, channelId: string | undefined, attachments: MediaAttachment[]) {
  const account = useActiveAccount();
  const pubkey = account?.pubkey;
  const channel = channelId ? community?.getChannel(channelId) : undefined;
  const metadata = use$(channel?.metadata$);
  const dissolved = use$(community?.dissolved$);
  const accessible = metadata?.accessible === true && !dissolved;
  const visibility = metadata?.visibility;
  const scopes = useRef(new Map<string, Scope>());
  const [results, setResults] = useState(new Map<string, {
    channel: typeof channel; account: string; visibility: typeof visibility;
    signal: AbortSignal; source: AttachmentSource;
  }>());

  // Boundary retirement is independent of list identity. Removing/replacing one
  // descriptor must not cancel its unchanged siblings or revoke their URLs.
  useEffect(() => {
    const current = scopes.current;
    const retire = () => {
      for (const scope of current.values()) scope.dispose();
      current.clear();
    };
    const sub = channel?.metadata$.subscribe((value) => {
      if (!value?.accessible || value.visibility !== visibility) retire();
    });
    const dissolvedSub = community?.dissolved$.subscribe((value) => { if (value) retire(); });
    return () => { sub?.unsubscribe(); dissolvedSub?.unsubscribe(); retire(); };
  }, [community, channel, pubkey, accessible, visibility]);

  useEffect(() => {
    if (!community || !channel || !pubkey || !accessible) return;
    const current = scopes.current;
    const wanted = new Set(attachments.map(attachmentIdentity));
    for (const [key, scope] of current) {
      if (!wanted.has(key)) {
        scope.dispose();
        current.delete(key);
      }
    }
    for (const attachment of attachments) {
      const key = attachmentIdentity(attachment);
      if (current.has(key)) continue;
      const scope = createMediaURLScope(pubkey, community.material.community_id, () => {
        setResults((previous) => {
          if (!previous.has(key)) return previous;
          const next = new Map(previous);
          next.delete(key);
          return next;
        });
      });
      current.set(key, scope);
      const publish = (source: AttachmentSource) => {
        if (scope.signal.aborted) return;
        setResults((previous) => new Map(previous).set(key, {
          channel, account: pubkey, visibility, signal: scope.signal, source,
        }));
      };
      void channel.media.load(attachment, { signal: scope.signal, maxBytes: MAX_ATTACHMENT_DOWNLOAD_BYTES }).then((value) => {
        if (scope.signal.aborted) return;
        if (value.status === "ready") {
          const src = scope.create(value.blob);
          if (src) publish({ src });
        } else publish({ reason: value.reason });
      }).catch(() => publish({ reason: "download-failed" }));
    }
  }, [community, channel, pubkey, attachments, accessible, visibility]);

  return useMemo(() => {
    const sources = new Map<MediaAttachment, AttachmentSource>();
    for (const attachment of attachments) {
      if (!accessible) {
        sources.set(attachment, { reason: "retired" });
        continue;
      }
      const result = results.get(attachmentIdentity(attachment));
      if (result && !result.signal.aborted && result.account === pubkey &&
        result.channel === channel && result.visibility === visibility) sources.set(attachment, result.source);
    }
    return sources;
  }, [attachments, results, accessible, pubkey, channel, visibility]);
}
