import {
  type DecisionResult,
  type Feedback,
  type Policy,
} from "../contracts";
import { ensureStyle, fixtureAdapter } from "./adapter";
import { xAdapter } from "./x-adapter";
import { createController } from "./controller";

const isX = /(^|\.)x\.com$|(^|\.)twitter\.com$/.test(location.hostname);
const adapter = isX ? xAdapter : fixtureAdapter;

function send<T>(msg: unknown): Promise<T | undefined> {
  return chrome.runtime.sendMessage(msg).then((r) => (r?.ok ? r : undefined));
}

const controller = createController({
  adapter,
  classify: async (snapshot, policyRevision) => {
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
  onKeep: (snapshot) => {
    void send({
      type: "SET_OVERRIDE",
      override: {
        postId: snapshot.postId,
        contentHash: snapshot.contentHash,
        action: "keep",
        createdAt: Date.now(),
      },
    });
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
});

chrome.runtime.onMessage.addListener((raw: unknown) => {
  controller.handleBroadcast(raw);
});

ensureStyle();
void controller.start();
