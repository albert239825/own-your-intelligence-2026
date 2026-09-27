import {
  DEFAULT_CUSTOM_THRESHOLD,
  DEFAULT_POLICY,
  type Feedback,
  type Override,
  type Policy,
  type Rule,
  type TestClassifyResult,
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
  actionRows,
  RULE_BLURBS,
  splitCustomInstruction,
  type Aggressiveness,
  type Settings,
} from "./state";
import { buildTrainingRecords, toJsonl } from "./training";

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
/** Working copy of the custom-rule cutoff for the sliders. */
let draftCustomThreshold = DEFAULT_CUSTOM_THRESHOLD;
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
    customThreshold: draftCustomThreshold,
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

function rangeSlider(
  get: () => number,
  set: (v: number) => void,
  onChange: () => void,
  id?: string,
): HTMLElement {
  const wrap = el("div");
  const slider = el("input", { type: "range", min: "0.5", max: "0.99", step: "0.01" }) as HTMLInputElement;
  if (id) slider.id = id;
  const readout = el("span", { class: "mono" });
  const sync = () => {
    slider.value = String(get());
    readout.textContent = ` ${get().toFixed(2)}`;
  };
  slider.addEventListener("input", () => {
    set(Number(slider.value));
    sync();
    for (const f of aggRerenders) f();
    onChange();
  });
  sliderSyncs.push(sync);
  sync();
  wrap.append(slider, readout);
  return wrap;
}

function thresholdSlider(rule: Rule, onChange: () => void): HTMLElement {
  return rangeSlider(
    () => rule.hideThreshold ?? 0.85,
    (v) => (rule.hideThreshold = v),
    onChange,
  );
}

/** Mount the custom-rule confidence slider into `<prefix>-customth-mount`. */
function mountCustomThreshold(prefix: "ob" | "st", onChange: () => void): void {
  const mount = $(`${prefix}-customth-mount`);
  mount.replaceChildren();
  mount.append(
    el(
      "label",
      {},
      "Hide when confidence ≥ ",
      rangeSlider(
        () => draftCustomThreshold,
        (v) => (draftCustomThreshold = v),
        onChange,
        `${prefix}-customth`,
      ),
    ),
  );
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

const views = ["onboarding", "settings", "review", "test"] as const;
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
  $("nav-test").classList.toggle("active", v === "test");
  if (v === "onboarding") renderOnboarding();
  else if (v === "settings") renderSettings();
  else if (v === "review") await renderReview();
  else await refreshPolicy();
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

  draftCustomThreshold = currentPolicy.customThreshold ?? DEFAULT_CUSTOM_THRESHOLD;
  mountCustomThreshold("ob", schedulePreview);

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
      customThreshold: draftCustomThreshold,
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

  draftCustomThreshold = currentPolicy.customThreshold ?? DEFAULT_CUSTOM_THRESHOLD;
  mountCustomThreshold("st", renderPromptPanel);

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
      customThreshold: draftCustomThreshold,
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

async function exportTraining(): Promise<void> {
  const [res, store] = await Promise.all([
    send<{ policy: Policy }>({ type: "GET_POLICY" }),
    chrome.storage.local.get("feedback"),
  ]);
  const policy = res?.policy ?? currentPolicy;
  const feedback = (store.feedback as Feedback[] | undefined) ?? [];
  const jsonl = toJsonl(buildTrainingRecords(policy, feedback));
  const blob = new Blob([jsonl], { type: "application/x-ndjson" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "attention-filter-training.jsonl";
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

async function renderReview(): Promise<void> {
  const [polRes, store] = await Promise.all([
    send<{ policy: Policy }>({ type: "GET_POLICY" }),
    chrome.storage.local.get("feedback"),
  ]);
  if (polRes?.policy) currentPolicy = polRes.policy;
  const feedback = (store.feedback as Feedback[] | undefined) ?? [];

  const rows = actionRows(feedback, currentPolicy);
  const records = buildTrainingRecords(currentPolicy, feedback);
  const pos = records.filter((r) => r.label === 1).length;
  $("rv-summary").textContent =
    `${feedback.length} actions → ${records.length} training examples ` +
    `(${pos} positive · ${records.length - pos} negative)`;

  const host = $("rv-list");
  host.replaceChildren();
  $("rv-empty").toggleAttribute("hidden", rows.length > 0);

  for (const row of rows) {
    const fb = row.feedback;
    const card = el("div", { class: "card" });
    card.append(
      el("div", {},
        el("span", { class: `badge ${row.tone}` }, row.badge),
        ...(row.ruleTitle ? [" ", el("span", {}, row.ruleTitle)] : [])),
    );
    card.append(el("p", {}, fb.text));
    if (fb.quoteText) {
      card.append(el("p", { class: "muted", style: "margin-left:16px" }, `↳ ${fb.quoteText}`));
    }
    if (fb.explanation) card.append(el("p", { class: "muted" }, fb.explanation));
    if (fb.probabilities) {
      const chips = el("div");
      for (const [id, p] of Object.entries(fb.probabilities)) {
        chips.append(el("span", { class: "chip mono" }, `${id} ${p.toFixed(2)}`));
      }
      card.append(chips);
    }
    card.append(
      el("div", { class: "muted" },
        `revision ${fb.policyRevision} · ${new Date(fb.createdAt).toLocaleString()}` +
          (row.trainable ? "" : " · not used for training")),
    );
    const removeBtn = el("button", {}, "Remove");
    removeBtn.addEventListener("click", async () => {
      const res = await send({ type: "DELETE_FEEDBACK", feedbackId: fb.feedbackId });
      if (res !== undefined) await renderReview();
    });
    card.append(removeBtn);
    host.append(card);
  }
}

// ---- test a post ---------------------------------------------------------

async function refreshPolicy(): Promise<void> {
  const res = await send<{ policy: Policy }>({ type: "GET_POLICY" });
  if (res?.policy) currentPolicy = res.policy;
}

async function runTest(): Promise<void> {
  const text = ($("ts-text") as HTMLTextAreaElement).value;
  const quoteText = ($("ts-quote") as HTMLTextAreaElement).value.trim();
  const status = $("ts-status");
  const btn = $("ts-run") as HTMLButtonElement;
  if (text.trim().length === 0) {
    status.textContent = "Paste some text first";
    status.className = "status-err";
    return;
  }
  btn.disabled = true;
  status.textContent = "Classifying…";
  status.className = "muted";
  await refreshPolicy();
  const res = await send<{ result: TestClassifyResult }>({
    type: "TEST_CLASSIFY",
    text,
    quoteText: quoteText || undefined,
  });
  btn.disabled = false;
  if (!res) {
    status.textContent = "Request failed";
    status.className = "status-err";
    return;
  }
  status.textContent = "";
  renderTestResult(res.result);
}

function renderTestResult(r: TestClassifyResult): void {
  const host = $("ts-result");
  host.replaceChildren();
  const label = { hide: "Hidden", show: "Kept", uncertain: "Uncertain", unsupported: "Unsupported" }[r.disposition];
  host.append(el("div", {}, el("span", { class: `badge ${r.disposition}` }, label)));
  if (r.error) host.append(el("p", { class: "status-err" }, `Classifier error (fell back to show): ${r.error}`));
  let reason = "no rule fired";
  if (r.disposition === "hide") reason = `hidden by ${r.causeRuleIds.map(ruleTitle).join(", ")}`;
  else if (r.exceptionRuleIds.length > 0) reason = `kept: ${r.exceptionRuleIds.map(ruleTitle).join(", ")} protected it`;
  else if (r.disposition === "uncertain") reason = "borderline — kept but flagged";
  host.append(el("p", {}, reason));

  const table = el("table", { class: "rules" });
  const tb = el("tbody");
  tb.append(el("tr", {}, el("th", {}, "Rule"), el("th", {}, "P(yes)"), el("th", {}, "Threshold"), el("th", {}, "Outcome")));
  for (const t of r.trace) {
    let outcome = "below threshold";
    if (t.fired) outcome = "fired";
    else if (t.protectedBy)
      outcome = `${t.protectedBy.uncertain ? "weakly " : ""}protected by ${ruleTitle(t.protectedBy.ruleId)} (${t.protectedBy.probability.toFixed(2)})`;
    tb.append(
      el("tr", { class: t.fired ? "fired" : "" },
        el("td", {}, ruleTitle(t.ruleId)),
        el("td", { class: "mono" }, t.probability === undefined ? "—" : t.probability.toFixed(2)),
        el("td", { class: "mono" }, t.threshold.toFixed(2)),
        el("td", {}, outcome)),
    );
  }
  table.append(tb);
  host.append(table);

  const chips = el("div", { style: "margin-top:8px" });
  for (const [id, p] of Object.entries(r.probabilities)) {
    chips.append(el("span", { class: "chip mono" }, `${id} ${p.toFixed(2)}`));
  }
  host.append(el("h3", { style: "margin-top:10px" }, "Raw probabilities"), chips);
  host.append(
    el("div", { class: "muted" },
      `classifier ${r.classifier} · model ${r.modelVersion} · revision ${r.policyRevision} · ${r.elapsedMs} ms`),
  );
  host.append(el("details", {}, el("summary", {}, "JSON"), el("pre", { class: "mono" }, JSON.stringify(r, null, 2))));
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
$("st-training-export").addEventListener("click", () => void exportTraining());
$("rv-training-export").addEventListener("click", () => void exportTraining());
$("st-import").addEventListener("click", () => ($("st-import-file") as HTMLInputElement).click());
$("st-import-file").addEventListener("change", async (e) => {
  const f = (e.target as HTMLInputElement).files?.[0];
  if (f) await importJson(f);
  (e.target as HTMLInputElement).value = "";
});
$("ts-run").addEventListener("click", () => void runTest());
for (const id of ["ts-text", "ts-quote"]) {
  $(id).addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") void runTest();
  });
}
$("rv-refresh").addEventListener("click", () => void renderReview());
$("rv-clear-feedback").addEventListener("click", async () => {
  if (!confirm("Delete all saved actions? This clears the fine-tune dataset.")) return;
  await chrome.storage.local.set({ feedback: [] });
  await renderReview();
});
