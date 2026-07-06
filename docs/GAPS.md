# Concord client — implementation gaps & roadmap

Status snapshot and prioritized backlog of what our client (`src/concord/`) does **not**
yet implement against the frozen Concord spec (`refs/concord/`, CORD-01..06).

Context: the client is functional and verified end-to-end for the CORD-01..05 *steady
state* (create/join, chat, roles, invites over real relays). The gaps below are the
CORD-06 half plus lifecycle/hardening details.

**Reference implementation:** `refs/armada/client/src/concord-v2/` is an independent,
**wire-compatible** implementation of the same spec (verified: identical kinds, all 13
`concord/*` HKDF labels, `vector-community/v1/edition` label, invite `FRAGMENT_VERSION = 4`,
seal rules). It has already implemented most of what we're missing, so it's a working
reference for each gap. See `refs/armada/client/src/concord-v2/` paths cited below.

---

## Priority 1 — CORD-06: Rekeys & Refoundings

The single biggest gap and the current **interop ceiling**: an armada-initiated refounding
rolls `community_root`/epoch and republishes the control plane under a new root — which our
client would never pick up, making the community unreadable to us. Until this lands, "Ban"
is a cooperative silence (banlist + role-strip), not a cryptographic severance.

- **3303 rekey blobs** — build/parse per-recipient `{locator, wrapped}` (72-byte
  `scope_id||epoch_be||new_key` under the rotator↔recipient NIP-44 pairwise key), chunked
  at 120 recipients/event.
- **Rekey-address subscription** — precompute the *next* epoch's rekey pseudonyms
  (`concord/rekey-pseudonym`, `concord/base-rekey-pseudonym`, already labelled in `crypto.ts`)
  and subscribe so removed/retained members converge in real time. Continuity via `prevcommit`
  / `epoch_key_commitment` (already in `crypto.ts`).
- **Epoch bumping + key re-derivation** on rotation across control/channel/guestbook planes.
- **Refounding** — roll `community_root`, republish a *compacted* control plane under the new
  root, rekey affected private channels sealed under the prior root, seed the new guestbook
  with a snapshot (see P2). Resumable/idempotent; races converge to lexicographically-lowest key.
- **Single-channel rekey** for private-channel member removal / public↔private conversion.
- Wire `ban()` to compose banlist → grant-strip → refounding (see `client.ts` `ban()` NOTE).
- Reference: `refs/armada/client/src/concord-v2/lib/rekey.ts`.
- Files: new `src/concord/rekey.ts`; `client.ts` (subscription + `ban()`); `community.ts`.

## Priority 2 — Guestbook snapshot writing (3312)

We *read* kind 3312 snapshots but never *write* them. Needed to seed the guestbook on a
refounding (P1) and to bound cold-start scan cost.

- Chunk the memberlist at ≤400 members/event, refounder-signed.
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

- Implement the proper merge + 65,535-byte cap enforcement.
- Files: `src/concord/` community-list logic, `client.ts`.

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

Before/while closing gaps, prove real interop against the reference implementation:
run our two-user driver against armada's concord-v2 on a shared relay and confirm
join → chat → roles → invite round-trip. Extend `scripts/drive2.mjs` (or add
`scripts/drive-interop.mjs`) with one identity on each client. This both validates the
"wire-compatible" claim end-to-end and surfaces P3/P6 drift early.

Also keep `scripts/selftest.ts` (crypto interop assertions) green as each gap lands.
