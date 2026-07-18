(function () {
  document.documentElement.classList.add("ow-enhanced");
  try {
    var key = "openwiki-theme";
    var stored = localStorage.getItem(key);
    document.documentElement.dataset.theme = stored === "dark" || stored === "light" ? stored : "light";
  } catch (_) {
    document.documentElement.dataset.theme = "light";
  }
})();
