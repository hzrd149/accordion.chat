# Concord package artifact

`applesauce-concord-1ceccb879d85.tgz` contains the standalone Concord source at
commit `1ceccb879d85` from `nostr://hzrd149.com/git.shakespeare.diy/applesauce-concord`.
The checked-in artifact makes installs independent of sibling checkouts and registry availability.

The archive contains the upstream MIT license, source, tests, Deno lockfile and
provenance. Only a Node package manifest and TypeScript-generated JavaScript/type
declarations are added. Shared SDK packages are peers to avoid duplicate stores,
casts, model registrations or crypto hooks. The app overrides core to 7.0.3 across
the dependency graph for the same reason.

To reproduce, install this repository's locked tools and run
`node scripts/vendor-concord.mjs /path/to/clean/applesauce-concord` at the exact
revision above. The script uses deterministic tar metadata. `pnpm test:concord`
runs the bundled upstream tests in a temporary directory using Deno, with its
bundled lockfile. Deno and access to the locked JSR/npm test dependencies are needed.
No sibling directory is needed for normal installation, builds or tests.
