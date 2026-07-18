import { escapeAttr, escapeHtml } from "./dom-utils.js";

function initMarkdownEnhancements() {
  document.querySelectorAll("textarea.markdown-editor").forEach((textarea) => {
    const preview = document.querySelector("[data-openwiki-markdown-preview]");
    if (!preview) return;
    const render = () => {
      preview.innerHTML = renderPreviewMarkdown(textarea.value);
      initCodeCopyButtons(preview);
    };
    textarea.addEventListener("input", render);
  });
  initCodeCopyButtons(document);
  initCitationCopyButtons(document);
}

function initCodeCopyButtons(root) {
  root.querySelectorAll("[data-openwiki-copy-code]").forEach((button) => {
    if (button.dataset.openwikiCopyReady === "1") {
      return;
    }
    button.dataset.openwikiCopyReady = "1";
    button.addEventListener("click", async () => {
      const code = button.closest("pre")?.querySelector("code")?.textContent || "";
      try {
        await navigator.clipboard?.writeText(code);
        button.textContent = "Copied";
        setTimeout(() => {
          button.textContent = "Copy";
        }, 1400);
      } catch {
        button.textContent = "Select";
      }
    });
  });
}

function initCitationCopyButtons(root) {
  root.querySelectorAll("[data-openwiki-copy-citation]").forEach((button) => {
    if (button.dataset.openwikiCitationReady === "1") {
      return;
    }
    button.dataset.openwikiCitationReady = "1";
    button.addEventListener("click", async () => {
      const citation = button.dataset.openwikiCopyCitation || "";
      try {
        await navigator.clipboard?.writeText(citation);
        button.textContent = "Copied";
        setTimeout(() => {
          button.textContent = "Cite";
        }, 1400);
      } catch {
        button.textContent = "Select citation";
      }
    });
  });
}

function renderPreviewMarkdown(markdown) {
  const lines = String(markdown || "").split(/\r?\n/);
  const html = [];
  let paragraph = [];
  let list = [];
  let code;
  const flushParagraph = () => {
    if (paragraph.length) {
      html.push(`<p>${renderPreviewInline(paragraph.join(" "))}</p>`);
      paragraph = [];
    }
  };
  const flushList = () => {
    if (list.length) {
      html.push(`<ul>${list.map((item) => `<li>${renderPreviewInline(item)}</li>`).join("")}</ul>`);
      list = [];
    }
  };
  const flushCode = () => {
    if (code) {
      html.push(`<pre class="ow-code" data-language="${escapeAttr(code.lang || "text")}"><button type="button" class="ow-code-copy" data-openwiki-copy-code aria-label="Copy code">Copy</button><code>${escapeHtml(code.lines.join("\n"))}</code></pre>`);
      code = undefined;
    }
  };
  for (const line of lines) {
    const fence = /^```([A-Za-z0-9_-]+)?\s*$/.exec(line);
    if (fence) {
      if (code) {
        flushCode();
      } else {
        flushParagraph();
        flushList();
        code = { lang: fence[1] || "", lines: [] };
      }
      continue;
    }
    if (code) {
      code.lines.push(line);
      continue;
    }
    if (!line.trim()) {
      flushParagraph();
      flushList();
      continue;
    }
    const heading = /^(#{1,4})\s+(.+)$/.exec(line);
    if (heading) {
      flushParagraph();
      flushList();
      const level = heading[1].length;
      html.push(`<h${level}>${renderPreviewInline(heading[2])}</h${level}>`);
      continue;
    }
    const bullet = /^\s*[-*]\s+(.+)$/.exec(line);
    if (bullet) {
      flushParagraph();
      list.push(bullet[1]);
      continue;
    }
    paragraph.push(line.trim());
  }
  flushParagraph();
  flushList();
  flushCode();
  return html.join("\n") || '<p class="ow-muted">Nothing to preview yet.</p>';
}

function renderPreviewInline(value) {
  return escapeHtml(value)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2">$1</a>')
    .replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, '<span class="ow-link--unresolved">$2$1</span>');
}

export { initMarkdownEnhancements };
