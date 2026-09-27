import {
  type DecisionResult,
  type Feedback,
  type Override,
  type Policy,
  type PostSnapshot,
} from "../contracts";
import { ensureStyle, fixtureAdapter } from "./adapter";
import { xAdapter } from "./x-adapter";
import { createController } from "./controller";

const isX = /(^|\.)x\.com$|(^|\.)twitter\.com$/.test(location.hostname);
const adapter = isX ? xAdapter : fixtureAdapter;

// Enable with `localStorage.afDebug = "1"` in the page console, then reload.
const debugOn = (() => {
  try {
    return localStorage.getItem("afDebug") === "1";
  } catch {
    return false;
  }
})();
const debug = (...a: unknown[]) => {
  if (debugOn) console.debug("[af]", ...a);
};

function send<T>(msg: unknown): Promise<T | undefined> {
  return chrome.runtime.sendMessage(msg).then((r) => {
    if (!r?.ok) debug("worker replied not-ok", (msg as { type?: string }).type, r);
    return r?.ok ? r : undefined;
  });
}

function setOverride(snapshot: PostSnapshot, action: Override["action"]): void {
  void send({
    type: "SET_OVERRIDE",
    override: {
      postId: snapshot.postId,
      contentHash: snapshot.contentHash,
      action,
      createdAt: Date.now(),
    },
  });
}

const controller = createController({
  adapter,
  classify: async (snapshot, policyRevision) => {
    debug("classify", snapshot.postId);
    const res = await send<{ result: DecisionResult }>({
      type: "CLASSIFY_POST",
      request: {
        requestId: crypto.randomUUID(),
        post: snapshot,
        policyRevision,
      },
    });
    if (!res?.result) throw new Error("no result from worker");
    return res.result;
  },
  getPolicy: () =>
    send<{ policy: Policy }>({ type: "GET_POLICY" }).then((r) => r?.policy),
  getEnabled: () =>
    send<{ enabled: boolean }>({ type: "GET_ENABLED" }).then((r) => r?.enabled),
  onKeep: (snapshot) => setOverride(snapshot, "keep"),
  onHide: (snapshot) => setOverride(snapshot, "hide"),
  onSavePolicy: (policy) => {
    void send({ type: "SAVE_POLICY", policy });
  },
  onCorrect: (fb) => {
    const feedback: Feedback = {
      ...fb,
      feedbackId: crypto.randomUUID(),
      createdAt: Date.now(),
    };
    void send({ type: "SAVE_FEEDBACK", feedback });
  },
  log: (...a) => console.warn("[af]", ...a),
  debug,
});
debug("content script loaded", { adapter: isX ? "x" : "fixture", href: location.href });

chrome.runtime.onMessage.addListener((raw: unknown) => {
  controller.handleBroadcast(raw);
});

ensureStyle();
void controller.start();
