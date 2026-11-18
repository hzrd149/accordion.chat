# Accordion integration report for Applesauce Concord

Reviewed Accordion at `bad493d` against the installed JSR `@applesauce/concord@0.1.0` (revision 11) and the pinned Applesauce 7.x dependency graph. The findings come from comparing the application call sites with the installed SDK implementation and public declarations. The proposed checks below are acceptance criteria for upstream changes.

## 1. Share invite resolution between preview and join

Accordion resolves links before joining so it can display the community name, icon and expiry. The preview fetches kind 33301, selects an event and decrypts the bundle with SDK helpers. Joining calls `client.joinByLink()`, which performs its own resolution. The two paths differ in relay selection, user AUTH, inbound coordinate checks and tie-breaking. The preview can show a different result from join, including whether a link appears to exist or be revoked. [App preview](../src/hooks/use-invite-preview.ts#L37), [join flow](../src/components/modals.tsx#L318)

**Upstream request.** Export a read-only invite resolver and use it inside `joinByLink()`. Share bootstrap and transport rules, authorization, coordinate validation, winner selection, revocation and bundle validation. Let callers inspect expiry without creating a membership. Verify that preview and join agree on the selected edition across multiple relays, including ties, revoked links and AUTH-gated relays.

## 2. Preserve SDK edit semantics when adding custom emoji

Accordion routes every ordinary chat edit through `EditFactory` and `sendEvent()` to attach NIP-30 emoji tags. That path skips the retained-target lookup in `editMessage()`, so the edit lacks the known target's `k` tag and its inherited `expiration` tag even when the target is loaded. The custom-emoji thread reply also switches from `replyToThread()` to a factory, while plain replies already use the SDK. [App actions](../src/chat/actions.ts), [edit call site](../src/views/App.tsx#L1510)

**Upstream request.** Accept optional emoji definitions in both edit and thread reply methods on community and channel handles. Keep the existing target lookup, binding and expiry behavior. Verify that editing a retained expiring message with or without emoji preserves its kind and expiry, and that custom-emoji replies retain the same NIP-22 root and parent as plain replies.

## 3. Build and update pins by message ID

The SDK verifies pin proofs and accepts replacement lists. To pin a loaded message, Accordion re-derives plane keys, searches the signed-event cache by channel author, opens candidate envelopes and constructs a proof from the original seal. A message in the rumor store can be visible while its envelope is unavailable to this lookup. Both pin and unpin also assemble replacement lists in the app and must remember to retain entries hidden by the ban filter. Two updates based on the same list can overwrite each other. [Pin proof lookup](../src/helpers/pins.ts), [unpin handler](../src/components/ChannelPins.tsx#L23)

**Upstream request.** Provide `pinMessage(id)` and `unpinMessage(id)` on the channel handle or equivalent methods. Resolve authenticated proof material through the SDK's history and return a typed result when the original seal is unavailable. Preserve filtered entries and define how conflicting updates are handled. Verify pinning on a warm timeline and after reload with historical keys, preservation of banned-author pins, and the outcome of overlapping updates.

## 4. Provide a Direct Invite send API with delivery results

Accordion builds the invite bundle, wraps it, discovers inbox relays, publishes directly and collects relay verdicts to power the send dialog. Concord has a public factory and a permission-gated `grantChannelAccess()` operation for granting private channels, but the latter has different semantics from a general invitation and reports publish problems through diagnostics. The app sender also uses different routing. The SDK grant path tries kind 10050, then NIP-65 read relays, then stock relays, and adds the community transport targets. The app helper adds `material.relays` to its inbox lookup and errors if the union is empty. [App sender](../src/helpers/direct-invites.ts), [send dialog](../src/components/DirectInviteModal.tsx#L100), [SDK grant call site](../src/views/community-settings.tsx#L854)

**Upstream request.** Expose ordinary Direct Invite sending with explicit channel selection, stage progress and per-relay outcomes. Reuse the SDK's delivery routing and authentication where appropriate. Verify inbox fallback, custom transport relays, partial acceptance, and selection of only the requested held private-channel keys.

## 5. Expose operation-scoped progress and publish outcomes

The create dialog discovers the new engine by matching its owner and name against additions to `communities$`. The join dialog observes membership and correlates account-wide signer calls by sequence and event kind. Both approaches can attribute unrelated concurrent work to the active operation. Separately, ordinary optimistic plane sends resolve after local echo and report relay rejection via background diagnostics. Accordion displays those failures, but the original send action has no acknowledgement result to await or associate with a specific message. [Create progress](../src/components/modals.tsx#L162), [join progress](../src/components/modals.tsx#L318), [diagnostics](../src/components/ConcordDiagnostics.tsx)

**Upstream request.** Expose operation-scoped milestones for create and join, including signer waits, local persistence and publication. For optimistic writes, expose a per-operation result that distinguishes local acceptance from relay delivery and gives callers sufficient information to associate late failure with the write. Verify overlapping operations, delayed signer approval and a send whose local echo succeeds while all relay publishes fail.

## 6. Offer a reusable voice presence model

Concord derives the voice keys and handles ephemeral channel ingest and publication. Accordion still parses and folds presence, runs heartbeats and expiry, and injects its own presence into the local roster because the SDK skips ephemeral local echo. The local fold uses the app's clock after send resolves. The subscription reads a raw channel store, which the SDK documents as including banned authors. [Voice engine](../src/voice/engine.ts), [presence helpers](../src/voice/presence.ts)

**Upstream request.** Consider a CORD-07 presence model with channel-scoped parsing, ordering, staleness, ban visibility and local reflection of the bound event. Keep broker selection and media integration configurable at the application layer. Verify immediate local presence without a relay echo, local/remote ordering parity, expiry and shared public-channel store scoping.

## Additional integration feedback

- **Reaction and thread projections.** Accordion uses SDK-resolved messages but groups replies and reactions from rumor tags, including an app-side author-delete check for reactions. It casts unsigned rumors to `NostrEvent` to call the Applesauce comment and reaction helpers. Ask Applesauce to accept rumor-compatible input in tag-only parsers, and consider a reusable reaction projection in Concord if other clients duplicate the same logic. Accordion's grouping, read markers and mention UI are presentation concerns. [Projection](../src/chat/projection.ts), [fold](../src/chat/fold.ts)
- **Developer diagnostics.** The epoch inspector reconstructs held roots and performs its own relay fetches and control/member folds with SDK helpers. That is an independent diagnostic path. If upstream wants to support this use case, expose read-only engine diagnostics for held epochs, per-relay coverage and rotation decisions, so the tool can compare its reconstruction with the live engine. [Epoch inspector](../src/helpers/concord-history.ts), [debug components](../src/components/dev)
- **Direct Invite receive cache.** The app injects device-encrypted storage through the supported `giftWrapReceiverOptions.decryptionCache` to avoid repeat signer prompts after reload. This is an adapter. Document the cold-start cost and the cache option for remote signers. The configured uploader, database and draft factories, encrypted membership storage, and purge scheduler are also supported integration points. [Provider](../src/components/ConcordProvider.tsx), [storage](../src/services/concord-storage.ts)
- **Private-channel guard.** The UI checks `hasChannelKey()` before offering writes or invites. The installed SDK already skips keyless private-channel derivation and rejects writes through `requireChannelKey()`. The debug warning about a possible fallback describes a condition to monitor. It is not evidence of a current SDK defect. [Composer and debug UI](../src/views/App.tsx#L1032)
- **Signature verification.** Accordion uses Applesauce's public verification hooks. The installed Concord JS and TS already call `verifyWrappedEvent()` when opening seals. The note in `AGENTS.md` describing a local gift-wrap patch is stale for this installation. The manifest, lockfile and workspace config declare a JSR package and version overrides with no patch, fork, vendored Concord or postinstall rewrite. Imports in `src/` use the package's public entrypoints. [Verification setup](../src/crypto-wasm.ts), [package manifest](../package.json), [workspace config](../pnpm-workspace.yaml)
- **Historical references.** `docs/GAPS.md` describes the removed in-app protocol engine. Its CORD backlog and interop results are historical. NIP-17 DMs now use `applesauce-extra/messages` and sit outside this Concord report. [Historical gaps](GAPS.md), [DM service](../src/services/messages.ts)

## Verification

All 65 app tests passed. Type-check, production build and lint passed. The build emitted its chunk-size warning. `pnpm store status` reported that the cached packages were untouched. The JSR tarball endpoint returned HTTP 403 during an independent download attempt, so the package comparison is based on the local install and pnpm metadata. This was a source review. Relay behavior, browser reloads and upstream regression scenarios were not exercised live.
