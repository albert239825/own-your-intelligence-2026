const cb = document.getElementById("enabled") as HTMLInputElement;
const statusEl = document.getElementById("status")!;

chrome.runtime.sendMessage({ type: "GET_ENABLED" }).then((r) => {
  cb.checked = r?.ok ? r.enabled : true;
  statusEl.textContent = cb.checked ? "Filtering active" : "Filtering paused";
});

cb.addEventListener("change", () => {
  void chrome.runtime
    .sendMessage({ type: "SET_ENABLED", enabled: cb.checked })
    .then((r) => {
      statusEl.textContent = r?.ok
        ? cb.checked
          ? "Filtering active"
          : "Filtering paused"
        : "Failed to update";
    });
});
