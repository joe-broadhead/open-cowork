const themeKey = "openwiki-theme";

function setTheme(theme) {
  document.documentElement.dataset.theme = theme;
  try {
    localStorage.setItem(themeKey, theme);
  } catch {}
  window.dispatchEvent(new CustomEvent("openwiki:themechange", { detail: { theme } }));
}

function initTheme() {
  document.querySelectorAll("[data-openwiki-theme-toggle]").forEach((button) => {
    button.addEventListener("click", () => {
      setTheme(document.documentElement.dataset.theme === "light" ? "dark" : "light");
    });
  });
}

export { initTheme };
