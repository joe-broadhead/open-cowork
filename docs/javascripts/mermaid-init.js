// Initialize Mermaid for in-page diagram blocks, including MkDocs Material's
// instant-navigation page swaps. The Mermaid runtime is self-hosted under
// docs/javascripts/vendor so published docs do not depend on a CDN.
const mermaidBaseConfig = {
  startOnLoad: false,
  securityLevel: "strict",
  flowchart: { curve: "basis", htmlLabels: true },
  sequence: { useMaxWidth: true },
};

function currentMermaidTheme() {
  const scheme = globalThis.document?.body?.getAttribute("data-md-color-scheme");
  return scheme === "slate" ? "dark" : "default";
}

function renderMermaidDiagrams() {
  const mermaid = globalThis.mermaid;
  if (!mermaid) return;

  mermaid.initialize({
    ...mermaidBaseConfig,
    theme: currentMermaidTheme(),
  });

  const run = mermaid.run;
  if (typeof run === "function") {
    run.call(mermaid, { querySelector: ".mermaid" }).catch(() => undefined);
  }
}

const materialDocument = globalThis.document$;
if (materialDocument && typeof materialDocument.subscribe === "function") {
  materialDocument.subscribe(renderMermaidDiagrams);
} else {
  globalThis.document?.addEventListener("DOMContentLoaded", renderMermaidDiagrams);
}
