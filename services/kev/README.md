# services/kev

Placeholder. This directory will hold the Modal deployment for the Kev
classifier: `deploy.py` (pinned Kev SHA + checkpoint, `min_containers=1`),
plus the runbook for deploy / warm / verify / teardown. The extension calls
`POST {endpoint}/v1/systemone` with bearer auth and a question payload built
by `extension/src/policy/compile.ts`; see `docs/ARCHITECTURE.md` §3–§4 for the
contract this service must satisfy.
