# Attention Filter (own-your-intelligence-2026)

A Chrome MV3 extension that filters your X feed with rules you write in plain
language. Posts are classified per-rule; a deterministic evaluator turns the
per-rule probabilities into hide/show, and a placeholder shows the exact rule
that fired. Corrections (keep / wrong classification / change what I want) are
stored locally and change future decisions. Everything is local and exportable.
See `docs/ARCHITECTURE.md` for the full design.

## Layout

- `extension/` — the Chrome extension (single npm package, plain TS, no React)
- `extension/fixtures/feed.html` — deterministic ~24-post feed for dev + demo
- `services/kev/` — model-serving side (placeholder; see its README)
- `evals/` — quality/latency harnesses (placeholder; see its README)

## Develop

```sh
cd extension
npm install
npm run build      # esbuild -> dist/
npm test           # vitest
npx tsc --noEmit   # typecheck
```

## Load unpacked

1. `cd extension && npm run build`
2. Chrome → `chrome://extensions` → Developer mode → **Load unpacked** → select `extension/dist/`.
3. For the fixture feed, enable **Allow access to file URLs** on the extension
   card (the content script matches `file://*/fixtures/feed.html`).

## Run the fixture

Open `extension/dist/fixtures/feed.html` (or `extension/fixtures/feed.html`) in
the browser with the extension loaded and enabled. Bait posts collapse into
placeholders naming the rule that fired; critiques and announcements stay.
Use the toolbar popup to toggle the filter; the options page edits rules,
endpoint settings, history review, and export.

## Tests

`npm test` runs the evaluator unit tests, the policy→questions compiler test,
and a fixture-level test that parses `fixtures/feed.html` and asserts the
MockClassifier + evaluator produce the dispositions in `fixtures/expected.json`
(every bait hides, every critique shows).
