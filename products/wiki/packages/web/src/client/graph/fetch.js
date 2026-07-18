export async function fetchGraphPayload(src) {
  if (!src) {
    throw new Error("Missing graph source");
  }
  const response = await fetch(src);
  if (!response.ok) {
    throw new Error(`Graph request failed: HTTP ${response.status}`);
  }
  const payload = await response.json();
  if (!isGraphPayload(payload)) {
    throw new Error("Graph response has an invalid shape");
  }
  return payload;
}

function isGraphPayload(payload) {
  return payload && Array.isArray(payload.nodes) && Array.isArray(payload.edges);
}
