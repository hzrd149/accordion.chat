# Concord client — implementation gaps & roadmap

Status snapshot and prioritized backlog of what our client (`src/concord/`) does **not**
yet implement against the frozen Concord spec (`refs/concord/`, CORD-01..06).

Context: the client is functional and verified end-to-end for the CORD-01..05 *steady
state* (create/join, chat, roles, invites over real relays). **Wire interop with armada is now
proven for all of CORD-01..06** — `scripts/interop.ts` executes both codebases against each other
(73 assertions, zero divergences): derivation parity, chat, control fold (chain-intact), guestbook,
roles/grants/banlist, private channels, dissolution, invites, community-list, and the CORD-06
rekey/refounding codec — both directions. Remaining gaps are app-feature completeness, not wire
compatibility.

**Reference implementation:** `refs/armada/client/src/concord-v2/` is an independent,
**wire-compatible** implementation of the same spec (verified by execution, above). It has already
implemented most of what we're missing, so it's a working reference for each gap. See
`refs/armada/client/src/concord-v2/` paths cited below.

---

## Priority 1 — CORD-06: Rekeys & Refoundings

The former **interop ceiling**: an armada-initiated refounding rolls `community_root`/epoch and
republishes the control plane under a new root. **Reading one now works** — the wire codec is
implemented and cross-verified, and the client follows a refounding forward.

- **DONE — 3303 rekey codec** (`src/concord/rekey.ts`): build/parse per-recipient
  `{locator, wrapped}` (72-byte `scope_id||epoch_be||new_key` under the rotator↔recipient NIP-44
  pairwise key, standard-base64 transport), chunked at 120/event; rotation grouping, continuity
  via `epoch_key_commitment`, blob lookup, lowest-key race convergence. Cross-verified against
  armada **both directions** in `scripts/interop.ts` §J (11 assertions): refounding read + adopted,
  new root recovered exactly, excluded member severed, wrong-prior-root rejected as a fork.
- **DONE — rekey-address subscription + adopt/remove** (`client.ts`): the control sub now also
  watches the next epoch's `base-rekey-pseudonym`; a complete, authorized (owner/BAN),
  continuity-checked root rotation carrying our blob → adopt the new root (retain prior in
  `held_roots`, re-derive keys, re-open subs at the new epoch); a complete rotation with no blob
  for us → tombstone the membership. `JoinMaterial` gained `held_roots`/`refounder` (armada-compatible).
- **DONE — Refound WRITE path** (`client.ts` `refound(cid, {keep, exclude})`): publish the rekey
  blobs, **compact** the control plane by re-wrapping each entity's head plaintext seal into the
  new epoch (`stream.ts` `rewrapSeal`; `decodeStreamEvent` now retains the seal, `foldControl`
  exposes `state.heads`), seed the new Guestbook with a snapshot, then follow forward. Requires
  BAN/ownership + NIP-44. Compaction cross-verified in `interop.ts` §J (armada folds our re-wrapped
  head under the new root, original author preserved); snapshot in §F.
- **Still TODO (app-feature, not a wire gap):**
  - **Single-channel rekey** for private-channel member removal / public↔private conversion.
  - Wire `ban()` to compose banlist → grant-strip → `refound()`; surface a Refound action in the UI.
  - History across `held_roots`: `deriveKeys` currently derives only the current epoch; old-epoch
    wraps stay decodable via retained `planeMap` entries in-session but aren't re-fetched.
- Reference: `refs/armada/client/src/concord-v2/lib/rekey.ts`, `hooks/useRekey2.ts`.
- Files: `src/concord/rekey.ts`, `stream.ts`, `control.ts`, `guestbook.ts`, `client.ts` (all done).

## Priority 2 — Guestbook snapshot writing (3312) — DONE

`src/concord/guestbook.ts` `buildSnapshotRumors` chunks the memberlist at ≤400 members/event
(refounder-signed); `client.ts` `refound()` seeds the new epoch's Guestbook with it. Cross-verified
in `interop.ts` §F (our snapshot seeds armada's coalesce and vice-versa).

- Reference: `refs/armada/client/src/concord-v2/lib/guestbook.ts`.
- Files: `src/concord/guestbook.ts`, `client.ts`.

## Priority 3 — Full CORD-04 control fold

Our fold is a pragmatic owner-first fixpoint, not the full spec algorithm. Likely source of
**interop drift** (we may accept editions armada rejects, or vice-versa).

- Chain-intact verification (`prev` links), strict refuse-downgrade including
  across-refounding, and block-until-synced `vac` enforcement on receipt (`buildVac` exists
  but is not enforced).
- Enforce roster caps (100 roles, 64 roles/member), name byte-caps, banlist ~500 cap / re-heal.
- Reference: `refs/armada/client/src/concord-v2/lib/control.ts`, `roles.ts`.
- Files: `src/concord/control.ts`, `permissions.ts`.
- **Interop status (`scripts/interop.ts` §C2):** a *chained* v1→v2 metadata+channel update folds
  identically through our `foldControl` and armada's `foldControlState` (order-independent). The
  gap is characterized: on a **broken `prev`-chain** our fold takes the highest version while
  armada refuses the gap and holds v1 — our fold does not enforce chain contiguity. Low practical
  risk (a real peer never dangles `prev`), but a forged edition could suppress a legit head.

## Priority 4 — Invite lifecycle (13303 Invite List)

We mint links but **discard the per-link signer secret**, so links can't be refreshed or
revoked (`buildRevocationTemplate` is currently dead code). Also the Invite Registry (vsk 8)
is written but never folded into a Public/Private state.

- Persist link `signer_sk` in a self-encrypted Invite List (kind 13303), merge-by-token.
- Fold the invite registry into authoritative Public/Private community state + surface in UI.
- Reference: `refs/armada/client/src/concord-v2/lib/invite.ts`.
- Files: `src/concord/invite.ts`, `client.ts`, `src/app/modals.tsx`.

## Priority 5 — Stream-key NIP-42 AUTH

`src/concord/relay-auth.ts` authenticates only as the logged-in **user**. Armada additionally
authenticates **as each derived stream key**, which an AUTH-gating relay requires before it
will serve a kind-1059 REQ whose `authors` are stream pubkeys (the user's login can't satisfy
that filter). Needed for interop with AUTH-enforcing relays and as a privacy/anti-spam boundary.

- Maintain a registry of currently-held stream secret keys; on an AUTH challenge, sign an extra
  kind-22242 as each stream we will query, not just as the user.
- Reference: `refs/armada/client/src/concord-v2/lib/streamAuth.ts` + its `NostrProvider` wiring.
- Files: `src/concord/relay-auth.ts`, `client.ts`.

## Priority 6 — Community List (13302) merge correctness

`saveCommunityList` writes a simplified `seed=current` with empty tombstones — not the CORD-02
§8 seed(lowest-epoch)/current(highest-epoch)/tombstone merge, and no NIP-44 byte-cap check.
Risk: bad round-trip against armada's version.

- **DONE:** liveness now derived per CORD-02 §8 (`src/concord/community-list.ts`
  `isCommunityLive`) — the loader used to drop any tombstoned id outright, wrongly hiding a
  leave-then-rejoin and diverging from armada. Verified in `scripts/interop.ts` §E: our document
  round-trips through armada's `mergeCommunityLists`/`rehydrateCommunity`, and liveness agrees
  across join/leave/re-join.
- **DONE (write side):** `src/concord/community-list.ts` now has the full CORD-02 §8 merge
  (`mergeCommunityLists`/`addToList`/`removeFromList`/`refreshCurrent`, seed=lowest-epoch /
  current=highest-epoch) + `withinByteCap` (65,535-byte NIP-44 cap). The client keeps an
  authoritative merged document: load merges remote in (no clobber of other-device entries /
  tombstones), `leave()` tombstones the membership, save reconciles live runtimes + enforces the
  cap. Verified in `scripts/interop.ts` §E (join→leave→rejoin agrees with armada).
- Files: `src/concord/community-list.ts`, `client.ts`.

## Priority 7 — Media blobs (icon / banner)

Encrypted-blob pointers `{url,key,nonce,hash}` are typed but never fetched/decrypted/uploaded.

- Fetch + NIP-44-decrypt on read; encrypt + upload on write; wire icon/banner in metadata UI.
- Files: `src/lib/`, `src/concord/community.ts` or `editions.ts`, `src/app/modals.tsx`.

---

## Optional / larger scope

- **WebXDC (kind 3310)** peer signalling — kind is defined, no implementation. Reference:
  armada's webxdc runtime (`components/apps/WebxdcApp`, sync over 3310).
- **Voice** — not in the Concord spec. Armada's model worth studying: a **blind voice broker**
  authorized by *channel-key-possession proof* rather than a membership list
  (`refs/armada/server/concord_voice.go`, `/.well-known/concord/voice`), which preserves the
  "no server knows the roster" property. Would require a companion service.

---

## Cross-client interop test (do this first)

**Done at the library level** — `scripts/interop.ts` executes OUR `src/concord`
core and armada's `concord-v2` reference against each other in-memory (29 assertions,
all green). Because Concord is pure derived-address 1059 traffic, an in-memory
round-trip is the definitive wire-compat proof — a relay only moves the same bytes.
It covers, both directions where applicable:

- **derivation parity** — control/guestbook/channel stream addresses and conversation
  keys match byte-for-byte (the linchpin: else the two clients never meet on a relay);
- **chat plane** — our message opens in armada and vice-versa, channel/epoch binding
  enforced, rumor ids stable;
- **control fold** — our owner-signed genesis editions fold under armada's *strict*
  CORD-04 fold to the same metadata + `#general` (early evidence **against** P3 drift,
  at least for the genesis case — the folder still needs the multi-edition / chain /
  refuse-downgrade cases exercised);
- **invites** — links, tokens, bootstrap relays, and encrypted bundles round-trip both
  ways; wrong token rejected.

Run: `node_modules/.bin/esbuild scripts/interop.ts --bundle --platform=node --format=cjs
--alias:@=$PWD/refs/armada/client/src --outfile=/tmp/interop.cjs && node /tmp/interop.cjs`

**Still worth doing:** (a) a *browser-level* two-client run (our app UI + armada's UI on
a shared relay) to catch subscription/auth/timing drift the in-memory test can't; (b)
extend `interop.ts` to fold **multi-edition** control sets (updates, `prev` chains,
refuse-downgrade) and the **13302 community-list merge** to surface P3/P6 drift directly.

Also keep `scripts/selftest.ts` (crypto interop assertions) green as each gap lands.
