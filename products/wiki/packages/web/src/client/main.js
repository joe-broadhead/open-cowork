import { initDiffEnhancements } from "./diff-controls.js";
import { initGraphs } from "./graph/index.js";
import { initMarkdownEnhancements } from "./markdown.js";
import { initPalette } from "./palette.js";
import { initSidebar } from "./sidebar.js";
import { initTheme } from "./theme.js";
import { initTocScrollSpy } from "./toc.js";

document.documentElement.classList.add("ow-enhanced");
initTheme();
initPalette();
initGraphs();
initSidebar();
initMarkdownEnhancements();
initDiffEnhancements();
initTocScrollSpy();
