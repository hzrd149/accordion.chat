# Invite sync investigation and debug-tool repair handoff

Date: 2026-11-18

## Summary

Accordion reports a restored community as `syncing` and does not display recent messages. A separate, confirmed bug in its debug history builder prevents inspection of legacy and read-only split-control epochs. Fix the debug builder first, then use it to investigate the original sync failure; do not assume the two failures share a cause.

This report changes no application behavior. No relay events were published during the investigation. The full invite URL is intentionally omitted because its fragment grants access to private community content.

## User-observed state

The community is named **Soapbox Community**, owned by Alex Gleason. The expected latest general-channel message was:

- Text: `He says on Nostr`
- Timestamp verified by a read-only probe: `2026-11-18T16:12:03.647Z`
- Rumor ID: `85d73998734712fc645cab761a4f2bc0ec7de36bcc021b774584c1d20a7d6ff8`
- General channel ID: `b4853b67e720d3bbb96afad899648d8403139698bbf3c68826df2c8d1bca4e23`

The user's debug panel showed:

- Phase `syncing`, transport connected.
- Current root epoch 3; split control, read-only.
- Material revision 1.
- Community List seed epoch 0, listed current epoch 3, list state complete.
- Held generations displayed as epoch 1 and epoch 3, with gaps.
- Unknown refounders and missing retirement information in the display.
- Audit error: `control_pk must be canonical 32-byte hex`.

Configured community relays:

- `wss://relay.ditto.pub`
- `wss://relay.dreamith.to`
- `wss://relay.cyberguy.fyi`
- `wss://jskitty.com/nostr`
- `wss://asia.vectorapp.io/nostr`

The underlying saved material has not been collected. Do not infer missing or corrupt secrets from failed debug derivation or from the displayed gaps alone.

## Confirmed application bug: absent fields become present-but-undefined

### Relevant application code

`src/helpers/concord-history.ts`:

- `chainEntries()` copies optional control fields into intermediate records.
- `buildChain()` spreads current material and unconditionally assigns `control_pk: r.control_pk` and `control_root: r.control_root` to each synthesized generation.
- Its `held_roots` mapping also creates these fields unconditionally.

`src/components/dev/CommunityDebug.tsx`:

- `CommunityDebugPage` derives the generated chain in one `try` block.
- An early derivation failure stops later generations from being derived in that loop.
- The relay audit also uses the application-local `buildChain()`.

### Why this fails

Concord's `controlKeyFor()` deliberately distinguishes property absence from a supplied split-control coordinate:

```ts
if (!("control_pk" in material) && !("control_root" in material)) {
  // Historical legacy control derivation.
}
// Otherwise require a canonical control_pk.
// A present control_root must also be canonical and match control_pk.
```

The implementation inspected is in the sibling library at `src/helpers/crypto.ts`, around `controlKeyFor()` (lines 154–170 at investigation time).

Consequently:

- A legacy epoch must omit both split fields. `{ control_pk: undefined, control_root: undefined }` is not equivalent.
- A read-only split epoch must supply its valid `control_pk` and omit `control_root`. Adding `control_root: undefined` incorrectly selects staff-root validation.
- Unconditionally spreading current material can leak a current split field into a historical generation unless it is stripped before rebuilding.

This construction bug is confirmed by source inspection. The exact values and property presence in the user's saved material remain unverified.

### Suggested repair scope

1. Strip current epoch-specific optional fields from the shared spread base before constructing historical generations.
2. Add each historical generation's optional control fields only when actually defined.
3. Preserve absence in synthesized `held_roots` records as well.
4. Review `refounder` and `prev_root` handling for the same historical-field leakage problem.
5. Keep strict library validation: do not weaken it to accept malformed supplied split fields.
6. Consider reporting a per-generation derivation error rather than allowing one failed historical generation to hide every later generation.

Do not blindly substitute the library's internal chain builder: Accordion uses public entrypoints, and an audit's inventory of held roots need not have identical selection semantics to the authoritative sync walk.

### Regression tests and acceptance criteria

Add application helper tests following the existing test layout:

- Legacy material with no split fields remains free of those properties after `buildChain()`.
- A legacy held epoch followed by a read-only split current epoch derives successfully.
- Read-only split generations retain their valid `control_pk` and omit `control_root`.
- Staff generations preserve their matching control pair.
- Historical generations do not inherit a later epoch's control root, control address, predecessor, or refounder.
- Generated held-root entries preserve optional-field absence.
- Explicit malformed non-undefined split values still fail strict derivation.
- Exercise held epochs 1 and 3 without treating the gap itself as proof of corruption.

Assert property presence (`"control_root" in value`), not just equality to `undefined`.

## Evidence about the original sync failure

### Successful read-only probes

Using the supplied invite, the local `applesauce-concord` checkout:

1. Resolved a valid epoch-3 invite bundle with no private-channel keys.
2. Ran `syncEpochs()` from that fresh epoch-3 material and decoded the expected message.
3. Ran the full `ConcordCommunity.start()` with in-memory storage and relay publishing intercepted, and retained the expected message in the general channel store.
4. Reached phase `live`; one full startup took approximately 90 seconds.

The full-community probe confirmed target presence immediately after `start()` and again after short waits. An earlier diagnostic incorrectly searched channel handles using `.name`; that probe's “general missing” error was an inspection mistake, not evidence of missing channels.

The library E2E suite also completed successfully:

```text
deno task test:e2e
96 passed (535 steps), 0 failed
11m24s
```

These results apply to the local library working tree, which already contained unrelated uncommitted relay-migration and status changes. They do not establish that Accordion's installed package or running browser bundle is identical.

### User logs differ from the successful probes

The browser logs are from **Accordion**, not Armada. Several restored communities start concurrently through a shared relay pool. One community logs guestbook decode failures at epoch 1; correlate its community-ID prefix with the affected community before attributing those lines.

The excerpt shows:

- NIP-11 CORS failures on Ditto and Dreamith followed by request fallback.
- Successful Ditto WebSocket connection and completed backward history pagination.
- Dreamith connecting and then disconnecting.
- Negentropy operations starting on other relays.
- No final community-level core-plane, public-channel, or epoch-walk completion summary in the supplied excerpt.

NIP-11 CORS failures do not establish WebSocket failure. Individual guestbook drops do not establish failure to read channel messages.

In the local epoch-sync probe, Cyberguy failed in both core and channel history batches, but other relays supplied the target message.

## Next investigation after repairing debug tools

1. Obtain redacted saved material preserving field presence, epoch coordinates, fingerprints, and continuity metadata. Never request plaintext roots, staff secrets, or invite tokens in reports.
2. Compare Accordion's actual installed Concord and loader versions with the locally tested checkout, including patches and overrides.
3. Reproduce restored older history plus a read-only epoch-3 tip, not only a fresh invite with no held roots.
4. Match the browser setup: shared pool, multiple concurrent community starts, persistent rumor database adapter, and extension signer.
5. Isolate relay behavior: all healthy; one disconnected; one never completing a request; one stalled negentropy exchange; and successful fallback where supported.
6. Record per-relay completion/failure and each epoch's barrier progress. Distinguish a legitimately slow sync from an operation that never settles.
7. Check whether the target is absent from the channel store or only absent from the rendered projection. These are different bugs.
8. If the failure belongs to library sync or persistence, add the deterministic protocol reproduction upstream in `applesauce-concord`; keep application adapter/projection tests in Accordion.

A stalled relay holding the epoch barrier is a hypothesis, not a diagnosed root cause. Do not clear the user's local storage or replace their membership material as a diagnostic shortcut; doing so may destroy the reproduction.

## Verification for the eventual application fix

Follow `AGENTS.md`: run focused helper tests, `pnpm test`, `pnpm build`, and `pnpm lint`. Verify that the debug page derives legacy and read-only split generations without publishing anything. Keep the original sync failure open until the user's restored-state scenario is reproduced or explained.
