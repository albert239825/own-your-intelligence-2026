import type { DecisionResult } from "../contracts";
import { DEFAULT_SETTINGS, historyCounts, type Settings } from "../options/state";

function send<T>(msg: unknown): Promise<T | undefined> {
  return chrome.runtime.sendMessage(msg).then((r) => (r?.ok ? r : undefined));
}

const cb = document.getElementById("enabled") as HTMLInputElement;
const statusEl = document.getElementById("status")!;

cb.addEventListener("change", () => {
  void chrome.runtime
    .sendMessage({ type: "SET_ENABLED", enabled: cb.checked })
    .then((r) => {
      statusEl.textContent = r?.ok
        ? cb.checked
          ? "Filtering on"
          : "Filtering off"
        : "Failed to update";
    });
});

document.getElementById("finish-setup")!.addEventListener("click", () => {
  void chrome.runtime.openOptionsPage();
});
document.getElementById("open-settings")!.addEventListener("click", () => {
  void chrome.tabs.create({ url: chrome.runtime.getURL("options.html#settings") });
});
document.getElementById("open-review")!.addEventListener("click", () => {
  void chrome.tabs.create({ url: chrome.runtime.getURL("options.html#review") });
});

void (async () => {
  const [enabledRes, histRes, store] = await Promise.all([
    send<{ enabled: boolean }>({ type: "GET_ENABLED" }),
    send<{ history: DecisionResult[] }>({ type: "GET_HISTORY" }),
    chrome.storage.local.get("settings"),
  ]);
  cb.checked = enabledRes?.enabled ?? true;
  statusEl.textContent = cb.checked ? "Filtering on" : "Filtering off";

  const settings: Settings = {
    ...DEFAULT_SETTINGS,
    ...(store.settings as Partial<Settings> | undefined),
  };
  if (!settings.onboarded) {
    document.getElementById("setup")!.hidden = false;
    return;
  }
  document.getElementById("main")!.hidden = false;
  const counts = historyCounts(histRes?.history ?? []);
  document.getElementById("hidden")!.textContent = String(counts.hiddenToday);
  document.getElementById("uncertain")!.textContent = String(counts.uncertainTotal);
})();
