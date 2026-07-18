import { safeLocalStorageGet, safeLocalStorageSet } from "./dom-utils.js";

function setOptionalParam(url, key, value) {
  if (value) {
    url.searchParams.set(key, value);
  } else {
    url.searchParams.delete(key);
  }
}

function initDiffEnhancements() {
  document.querySelectorAll(".ow-diff").forEach((diff) => {
    const requested = new URL(window.location.href).searchParams.get("diff");
    const stored = safeLocalStorageGet("openwiki-diff-mode");
    const initial = requested === "split" || requested === "unified" ? requested : stored === "split" || stored === "unified" ? stored : "unified";
    setDiffMode(diff, initial);
    diff.querySelectorAll("[data-openwiki-diff-mode]").forEach((button) => {
      button.addEventListener("click", () => {
        const mode = button.dataset.openwikiDiffMode === "split" ? "split" : "unified";
        setDiffMode(diff, mode);
        safeLocalStorageSet("openwiki-diff-mode", mode);
        try {
          const url = new URL(window.location.href);
          setOptionalParam(url, "diff", mode === "split" ? "split" : "");
          history.replaceState(null, "", url);
        } catch {}
      });
    });
    diff.querySelector("[data-openwiki-copy-diff]")?.addEventListener("click", async (event) => {
      const button = event.currentTarget;
      const patch = diff.querySelector("[data-openwiki-diff-patch]")?.content?.textContent || "";
      try {
        await navigator.clipboard?.writeText(patch);
        button.textContent = "Copied";
        setTimeout(() => {
          button.textContent = "Copy patch";
        }, 1400);
      } catch {
        button.textContent = "Select patch";
      }
    });
  });
}

function setDiffMode(diff, mode) {
  diff.dataset.mode = mode === "split" ? "split" : "unified";
  diff.querySelectorAll("[data-openwiki-diff-mode]").forEach((button) => {
    const active = button.dataset.openwikiDiffMode === diff.dataset.mode;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-pressed", String(active));
  });
}

export { initDiffEnhancements };
