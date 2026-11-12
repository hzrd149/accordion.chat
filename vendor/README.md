# Concord package artifact

`applesauce-concord-00ceaa38355d.tgz` contains the standalone Concord source at
commit `00ceaa38355d` from `nostr://hzrd149.com/git.shakespeare.diy/applesauce-concord`.
The checked-in artifact makes installs independent of sibling checkouts and registry availability.

The archive contains the upstream MIT license, source, tests, Deno lockfile and
provenance. Only a Node package manifest and TypeScript-generated JavaScript/type
declarations are added. Shared SDK packages are peers to avoid duplicate stores,
casts, model registrations or crypto hooks. The app uses one v7 SDK graph with
transitive overrides. This Concord revision explicitly disables timeline batching
where its authority folds require immediate updates, allowing core 7.1.3.

To reproduce, install this repository's locked tools and run
`node scripts/vendor-concord.mjs /path/to/clean/applesauce-concord` at the exact
revision above. The script uses deterministic tar metadata. Protocol tests belong
to the upstream project; Accordion runs its app adapter/projection tests with
`pnpm test`, plus `pnpm build` and `pnpm lint`.
No sibling directory is needed for normal installation, builds or tests.
