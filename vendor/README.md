# vendor/: Warp's code, unmodified

These are Warp's files, copied byte for byte from upstream at the commit pinned
in `sources.json`:

| folder | upstream | licence |
|---|---|---|
| `cloud-factory/` | [warpdotdev-demos/cloud-factory-demo](https://github.com/warpdotdev-demos/cloud-factory-demo) | MIT © 2026 Warp (`cloud-factory/LICENSE`) |
| `common-skills/` | [warpdotdev/common-skills](https://github.com/warpdotdev/common-skills) | MIT © 2026 Denver Technologies, Inc. (`common-skills/LICENSE`) |

**Never edit a file in here.** Put the change in `patches/` as a diff instead.
`node bin/vendor.test.mjs` fails on a single edited byte.

- `node bin/vendor.mjs sync`: re-fetch upstream. Change the commit in
  `sources.json` first to upgrade.
- `node bin/vendor.mjs check`: prove the copy is unmodified and every patch
  still applies. Works offline.
- `node bin/vendor.mjs build <dir>`: the installed layout (`.agents/skills/`,
  `.github/workflows/`), with the patches applied.
