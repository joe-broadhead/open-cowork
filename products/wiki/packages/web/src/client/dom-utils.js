function isTypingTarget(target) {
  return target && ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName);
}

function escapeHtml(value) {
  return String(value || "").replace(/[&<>"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[char]);
}

function escapeAttr(value) {
  return escapeHtml(value).replace(/'/g, "&#39;");
}

function safeLocalStorageGet(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function safeLocalStorageSet(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {}
}

export { escapeAttr, escapeHtml, isTypingTarget, safeLocalStorageGet, safeLocalStorageSet };
