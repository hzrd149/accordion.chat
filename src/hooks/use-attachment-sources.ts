import { useEffect, useState } from "react";
import { use$, useActiveAccount } from "applesauce-react/hooks";
import type { ConcordCommunity, ConcordMediaUnavailableReason } from "@applesauce/concord";
import type { MediaAttachment } from "@applesauce/concord/helpers";
import { createMediaURLScope } from "../services/concord-media";
import { MAX_ATTACHMENT_DOWNLOAD_BYTES } from "../helpers/media-policy";

export type AttachmentSource = { src: string } | { reason: ConcordMediaUnavailableReason };

export function useAttachmentSources(community: ConcordCommunity | undefined, channelId: string | undefined, attachments: MediaAttachment[]) {
  const account = useActiveAccount();
  const channel = channelId ? community?.getChannel(channelId) : undefined;
  const metadata = use$(channel?.metadata$);
  const dissolved = use$(community?.dissolved$);
  const accessible = metadata?.accessible === true && !dissolved;
  const visibility = metadata?.visibility;
  const [result, setResult] = useState<{ channel: typeof channel; account: string; signal: AbortSignal; visibility: typeof visibility; attachments: MediaAttachment[]; sources: Map<MediaAttachment, AttachmentSource> } | null>(null);
  useEffect(() => {
    if (!community || !channel || !account || !accessible || attachments.length === 0) return;
    const scope = createMediaURLScope(account.pubkey, community.material.community_id, () => setResult(null));
    const sub = channel.metadata$.subscribe((value) => {
      if (!value?.accessible || value.visibility !== visibility) scope.dispose();
    });
    const dissolvedSub = community.dissolved$.subscribe((value) => { if (value) scope.dispose(); });
    const sources = new Map<MediaAttachment, AttachmentSource>();
    for (const attachment of attachments) {
      void channel.media.load(attachment, { signal: scope.signal, maxBytes: MAX_ATTACHMENT_DOWNLOAD_BYTES }).then((value) => {
        if (scope.signal.aborted) return;
        if (value.status === "ready") {
          const src = scope.create(value.blob);
          if (src) sources.set(attachment, { src });
        } else sources.set(attachment, { reason: value.reason });
        setResult({ channel, account: account.pubkey, signal: scope.signal, visibility, attachments, sources: new Map(sources) });
      }).catch(() => {
        if (scope.signal.aborted) return;
        sources.set(attachment, { reason: "download-failed" });
        setResult({ channel, account: account.pubkey, signal: scope.signal, visibility, attachments, sources: new Map(sources) });
      });
    }
    return () => { sub.unsubscribe(); dissolvedSub.unsubscribe(); scope.dispose(); };
  }, [community, channel, account, attachments, accessible, visibility]);
  if (!accessible) return new Map(attachments.map((attachment) => [attachment, { reason: "retired" } as AttachmentSource]));
  return result && !result.signal.aborted && result.account === account?.pubkey && result.visibility === visibility &&
    result.channel === channel && result.attachments === attachments ? result.sources : new Map<MediaAttachment, AttachmentSource>();
}
