(function loadPinnedMermaid() {
  var src = "https://unpkg.com/mermaid@10.9.3/dist/mermaid.min.js";
  if (document.querySelector('script[src="' + src + '"]')) {
    return;
  }
  var script = document.createElement("script");
  script.src = src;
  script.integrity = "sha256-Wo7JGCC9Va/vBJBoSJNpkQ5dbOcMgQOVLyfinT526Lw=";
  script.crossOrigin = "anonymous";
  script.referrerPolicy = "no-referrer";
  script.onload = function initializeMermaid() {
    if (window.mermaid && typeof window.mermaid.initialize === "function") {
      window.mermaid.initialize({ startOnLoad: true });
    }
  };
  document.head.appendChild(script);
})();
