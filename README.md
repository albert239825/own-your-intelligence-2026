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

## Live X

1. `cd extension && npm run build`
2. Chrome → `chrome://extensions` → Developer mode → **Load unpacked** →
   select `extension/dist/`.
3. Browse to `https://x.com` logged in.

What to expect: matching posts collapse into an in-article placeholder naming
the rule that fired, with **Reveal** / **Keep this post** / **Correct filter**.
The popup toggle restores everything when off; editing rules re-evaluates all
mounted posts.

Selector status (`src/content/x-adapter.ts` header lists them all):

- **Verified** against logged-out "lite" DOM samples
  (`extension/fixtures/x-samples/lite-*.html`): `<article>` with
  `[data-engagement-action]`, `a[href*="/status/"]`, `div[dir="auto"]` text,
  nested `<article>` inside `[data-timeline-entry][role="link"]` for quotes.
- **Assumed** for the logged-in React app DOM (not verifiable from this
  machine): `article[data-testid="tweet"]`, `[data-testid="tweetText"]`,
  emoji as `img[alt]`, quoted tweet in `div[role="link"]`, timestamp link
  `a[href*="/status/"]:has(time)`, show-more
  `a[data-testid="tweet-text-show-more-link"]`, promoted =
  `[data-testid="placementTracking"]` wrapper (treated as a normal post).

Known limitations: no logged-in verification has been done yet; X reshuffles
markup frequently; media-only posts are never hidden (`complete=false` →
default show); a post flashes visible while classification is in flight;
quoted-tweet detection is a heuristic (nested article / `div[role="link"]`);
`twitter.com` URLs redirect to `x.com` and are matched by the same content
script.

### Manual smoke checklist (logged-in laptop)

1. Home timeline: at least one post collapses and the placeholder names a rule.
2. Scroll 50+ posts: no unrelated element is hidden; no `[af]` errors in
   console.
3. Reveal sticks when scrolling away and back.
4. Keep this post → the post survives a reload.
5. Popup toggle off → all placeholders gone; on → posts re-collapse.
6. Edit a rule → mounted posts re-evaluate.
7. A post detail page and a profile page show the same behaviour.
8. A promoted post is treated like any other post.
