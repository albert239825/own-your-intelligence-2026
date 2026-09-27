import {
  DEFAULT_POLICY,
  type DecisionResult,
  type Feedback,
  type Override,
  type Policy,
  type Rule,
} from "../contracts";
import {
  buildExport,
  DEFAULT_SETTINGS,
  describePrompt,
  detectAggressiveness,
  joinCustomInstruction,
  nextPolicy,
  parseImport,
  presetThreshold,
  previewExamples,
  reviewRows,
  RULE_BLURBS,
  splitCustomInstruction,
  type Aggressiveness,
  type Settings,
} from "./state";

function send<T>(msg: unknown): Promise<T | undefined> {
  return chrome.runtime.sendMessage(msg).then((r) => (r?.ok ? r : undefined));
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
  ...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  for (const c of children) node.append(typeof c === "string" ? document.createTextNode(c) : c);
  return node;
}

const $ = (id: string) => document.getElementById(id)!;

// ---- global state ---------------------------------------------------------

let currentPolicy: Policy = DEFAULT_POLICY;
let settings: Settings = { ...DEFAULT_SETTINGS };
/** Working copy of rules for whichever editor is on screen. */
let draftRules: Rule[] = [];
let enabled = true;

const EXCEPTION_ID = "substantive_critique";

function cloneRules(p: Policy): Rule[] {
  return p.rules.map((r) => ({ ...r, exceptionRuleIds: [...r.exceptionRuleIds] }));
}

function ruleTitle(id: string): string {
  if (id === "custom") return "Your custom filter";
  return currentPolicy.rules.find((r) => r.id === id)?.title ?? id;
}

/** Toggle an exception-only rule; when off, strip it from exceptionRuleIds; when on, restore per DEFAULT_POLICY. */
function setExceptionEnabled(rules: Rule[], id: string, on: boolean): void {
  const rule = rules.find((r) => r.id === id);
  if (rule) rule.enabled = on;
  const refs = new Set(
    DEFAULT_POLICY.rules
      .filter((r) => r.exceptionRuleIds.includes(id))
      .map((r) => r.id),
  );
  for (const r of rules) {
    if (r.id === id) continue;
    const has = r.exceptionRuleIds.includes(id);
    if (!on && has) {
      r.exceptionRuleIds = r.exceptionRuleIds.filter((e) => e !== id);
    } else if (on && !has && refs.has(r.id)) {
      r.exceptionRuleIds = [...r.exceptionRuleIds, id];
    }
  }
}

function draftPolicy(prefix: "ob" | "st"): Policy {
  const lessMore = ($(`${prefix}-lessmore`) as HTMLTextAreaElement | null)?.value ?? "";
  const alwaysKeep = ($(`${prefix}-alwayskeep`) as HTMLTextAreaElement | null)?.value ?? "";
  return {
    schemaVersion: 1,
    revision: currentPolicy.revision,
    rules: draftRules,
    customInstruction: joinCustomInstruction(lessMore, alwaysKeep),
  };
}

// ---- shared widgets ---------------------------------------------------------

const AGGR_HINTS: Record<Aggressiveness, string> = {
  cautious: "Cautious: hides only when the model is very sure (defaults +10%)",
  balanced: "Balanced: the default thresholds (85\u201390%)",
  aggressive: "Aggressive: hides on weaker signals (defaults \u221215%)",
};

function renderAggControl(seg: HTMLElement, hintEl: HTMLElement, onChange: () => void): void {
  const render = () => {
    const detected = detectAggressiveness({
      ...currentPolicy,
      rules: draftRules,
    });
    seg.replaceChildren();
    for (const name of ["cautious", "balanced", "aggressive"] as Aggressiveness[]) {
      const b = el("button", {}, name[0]!.toUpperCase() + name.slice(1));
      if (detected === name) b.classList.add("active");
      b.addEventListener("click", () => {
        for (const r of draftRules) {
          if (r.hideThreshold !== undefined) r.hideThreshold = presetThreshold(r.id, name);
        }
        hintEl.textContent = AGGR_HINTS[name];
        syncSliders();
        render();
        onChange();
      });
      seg.append(b);
    }
    if (detected === "custom") {
      const b = el("button", { class: "custom-tag" }, "Custom");
      seg.append(b);
      hintEl.textContent = "Custom: thresholds differ between rules";
    } else {
      hintEl.textContent = AGGR_HINTS[detected];
    }
  };
  render();
  aggRerenders.push(render);
}

const aggRerenders: (() => void)[] = [];
const sliderSyncs: (() => void)[] = [];
function syncSliders(): void {
  for (const f of sliderSyncs) f();
}

function thresholdSlider(rule: Rule, onChange: () => void): HTMLElement {
  const wrap = el("div");
  const slider = el("input", { type: "range", min: "0.5", max: "0.99", step: "0.01" }) as HTMLInputElement;
  const readout = el("span", { class: "mono" });
  const sync = () => {
    slider.value = String(rule.hideThreshold ?? 0.85);
    readout.textContent = ` ${(rule.hideThreshold ?? 0.85).toFixed(2)}`;
  };
  slider.addEventListener("input", () => {
    rule.hideThreshold = Number(slider.value);
    sync();
    for (const f of aggRerenders) f();
    onChange();
  });
  sliderSyncs.push(sync);
  sync();
  wrap.append(slider, readout);
  return wrap;
}

interface ModelInputs {
  classifier: () => "mock" | "kev";
  endpoint: () => string;
  token: () => string;
}

function buildModelSection(container: HTMLElement, initial: Settings): ModelInputs {
  container.replaceChildren();
  const mockRadio = el("input", { type: "radio", name: `${container.id}-cls`, value: "mock" }) as HTMLInputElement;
  const kevRadio = el("input", { type: "radio", name: `${container.id}-cls`, value: "kev" }) as HTMLInputElement;
  const endpoint = el("input", { type: "url", placeholder: "https://...modal.run" }) as HTMLInputElement;
  const token = el("input", { type: "password" }) as HTMLInputElement;
  endpoint.value = initial.endpoint;
  token.value = initial.token;
  (initial.classifier === "kev" ? kevRadio : mockRadio).checked = true;
  const kevFields = el("div");
  kevFields.append(
    el("label", {}, "Endpoint URL ", endpoint),
    el("label", {}, "Token ", token),
  );
  const update = () => {
    kevFields.style.display = kevRadio.checked ? "" : "none";
  };
  mockRadio.addEventListener("change", update);
  kevRadio.addEventListener("change", update);
  container.append(
    el("label", {}, mockRadio, " Mock (offline demo — keyword heuristics, no network)"),
    el("label", {}, kevRadio, " Kev endpoint"),
    kevFields,
  );
  update();
  return {
    classifier: () => (kevRadio.checked ? "kev" : "mock"),
    endpoint: () => endpoint.value.trim(),
    token: () => token.value,
  };
}

// ---- routing ----------------------------------------------------------------

const views = ["onboarding", "settings", "review"] as const;
type View = (typeof views)[number];

function currentView(): View {
  const h = location.hash.replace("#", "") as View;
  if (views.includes(h)) return h;
  return settings.onboarded ? "settings" : "onboarding";
}

async function route(): Promise<void> {
  const v = currentView();
  for (const name of views) {
    $(`view-${name}`).classList.toggle("active", name === v);
  }
  $("nav-settings").classList.toggle("active", v === "settings");
  $("nav-review").classList.toggle("active", v === "review");
  if (v === "onboarding") renderOnboarding();
  else if (v === "settings") renderSettings();
  else await renderReview();
}

window.addEventListener("hashchange", () => void route());

// ---- onboarding ---------------------------------------------------------

let previewTimer = 0;
function schedulePreview(): void {
  window.clearTimeout(previewTimer);
  previewTimer = window.setTimeout(() => void updatePreview(), 100);
}

async function updatePreview(): Promise<void> {
  const panel = $("ob-preview");
  const rows = await previewExamples(draftPolicy("ob"));
  panel.replaceChildren();
  const labelText = { bait: "Bait", critique: "Heated critique", neutral: "Neutral" };
  for (const row of rows) {
    const card = el("div", { class: "card" });
    const ev = row.evaluation;
    const badge = el("span", { class: `badge ${ev.disposition}` },
      ev.disposition === "hide" ? "Hidden" : ev.disposition === "show" ? "Kept" : "Uncertain");
    card.append(el("div", {}, el("span", { class: "chip" }, labelText[row.label as keyof typeof labelText] ?? row.label), badge));
    card.append(el("p", {}, row.text));
    let reason = "no rule fired";
    if (ev.disposition === "hide") reason = `hidden by ${ev.causeRuleIds.map(ruleTitle).join(", ")}`;
    else if (ev.exceptionRuleIds.length > 0)
      reason = `kept: ${ev.exceptionRuleIds.map(ruleTitle).join(", ")} protected it`;
    else if (ev.disposition === "uncertain") reason = "borderline — kept but flagged";
    card.append(el("div", { class: "muted" }, reason));
    panel.append(card);
  }
}

let obModel: ModelInputs;

function renderOnboarding(): void {
  sliderSyncs.length = 0;
  aggRerenders.length = 0;
  draftRules = cloneRules(currentPolicy);

  const rulesHost = $("ob-rules");
  rulesHost.replaceChildren();
  for (const rule of draftRules) {
    if (rule.hideThreshold === undefined) continue;
    const blurb = RULE_BLURBS[rule.id];
    const card = el("div", { class: "card" });
    const cb = el("input", { type: "checkbox" }) as HTMLInputElement;
    cb.checked = rule.enabled;
    cb.addEventListener("change", () => {
      rule.enabled = cb.checked;
      schedulePreview();
      for (const f of aggRerenders) f();
    });
    card.append(el("label", {}, cb, ` ${rule.title}`));
    if (blurb) {
      card.append(el("div", { class: "muted" }, `Catches: ${blurb.catches}`));
      card.append(el("div", { class: "muted" }, `Spares: ${blurb.spares}`));
    }
    rulesHost.append(card);
  }

  const adv = $("ob-advanced");
  adv.replaceChildren();
  for (const rule of draftRules) {
    if (rule.hideThreshold === undefined) continue;
    const ta = el("textarea") as HTMLTextAreaElement;
    ta.value = rule.instruction;
    ta.addEventListener("input", () => {
      rule.instruction = ta.value;
      schedulePreview();
    });
    adv.append(
      el("h3", {}, rule.title),
      ta,
      thresholdSlider(rule, schedulePreview),
    );
  }

  renderAggControl($("ob-aggr"), $("ob-aggr-hint"), schedulePreview);

  const ex = $("ob-exceptions");
  ex.replaceChildren();
  const critRule = draftRules.find((r) => r.id === EXCEPTION_ID);
  if (critRule) {
    const cb = el("input", { type: "checkbox" }) as HTMLInputElement;
    cb.checked = critRule.enabled;
    cb.addEventListener("change", () => {
      setExceptionEnabled(draftRules, EXCEPTION_ID, cb.checked);
      schedulePreview();
    });
    ex.append(
      el("label", {}, cb, ` ${critRule.title}`),
      el("p", { class: "muted" }, "Disagreement with reasons stays visible even if it's heated."),
    );
  }

  const { lessMore, alwaysKeep } = splitCustomInstruction(currentPolicy.customInstruction);
  ($("ob-lessmore") as HTMLTextAreaElement).value = lessMore;
  ($("ob-alwayskeep") as HTMLTextAreaElement).value = alwaysKeep;

  obModel = buildModelSection($("ob-model"), settings);
  void updatePreview();
}

async function saveOnboarding(): Promise<void> {
  const status = $("ob-status");
  try {
    const next = nextPolicy(currentPolicy, {
      rules: draftRules,
      customInstruction: joinCustomInstruction(
        ($("ob-lessmore") as HTMLTextAreaElement).value,
        ($("ob-alwayskeep") as HTMLTextAreaElement).value,
      ),
    });
    const res = await send({ type: "SAVE_POLICY", policy: next });
    if (res === undefined) {
      status.textContent = "Save failed";
      status.className = "status-err";
      return;
    }
    settings = {
      classifier: obModel.classifier(),
      endpoint: obModel.endpoint(),
      token: obModel.token(),
      onboarded: true,
    };
    await chrome.storage.local.set({ settings });
    currentPolicy = next;
    location.hash = "#settings";
    settingsStatus(`Saved revision ${next.revision}`);
  } catch (e) {
    status.textContent = `Invalid: ${String(e)}`;
    status.className = "status-err";
  }
}

// ---- settings ---------------------------------------------------------

let stModel: ModelInputs;

function renderSettings(): void {
  sliderSyncs.length = 0;
  aggRerenders.length = 0;
  draftRules = cloneRules(currentPolicy);

  const body = $("st-rules");
  body.replaceChildren();
  const onEdit = () => {
    renderPromptPanel();
    for (const f of aggRerenders) f();
  };
  for (const rule of draftRules) {
    const tr = el("tr");
    const tdCb = el("td");
    const cb = el("input", { type: "checkbox" }) as HTMLInputElement;
    cb.checked = rule.enabled;
    cb.addEventListener("change", () => {
      if (rule.hideThreshold === undefined) setExceptionEnabled(draftRules, rule.id, cb.checked);
      else rule.enabled = cb.checked;
      onEdit();
    });
    tdCb.append(cb);
    const tdTitle = el("td", {}, el("strong", {}, rule.title));
    const tdInstr = el("td");
    const ta = el("textarea") as HTMLTextAreaElement;
    ta.value = rule.instruction;
    ta.addEventListener("input", () => {
      rule.instruction = ta.value;
      onEdit();
    });
    tdInstr.append(ta);
    const tdTh = el("td");
    if (rule.hideThreshold !== undefined) tdTh.append(thresholdSlider(rule, onEdit));
    else tdTh.append(el("span", { class: "muted" }, "exception"));
    tr.append(tdCb, tdTitle, tdInstr, tdTh);
    body.append(tr);
  }

  renderAggControl($("st-aggr"), $("st-aggr-hint"), onEdit);

  const { lessMore, alwaysKeep } = splitCustomInstruction(currentPolicy.customInstruction);
  const lm = $("st-lessmore") as HTMLTextAreaElement;
  const ak = $("st-alwayskeep") as HTMLTextAreaElement;
  lm.value = lessMore;
  ak.value = alwaysKeep;
  lm.oninput = ak.oninput = () => renderPromptPanel();

  stModel = buildModelSection($("st-model"), settings);
  renderPromptPanel();
}

function renderPromptPanel(): void {
  const desc = describePrompt(draftPolicy("st"));
  const host = $("prompt-panel");
  host.replaceChildren();
  host.append(el("div", { class: "q" }, desc.taskInstruction));
  for (const e of desc.entries) {
    host.append(el("div", { class: "q" }, `${e.title} — ${e.question}`));
  }
  host.append(
    el("div", { class: "muted" }, `compiler ${desc.compilerVersion} · policy revision ${desc.policyRevision}`),
  );
}

function settingsStatus(msg: string, err = false): void {
  const s = $("st-status");
  s.textContent = msg;
  s.className = err ? "status-err" : "status-ok";
}

async function saveSettings(): Promise<void> {
  try {
    const next = nextPolicy(currentPolicy, {
      rules: draftRules,
      customInstruction: joinCustomInstruction(
        ($("st-lessmore") as HTMLTextAreaElement).value,
        ($("st-alwayskeep") as HTMLTextAreaElement).value,
      ),
    });
    const res = await send({ type: "SAVE_POLICY", policy: next });
    if (res === undefined) {
      settingsStatus("Save failed", true);
      return;
    }
    settings = {
      ...settings,
      classifier: stModel.classifier(),
      endpoint: stModel.endpoint(),
      token: stModel.token(),
    };
    await chrome.storage.local.set({ settings });
    currentPolicy = next;
    settingsStatus(`Saved revision ${next.revision}`);
    renderSettings();
  } catch (e) {
    settingsStatus(`Invalid: ${String(e)}`, true);
  }
}

async function exportJson(): Promise<void> {
  const [res, store] = await Promise.all([
    send<{ policy: Policy }>({ type: "GET_POLICY" }),
    chrome.storage.local.get(["feedback", "overrides"]),
  ]);
  const bundle = buildExport(
    res?.policy ?? currentPolicy,
    (store.feedback as Feedback[] | undefined) ?? [],
    (store.overrides as Record<string, Override> | undefined) ?? {},
  );
  const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "attention-filter-export.json";
  a.click();
  URL.revokeObjectURL(a.href);
}

async function importJson(file: File): Promise<void> {
  const text = await file.text();
  const res = parseImport(text);
  if (!res.ok) {
    settingsStatus(res.error, true);
    return;
  }
  const policy: Policy = {
    ...res.policy,
    revision: Math.max(res.policy.revision, currentPolicy.revision) + 1,
  };
  const saved = await send({ type: "SAVE_POLICY", policy });
  if (saved === undefined) {
    settingsStatus("Import failed: policy rejected", true);
    return;
  }
  // Write feedback/overrides only if present in the file.
  const raw = JSON.parse(text) as Record<string, unknown>;
  const write: Record<string, unknown> = {};
  if ("feedback" in raw) write.feedback = res.feedback;
  if ("overrides" in raw) write.overrides = res.overrides;
  if (Object.keys(write).length > 0) await chrome.storage.local.set(write);
  currentPolicy = policy;
  settingsStatus(`Imported; saved revision ${policy.revision}`);
  renderSettings();
}

// ---- review ---------------------------------------------------------

const FEEDBACK_KIND_LABEL: Record<Feedback["kind"], string> = {
  wrong_classification: "Wrong classification",
  change_preference: "Preference changed",
  confirm_hide: "Confirmed",
};

async function renderReview(): Promise<void> {
  const [histRes, polRes, store] = await Promise.all([
    send<{ history: DecisionResult[] }>({ type: "GET_HISTORY" }),
    send<{ policy: Policy }>({ type: "GET_POLICY" }),
    chrome.storage.local.get("feedback"),
  ]);
  if (polRes?.policy) currentPolicy = polRes.policy;
  const history = histRes?.history ?? [];
  const feedback = (store.feedback as Feedback[] | undefined) ?? [];
  const feedbackByPost = new Map(feedback.map((f) => [f.postId, f]));

  const host = $("rv-list");
  host.replaceChildren();
  const rows = reviewRows(history, currentPolicy);
  $("rv-empty").toggleAttribute("hidden", rows.length > 0);

  for (const row of rows) {
    const r = row.result;
    const card = el("div", { class: "card" });
    card.append(
      el("div", {},
        el("span", { class: "mono" }, r.postId), " ",
        el("span", { class: `badge ${r.disposition}` }, r.disposition)),
    );
    if (row.causeTitles.length > 0) {
      card.append(el("div", {}, `Rule(s): ${row.causeTitles.join(", ")}`));
    }
    if (row.exceptionTitles.length > 0) {
      card.append(el("div", {}, `Protected by: ${row.exceptionTitles.join(", ")}`));
    }
    const chips = el("div");
    for (const [id, p] of Object.entries(r.probabilities)) {
      chips.append(el("span", { class: "chip mono" }, `${id} ${p.toFixed(2)}`));
    }
    card.append(chips);
    card.append(
      el("div", { class: "muted" },
        `source ${r.source} · model ${r.modelVersion} · revision ${r.policyRevision}`),
    );
    const fb = feedbackByPost.get(r.postId);
    if (fb) card.append(el("span", { class: "badge uncertain" }, FEEDBACK_KIND_LABEL[fb.kind]));
    if (fb && fb.text) card.append(el("p", {}, fb.text));
    else card.append(el("p", { class: "muted" }, "Post text is not stored in history; open the post on X by id."));

    const actions = el("div");
    const keepBtn = el("button", {}, "Keep this post");
    keepBtn.addEventListener("click", async () => {
      const res = await send({
        type: "SET_OVERRIDE",
        override: { postId: r.postId, contentHash: r.contentHash, action: "keep", createdAt: Date.now() },
      });
      if (res !== undefined) {
        keepBtn.disabled = true;
        card.append(el("span", { class: "badge show" }, "Kept"));
      }
    });
    actions.append(keepBtn, " ");

    const mkFeedback = (label: string, desired: "keep" | "hide") => {
      const b = el("button", {}, label);
      b.addEventListener("click", async () => {
        const res = await send({
          type: "SAVE_FEEDBACK",
          feedback: {
            feedbackId: crypto.randomUUID(),
            postId: r.postId,
            contentHash: r.contentHash,
            text: "",
            kind: "wrong_classification",
            desiredAction: desired,
            ruleId: r.causeRuleIds[0],
            policyRevision: r.policyRevision,
            createdAt: Date.now(),
          },
        });
        if (res !== undefined) {
          b.disabled = true;
          card.append(el("span", { class: "badge uncertain" }, "Feedback saved"));
        }
      });
      return b;
    };
    if (r.disposition === "hide") {
      actions.append(mkFeedback("Shouldn't have been hidden", "keep"));
    } else {
      actions.append(mkFeedback("Should've been hidden", "hide"));
    }
    card.append(actions);
    host.append(card);
  }
}

// ---- enabled pill ---------------------------------------------------------

async function refreshEnabled(): Promise<void> {
  const res = await send<{ enabled: boolean }>({ type: "GET_ENABLED" });
  enabled = res?.enabled ?? true;
  const pill = $("enabled-pill");
  pill.textContent = enabled ? "Filtering on" : "Filtering off";
  pill.className = `pill ${enabled ? "on" : "off"}`;
  ($("toggle-enabled") as HTMLButtonElement).textContent = enabled ? "Disable" : "Enable";
}

// ---- init -----------------------------------------------------------------

void (async () => {
  const store = await chrome.storage.local.get("settings");
  settings = { ...DEFAULT_SETTINGS, ...(store.settings as Partial<Settings> | undefined) };
  const res = await send<{ policy: Policy }>({ type: "GET_POLICY" });
  if (res?.policy) currentPolicy = res.policy;
  await refreshEnabled();
  if (!location.hash && !settings.onboarded) location.hash = "#onboarding";
  await route();
})();

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && "enabled" in changes) void refreshEnabled();
});

$("ob-save").addEventListener("click", () => void saveOnboarding());
$("ob-lessmore").addEventListener("input", schedulePreview);
$("ob-alwayskeep").addEventListener("input", schedulePreview);
$("toggle-enabled").addEventListener("click", async () => {
  await send({ type: "SET_ENABLED", enabled: !enabled });
  await refreshEnabled();
});
$("st-save").addEventListener("click", () => void saveSettings());
$("st-reonboard").addEventListener("click", async () => {
  settings.onboarded = false;
  await chrome.storage.local.set({ settings });
  if (location.hash === "#onboarding") await route();
  else location.hash = "#onboarding";
});
$("st-export").addEventListener("click", () => void exportJson());
$("rv-export").addEventListener("click", () => void exportJson());
$("st-import").addEventListener("click", () => ($("st-import-file") as HTMLInputElement).click());
$("st-import-file").addEventListener("change", async (e) => {
  const f = (e.target as HTMLInputElement).files?.[0];
  if (f) await importJson(f);
  (e.target as HTMLInputElement).value = "";
});
$("rv-refresh").addEventListener("click", () => void renderReview());
$("rv-clear").addEventListener("click", async () => {
  await send({ type: "CLEAR_HISTORY" });
  await renderReview();
});
