import { useState } from "react";
import { ShieldQuestion } from "lucide-react";
import { Modal } from "../../components/modals";
import type { ChannelMetadata, ConcordCommunity } from "@applesauce/concord";

export function PrivateChannelDebugModal({
  community,
  channel,
  channelId,
  myPubkey,
  canCreateInvite,
  canManageChannels,
  channelAccessible,
  canDirectInvite,
  canWrite,
  onClose,
}: {
  community: ConcordCommunity;
  channel: ChannelMetadata;
  channelId: string;
  myPubkey: string;
  canCreateInvite: boolean;
  canManageChannels: boolean;
  channelAccessible: boolean;
  canDirectInvite: boolean;
  canWrite: boolean;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);
  // `material.channels` is the single source of channel key material: the control
  // fold strips key/epoch/held from ChannelMetadata outright, so there is no longer
  // a "folded key" to compare against — the disagreement this modal used to hunt
  // for is structurally impossible now.
  const materialChannel = community.material.channels.find((c) => c.id === channelId);
  const isOwner = myPubkey === community.material.owner;
  const materialHasKey = Boolean(materialChannel?.key);
  const suspectedFallbackRisk = channel.private && !materialHasKey;
  const snapshot = {
    communityId: community.material.community_id,
    channelId,
    channelName: channel.name,
    channelPrivate: channel.private,
    channelDeleted: Boolean(channel.deleted),
    viewer: myPubkey,
    owner: community.material.owner,
    isOwner,
    permissions: {
      canCreateInvite,
      canManageChannels,
      appChannelAccessible: channelAccessible,
      canDirectInvite,
      canWrite,
    },
    materialChannel: materialChannel
      ? {
          id: materialChannel.id,
          name: materialChannel.name,
          hasKey: materialHasKey,
          epoch: materialChannel.epoch,
          heldEpochs: materialChannel.held?.map((h) => h.epoch) ?? [],
          keyPrefix: materialChannel.key ? `${materialChannel.key.slice(0, 8)}…` : null,
        }
      : null,
    suspectedFallbackRisk,
  };
  const json = JSON.stringify(snapshot, null, 2);

  async function copy() {
    await navigator.clipboard.writeText(json);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  }

  return (
    <Modal onClose={onClose}>
      <h2 className="text-xl font-bold mb-1">Private channel debug</h2>
      <p className="text-sm opacity-70 mb-4">
        Dev-only state for checking whether private channel metadata and held key material agree.
      </p>

      {suspectedFallbackRisk && (
        <div className="alert alert-warning text-sm mb-4 items-start">
          <ShieldQuestion size={18} className="mt-0.5" />
          <span>
            This private channel is folded without local key material. If sending still works, the upstream package may be
            deriving a fallback community-root channel key for a private channel.
          </span>
        </div>
      )}

      <div className="rounded-box border border-base-300 overflow-hidden mb-4">
        <DebugRow label="Viewer is owner" value={isOwner ? "yes" : "no"} good={isOwner} />
        <DebugRow label="Can manage channels" value={canManageChannels ? "yes" : "no"} good={canManageChannels} />
        <DebugRow label="Can create invites" value={canCreateInvite ? "yes" : "no"} good={canCreateInvite} />
        <DebugRow label="Material has channel key" value={materialHasKey ? "yes" : "no"} good={materialHasKey} />
        <DebugRow label="App accessibility gate" value={channelAccessible ? "yes" : "no"} good={channelAccessible} />
        <DebugRow label="App composer can write" value={canWrite ? "yes" : "no"} good={!suspectedFallbackRisk || !canWrite} />
        <DebugRow label="Direct invite enabled" value={canDirectInvite ? "yes" : "no"} good={!suspectedFallbackRisk || !canDirectInvite} />
      </div>

      <div className="flex items-center gap-2 mb-2">
        <h3 className="font-semibold">Snapshot</h3>
        <button className="btn btn-xs ml-auto" onClick={() => void copy()}>
          {copied ? "Copied" : "Copy JSON"}
        </button>
      </div>
      <pre className="text-xs bg-base-200 border border-base-300 rounded-box p-3 overflow-auto max-h-72">{json}</pre>

      <div className="modal-action">
        <button className="btn btn-primary" onClick={onClose}>
          Close
        </button>
      </div>
    </Modal>
  );
}

function DebugRow({ label, value, good }: { label: string; value: string; good: boolean }) {
  return (
    <div className="flex items-center gap-3 px-3 py-2 border-b border-base-300 last:border-b-0 text-sm">
      <span className="flex-1 opacity-70">{label}</span>
      <span className={`badge ${good ? "badge-success" : "badge-warning"}`}>{value}</span>
    </div>
  );
}
