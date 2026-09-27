import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DEFAULT_POLICY, type PostSnapshot } from "../contracts";
import { evaluate } from "../policy/evaluate";
import { MockClassifier } from "./classifier";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const html = readFileSync(join(root, "fixtures/feed.html"), "utf8");
const expected = JSON.parse(
  readFileSync(join(root, "fixtures/expected.json"), "utf8"),
) as Record<string, string>;

// Extract posts without a DOM: articles carry data-post-id, a single-line
// .post-text paragraph, and an optional single-line .quote-text div.
interface FixturePost { postId: string; text: string; quoteText?: string }

function parseFixture(): FixturePost[] {
  const posts: FixturePost[] = [];
  const articleRe = /<article data-post-id="([^"]+)">([\s\S]*?)<\/article>/g;
  let m;
  while ((m = articleRe.exec(html))) {
    const postId = m[1]!;
    const body = m[2]!;
    const text = body.match(/<p class="post-text">([^<]+)<\/p>/)?.[1]?.trim();
    const quoteText = body.match(/<div class="quote-text">([^<]+)<\/div>/)?.[1]?.trim();
    if (text) posts.push({ postId, text, quoteText });
  }
  return posts;
}

const classifier = new MockClassifier();
const posts = parseFixture();

describe("fixture feed", () => {
  it("parses ~24 posts and every one has an expected disposition", () => {
    expect(posts.length).toBeGreaterThanOrEqual(24);
    for (const p of posts) expect(expected[p.postId]).toBeDefined();
  });

  for (const p of posts) {
    it(`classifies ${p.postId} -> ${expected[p.postId]}`, async () => {
      const snapshot: PostSnapshot = {
        platform: "x",
        postId: p.postId,
        contentHash: `hash-${p.postId}`,
        text: p.text,
        quoteText: p.quoteText,
        complete: true,
        extractorVersion: "x-0.1",
      };
      const probs = await classifier.classify(snapshot, DEFAULT_POLICY);
      const ev = evaluate({
        post: snapshot,
        policy: DEFAULT_POLICY,
        probabilities: probs,
        enabled: true,
      });
      expect(ev.disposition).toBe(expected[p.postId]);
    });
  }
});
