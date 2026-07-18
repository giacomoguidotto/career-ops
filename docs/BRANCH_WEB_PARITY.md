# Branch-to-web parity evidence

Issue #55 closes the feature specified in #35 through the machine-checked ledger at
[`web/branch-parity-ledger.json`](../web/branch-parity-ledger.json). The ledger is
the canonical inventory. It records each implementation slice from #43 through
`#54`, its settled web treatment or no-UI rationale, automated checks, rendered
cases, and passing evidence names.

`npm test` in `web/` validates the ledger shape and every referenced check. The
`branch-parity-browser` CI job builds the production app, installs Chromium, and
runs the browser journeys against fictional workspaces. Those journeys generate
the four required render combinations for each referenced case, include reduced
motion, and assert the responsive, keyboard, compatibility, and safety boundaries.
On failure, CI uploads screenshots, traces, fixture manifests, and server output
from `web/.lifecycle-browser-artifacts/`.

The final acceptance commands are:

```bash
node test-all.mjs
(cd web && npm test && npm run typecheck && npm run build && npm run test:browser)
(cd dashboard && go test ./...)
```

Rendered files are test artifacts rather than repository assets. They contain
fictional data only and are regenerated for every CI run.
