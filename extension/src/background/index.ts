import {
  BroadcastSchema,
  COMPILER_VERSION,
  DEFAULT_POLICY,
  DecisionResultSchema,
  MessageSchema,
  PolicySchema,
  type DecisionResult,
  type Feedback,
  type HistoryEntry,
  type Message,
  type Override,
  type Policy,
  type PostSnapshot,
  type TestClassifyResult,
  EXTRACTOR_VERSION,
} from "../contracts";
import { evaluate } from "../policy/evaluate";
import { KevClassifier, MockClassifier } from "./classifier";
import { appendCapped, withStore } from "./store";

const HISTORY_LIMIT = 300;
const MAX_IN_FLIGHT = 8;

interface Settings {
  endpoint: string;
  token: string;
  classifier: "mock" | "kev";
}

const DEFAULT_SETTINGS: Settings = {
  endpoint: "",
  token: "",
  classifier: "mock",
};

// ---- storage helpers ----------------------------------------------------

async function storeGet<T>(key: string): Promise<T | undefined> {
  const out = await chrome.storage.local.get(key);
  return out[key] as T | undefined;
}
async function storeSet(values: Record<string, unknown>): Promise<void> {
  await chrome.storage.local.set(values);
}

async function getPolicy(): Promise<Policy> {
  return withStore(async () => {
    const raw = await storeGet<unknown>("policy");
    const parsed = PolicySchema.safeParse(raw);
    if (parsed.success) return parsed.data;
    await storeSet({ policy: DEFAULT_POLICY });
    return DEFAULT_POLICY;
  });
}
async function getEnabled(): Promise<boolean> {
  return (await storeGet<boolean>("enabled")) ?? true;
}
async function getOverrides(): Promise<Record<string, Override>> {
  return (await storeGet<Record<string, Override>>("overrides")) ?? {};
}
async function getSettings(): Promise<Settings> {
  return { ...DEFAULT_SETTINGS, ...(await storeGet<Partial<Settings>>("settings")) };
}
async function getHistory(): Promise<HistoryEntry[]> {
  return (await storeGet<HistoryEntry[]>("history")) ?? [];
}
async function pushHistory(result: DecisionResult, post: PostSnapshot): Promise<void> {
  const entry: HistoryEntry = {
    ...result,
    post: { text: post.text, quoteText: post.quoteText },
    at: Date.now(),
  };
  await withStore(async () => {
    const history = await getHistory();
    await storeSet({ history: appendCapped(history, entry, HISTORY_LIMIT) });
  });
}
async function appendFeedback(fb: Feedback): Promise<void> {
  await withStore(async () => {
    const list = (await storeGet<Feedback[]>("feedback")) ?? [];
    list.push(fb);
    await storeSet({ feedback: list });
  });
}

// ---- decision cache ------------------------------------------------------

const cache = new Map<string, DecisionResult>();
function cacheKey(contentHash: string, policyRevision: number, modelVersion: string) {
  return `${contentHash}|${policyRevision}|${modelVersion}|${COMPILER_VERSION}`;
}

// ---- classifier dispatch + in-flight cap ---------------------------------

const mock = new MockClassifier();
let inFlight = 0;
const waiters: (() => void)[] = [];
async function acquire() {
  if (inFlight >= MAX_IN_FLIGHT) await new Promise<void>((r) => waiters.push(r));
  inFlight++;
}
function release() {
  inFlight--;
  waiters.shift()?.();
}

function pickClassifier(settings: Settings) {
  return settings.classifier === "kev"
    ? new KevClassifier({ endpoint: settings.endpoint, token: settings.token })
    : mock;
}

async function classifyPost(request: {
  requestId: string;
  post: PostSnapshot;
  policyRevision: number;
}): Promise<DecisionResult> {
  const t0 = Date.now();
  const [policy, enabled, overrides, settings] = await Promise.all([
    getPolicy(),
    getEnabled(),
    getOverrides(),
    getSettings(),
  ]);
  const classifier = pickClassifier(settings);
  const key = cacheKey(request.post.contentHash, policy.revision, classifier.modelVersion);

  const override = overrides[request.post.postId];
  const overrideApplies = override !== undefined && override.contentHash === request.post.contentHash;

  const cached = cache.get(key);
  if (cached && !overrideApplies) {
    return { ...cached, requestId: request.requestId, source: "cache", elapsedMs: Date.now() - t0 };
  }

  let probabilities: Record<string, number> | null = null;
  let source: DecisionResult["source"] = "fallback";

  if (enabled && request.post.complete && !overrideApplies) {
    await acquire();
    try {
      probabilities = await classifier.classify(request.post, policy);
      source = "model";
    } catch (e) {
      console.warn("[af] classify failed, falling back to show", e);
      probabilities = null;
    } finally {
      release();
    }
  }

  const ev = evaluate({
    post: request.post,
    policy,
    probabilities,
    override,
    enabled,
  });

  const result: DecisionResult = {
    requestId: request.requestId,
    postId: request.post.postId,
    contentHash: request.post.contentHash,
    policyRevision: policy.revision,
    modelVersion: classifier.modelVersion,
    disposition: ev.disposition,
    causeRuleIds: ev.causeRuleIds,
    exceptionRuleIds: ev.exceptionRuleIds,
    probabilities: probabilities ?? {},
    source: ev.source === "override" ? "override" : source,
    elapsedMs: Date.now() - t0,
  };

  if (!overrideApplies) cache.set(key, result);
  await pushHistory(result, request.post);
  return result;
}

async function testClassify(text: string, quoteText?: string): Promise<TestClassifyResult> {
  const t0 = Date.now();
  const [policy, settings] = await Promise.all([getPolicy(), getSettings()]);
  const classifier = pickClassifier(settings);
  const normalized = `${text}\u0000${quoteText ?? ""}`.replace(/\s+/g, " ").trim();
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(normalized));
  const contentHash = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  const post: PostSnapshot = {
    platform: "x",
    postId: `test:${contentHash.slice(0, 12)}`,
    contentHash,
    text,
    quoteText: quoteText || undefined,
    complete: true,
    extractorVersion: EXTRACTOR_VERSION,
  };
  let probabilities: Record<string, number> | null = null;
  let error: string | undefined;
  try {
    probabilities = await classifier.classify(post, policy);
  } catch (e) {
    error = String(e);
  }
  const ev = evaluate({ post, policy, probabilities, enabled: true });
  return {
    disposition: ev.disposition,
    causeRuleIds: ev.causeRuleIds,
    exceptionRuleIds: ev.exceptionRuleIds,
    probabilities: probabilities ?? {},
    trace: ev.trace,
    modelVersion: classifier.modelVersion,
    classifier: settings.classifier,
    policyRevision: policy.revision,
    elapsedMs: Date.now() - t0,
    error,
  };
}

// ---- broadcast ------------------------------------------------------------

async function broadcast(msg: unknown) {
  const parsed = BroadcastSchema.parse(msg);
  const tabs = await chrome.tabs.query({});
  for (const tab of tabs) {
    if (tab.id !== undefined) {
      chrome.tabs.sendMessage(tab.id, parsed).catch(() => {});
    }
  }
}

// ---- message handler -------------------------------------------------------

chrome.runtime.onInstalled.addListener(() => {
  void getPolicy();
  void getEnabled().then(async (e) => {
    if (e === undefined) await storeSet({ enabled: true });
  });
});

chrome.runtime.onMessage.addListener((raw: unknown, _sender, sendResponse) => {
  const parsed = MessageSchema.safeParse(raw);
  if (!parsed.success) {
    sendResponse({ ok: false, error: parsed.error.message });
    return false;
  }
  const msg: Message = parsed.data;

  void (async () => {
    switch (msg.type) {
      case "CLASSIFY_POST": {
        const result = await classifyPost(msg.request);
        sendResponse({ ok: true, result: DecisionResultSchema.parse(result) });
        break;
      }
      case "GET_POLICY":
        sendResponse({ ok: true, policy: await getPolicy() });
        break;
      case "SAVE_POLICY":
        await storeSet({ policy: msg.policy });
        cache.clear();
        await broadcast({ type: "POLICY_CHANGED", revision: msg.policy.revision });
        sendResponse({ ok: true });
        break;
      case "SET_OVERRIDE": {
        await withStore(async () => {
          const overrides = await getOverrides();
          overrides[msg.override.postId] = msg.override;
          await storeSet({ overrides });
        });
        sendResponse({ ok: true });
        break;
      }
      case "SAVE_FEEDBACK":
        await appendFeedback(msg.feedback);
        sendResponse({ ok: true });
        break;
      case "DELETE_FEEDBACK":
        await withStore(async () => {
          const list = (await storeGet<Feedback[]>("feedback")) ?? [];
          await storeSet({ feedback: list.filter((f) => f.feedbackId !== msg.feedbackId) });
        });
        sendResponse({ ok: true });
        break;
      case "GET_HISTORY":
        sendResponse({ ok: true, history: await getHistory() });
        break;
      case "CLEAR_HISTORY":
        await storeSet({ history: [] });
        sendResponse({ ok: true });
        break;
      case "SET_ENABLED":
        await storeSet({ enabled: msg.enabled });
        await broadcast({ type: "ENABLED_CHANGED", enabled: msg.enabled });
        sendResponse({ ok: true });
        break;
      case "GET_ENABLED":
        sendResponse({ ok: true, enabled: await getEnabled() });
        break;
      case "TEST_CLASSIFY":
        sendResponse({ ok: true, result: await testClassify(msg.text, msg.quoteText) });
        break;
    }
  })().catch((e) => sendResponse({ ok: false, error: String(e) }));

  return true; // async sendResponse
});
