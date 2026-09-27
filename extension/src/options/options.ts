import type { DecisionResult, Policy } from "../contracts";

function send<T>(msg: unknown): Promise<T | undefined> {
  return chrome.runtime.sendMessage(msg).then((r) => (r?.ok ? r : undefined));
}

const rulesEl = document.getElementById("rules")!;
const customEl = document.getElementById("custom") as HTMLTextAreaElement;
const statusEl = document.getElementById("status")!;
const endpointEl = document.getElementById("endpoint") as HTMLInputElement;
const tokenEl = document.getElementById("token") as HTMLInputElement;
const classifierEl = document.getElementById("classifier") as HTMLSelectElement;
const historyBody = document.querySelector("#history tbody")!;

interface Settings {
  endpoint: string;
  token: string;
  classifier: "mock" | "kev";
}

let policy: Policy | null = null;
const seen = new Set<string>();

function renderPolicy(p: Policy): void {
  rulesEl.innerHTML = "";
  for (const rule of p.rules) {
    if (seen.has(rule.id)) continue;
    seen.add(rule.id);
    const div = document.createElement("div");
    div.className = "rule";
    div.dataset.ruleId = rule.id;

    const label = document.createElement("label");
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = rule.enabled;
    label.append(cb, ` ${rule.title}`);

    const ta = document.createElement("textarea");
    ta.value = rule.instruction;

    div.append(label, ta);
    rulesEl.append(div);
  }
  customEl.value = p.customInstruction ?? "";
}

async function save(): Promise<void> {
  if (!policy) return;
  const rules = [...rulesEl.querySelectorAll<HTMLElement>(".rule")].map((div) => {
    const base = policy!.rules.find((r) => r.id === div.dataset.ruleId)!;
    return {
      ...base,
      enabled: div.querySelector<HTMLInputElement>("input[type=checkbox]")!.checked,
      instruction: div.querySelector("textarea")!.value,
    };
  });
  const next: Policy = {
    ...policy,
    revision: policy.revision + 1,
    rules,
    customInstruction: customEl.value.trim() || undefined,
  };

  // Settings are written directly: options pages share chrome.storage.local.
  const settings: Settings = {
    endpoint: endpointEl.value.trim(),
    token: tokenEl.value,
    classifier: classifierEl.value as Settings["classifier"],
  };
  await chrome.storage.local.set({ settings });

  const res = await send({ type: "SAVE_POLICY", policy: next });
  if (res !== undefined) {
    policy = next;
    statusEl.textContent = `Saved (revision ${next.revision})`;
    setTimeout(() => (statusEl.textContent = ""), 3000);
  }
}

async function loadHistory(): Promise<void> {
  const res = await send<{ history: DecisionResult[] }>({ type: "GET_HISTORY" });
  historyBody.innerHTML = "";
  for (const h of res?.history ?? []) {
    const tr = document.createElement("tr");
    tr.innerHTML =
      `<td>${h.postId}</td><td>${h.disposition}</td>` +
      `<td>${h.causeRuleIds.join(", ") || "—"}</td>`;
    const td = document.createElement("td");
    const btn = document.createElement("button");
    btn.textContent = "Keep / restore";
    btn.addEventListener("click", () =>
      send({
        type: "SET_OVERRIDE",
        override: {
          postId: h.postId,
          contentHash: h.contentHash,
          action: "keep",
          createdAt: Date.now(),
        },
      }),
    );
    td.append(btn);
    tr.append(td);
    historyBody.append(tr);
  }
}

async function exportJson(): Promise<void> {
  const [p, store] = await Promise.all([
    send<{ policy: Policy }>({ type: "GET_POLICY" }),
    chrome.storage.local.get("feedback"),
  ]);
  const blob = new Blob(
    [JSON.stringify({ policy: p?.policy, feedback: store.feedback ?? [] }, null, 2)],
    { type: "application/json" },
  );
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "attention-filter-export.json";
  a.click();
  URL.revokeObjectURL(a.href);
}

void (async () => {
  const res = await send<{ policy: Policy }>({ type: "GET_POLICY" });
  if (res?.policy) {
    policy = res.policy;
    renderPolicy(policy);
  }
  const { settings } = (await chrome.storage.local.get("settings")) as {
    settings?: Partial<Settings>;
  };
  endpointEl.value = settings?.endpoint ?? "";
  tokenEl.value = settings?.token ?? "";
  classifierEl.value = settings?.classifier ?? "mock";
  void loadHistory();
})();

document.getElementById("save")!.addEventListener("click", () => void save());
document.getElementById("refresh-history")!.addEventListener("click", () => void loadHistory());
document.getElementById("clear-history")!.addEventListener("click", async () => {
  await send({ type: "CLEAR_HISTORY" });
  await loadHistory();
});
document.getElementById("export")!.addEventListener("click", () => void exportJson());
