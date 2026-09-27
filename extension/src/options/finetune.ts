import type { ExportBundle, Settings } from "./state";

/** Job contract served by the River proxy (`/v1/train`). */
export type TrainStatus =
  | "queued"
  | "training"
  | "evaluating"
  | "promoted"
  | "rejected"
  | "failed";

export interface TrainDatasetStats {
  user_labels?: number;
  seed_labels?: number;
  feedback?: number;
  overrides?: number;
  by_rule?: Record<string, { yes: number; no: number }>;
  [k: string]: unknown;
}

export interface TrainJob {
  id: string;
  status: TrainStatus;
  created_at: string;
  updated_at: string;
  dataset?: TrainDatasetStats;
  train?: { checkpoint?: string; examples?: number; session_seconds?: number } | null;
  gate?: { passed: boolean; reason?: string } | null;
  checkpoint?: string | null;
  error?: string | null;
}

export const TERMINAL_STATUSES: TrainStatus[] = ["promoted", "rejected", "failed"];

export function isTerminal(status: TrainStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

/** One line of user-facing status for a job. */
export function jobStatusLine(job: TrainJob): string {
  switch (job.status) {
    case "queued":
      return `Job ${job.id} queued…`;
    case "training":
      return `Job ${job.id}: training…`;
    case "evaluating":
      return `Job ${job.id}: evaluating against the current model…`;
    case "promoted":
      return `Job ${job.id}: passed the holdout gate and is now serving your feed.`;
    case "rejected":
      return `Job ${job.id}: trained but did not beat the current model${
        job.gate?.reason ? ` (${job.gate.reason})` : ""
      } — nothing changed.`;
    case "failed":
      return `Job ${job.id} failed: ${job.error ?? "unknown error"}`;
  }
}

export function datasetLine(stats: TrainDatasetStats | undefined): string {
  if (!stats) return "";
  const parts: string[] = [];
  if (typeof stats.user_labels === "number") parts.push(`${stats.user_labels} of your labels`);
  if (typeof stats.seed_labels === "number") parts.push(`${stats.seed_labels} seed labels`);
  if (typeof stats.feedback === "number") parts.push(`${stats.feedback} from actions`);
  if (typeof stats.overrides === "number") parts.push(`${stats.overrides} from overrides`);
  return parts.join(" · ");
}

function base(settings: Settings): string {
  return settings.endpoint.replace(/\/$/, "");
}

function headers(settings: Settings): Record<string, string> {
  return {
    "content-type": "application/json",
    ...(settings.token ? { authorization: `Bearer ${settings.token}` } : {}),
  };
}

export type StartResult =
  | { ok: true; jobId: string; dataset?: TrainDatasetStats }
  | { ok: false; error: string };

/** POST /v1/train — the server aggregates the bundle into a training set. */
export async function startTraining(
  settings: Settings,
  bundle: ExportBundle,
  fetchImpl: typeof fetch = fetch,
): Promise<StartResult> {
  let res: Response;
  try {
    res = await fetchImpl(`${base(settings)}/v1/train`, {
      method: "POST",
      headers: headers(settings),
      body: JSON.stringify(bundle),
    });
  } catch (e) {
    return { ok: false, error: `Could not reach the endpoint: ${String(e)}` };
  }
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (res.status === 202 && typeof body.job_id === "string") {
    return { ok: true, jobId: body.job_id, dataset: body.dataset as TrainDatasetStats | undefined };
  }
  if (res.status === 503) {
    return { ok: false, error: "This endpoint does not have training enabled." };
  }
  const detail = typeof body.detail === "string" ? body.detail : `HTTP ${res.status}`;
  return { ok: false, error: detail };
}

export async function getJob(
  settings: Settings,
  jobId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<TrainJob | undefined> {
  const res = await fetchImpl(`${base(settings)}/v1/train/${encodeURIComponent(jobId)}`, {
    headers: headers(settings),
  });
  if (!res.ok) return undefined;
  return (await res.json()) as TrainJob;
}
