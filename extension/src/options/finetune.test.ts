import { describe, expect, it } from "vitest";
import { DEFAULT_POLICY } from "../contracts";
import { buildExport, DEFAULT_SETTINGS, type Settings } from "./state";
import { getJob, isTerminal, jobStatusLine, startTraining, type TrainJob } from "./finetune";

const settings: Settings = {
  ...DEFAULT_SETTINGS,
  classifier: "kev",
  endpoint: "https://example.modal.run/",
  token: "tok",
};

function job(over: Partial<TrainJob>): TrainJob {
  return {
    id: "j1",
    status: "queued",
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    ...over,
  };
}

describe("jobStatusLine / isTerminal", () => {
  it("is terminal only for promoted/rejected/failed", () => {
    expect(isTerminal("training")).toBe(false);
    expect(isTerminal("promoted")).toBe(true);
    expect(isTerminal("rejected")).toBe(true);
    expect(isTerminal("failed")).toBe(true);
  });

  it("explains rejection with the gate reason and failure with the error", () => {
    expect(jobStatusLine(job({ status: "rejected", gate: { passed: false, reason: "recall dropped" } })))
      .toContain("recall dropped");
    expect(jobStatusLine(job({ status: "failed", error: "oom" }))).toContain("oom");
    expect(jobStatusLine(job({ status: "promoted" }))).toContain("serving");
  });
});

describe("startTraining", () => {
  const bundle = buildExport(DEFAULT_POLICY, [], {}, []);

  it("posts the bundle to {endpoint}/v1/train with bearer auth and returns the job id", async () => {
    let seen: { url: string; init: RequestInit } | undefined;
    const fake = (async (url: string, init: RequestInit) => {
      seen = { url, init };
      return new Response(JSON.stringify({ job_id: "20260101-a1", dataset: { user_labels: 30 } }), {
        status: 202,
      });
    }) as unknown as typeof fetch;

    const res = await startTraining(settings, bundle, fake);
    expect(res).toEqual({ ok: true, jobId: "20260101-a1", dataset: { user_labels: 30 } });
    expect(seen?.url).toBe("https://example.modal.run/v1/train");
    expect((seen?.init.headers as Record<string, string>).authorization).toBe("Bearer tok");
    expect(JSON.parse(String(seen?.init.body)).policy.revision).toBe(DEFAULT_POLICY.revision);
  });

  it("surfaces the server detail on 400 and a friendly message on 503", async () => {
    const bad = (async () =>
      new Response(JSON.stringify({ detail: "need at least 20 labels, have 7" }), {
        status: 400,
      })) as unknown as typeof fetch;
    expect(await startTraining(settings, bundle, bad)).toEqual({
      ok: false,
      error: "need at least 20 labels, have 7",
    });

    const off = (async () => new Response("{}", { status: 503 })) as unknown as typeof fetch;
    expect((await startTraining(settings, bundle, off)).ok).toBe(false);
  });

  it("reports unreachable endpoints instead of throwing", async () => {
    const boom = (async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    const res = await startTraining(settings, bundle, boom);
    expect(res.ok).toBe(false);
  });
});

describe("getJob", () => {
  it("reads /v1/train/{id} and returns undefined for unknown jobs", async () => {
    const ok = (async (url: string) => {
      expect(url).toBe("https://example.modal.run/v1/train/j1");
      return new Response(JSON.stringify(job({ status: "training" })), { status: 200 });
    }) as unknown as typeof fetch;
    expect((await getJob(settings, "j1", ok))?.status).toBe("training");

    const missing = (async () => new Response("{}", { status: 404 })) as unknown as typeof fetch;
    expect(await getJob(settings, "nope", missing)).toBeUndefined();
  });
});
