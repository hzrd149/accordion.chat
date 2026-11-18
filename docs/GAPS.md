# Concord client roadmap

Open items from the Concord implementation backlog. Accordion uses
`@applesauce/concord` for the protocol core.

## Channel visibility conversion

Add a settings workflow for converting an existing channel between public and
private. Follow the key rotation, epoch and history access rules in
[CORD-03 §2](../refs/concord/03.md). Channel creation already supports either
visibility, and private-channel member removal already rotates the channel key.
[Community settings](../src/views/community-settings.tsx)

## Community visibility indicator

Show the community's Public or Private status from the folded Invite Registry
(`community.inviteLinks$`). Under [CORD-05 §5](../refs/concord/05.md), a nonempty
registry means Public and an empty registry means Private. The existing invite
dialog lists the current user's links and counts registered links from other
members. [Invite dialog](../src/components/modals.tsx)

## Browser interop verification

Run Accordion and Armada in separate browser sessions against shared relays.
Exercise invite join, bidirectional chat, and a refounding followed by continued
chat. Include a relay that requires stream-key AUTH to check live subscription
recovery and relay behavior. App tests run with `pnpm test`.

## Optional

- Add a WebXDC runtime for [kind 3310 peer signals](../refs/concord/examples.md#26-kind-3310--webxdc-peer-signal).
