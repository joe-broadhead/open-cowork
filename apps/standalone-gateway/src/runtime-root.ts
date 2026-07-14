import { isAbsolute, normalize, parse } from "node:path";

const MAX_RUNTIME_ROOT_BYTES = 4096;

export function normalizeStandaloneRuntimeRoot(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("OPEN_COWORK_STANDALONE_GATEWAY_RUNTIME_ROOT is required.");
  }
  const input = value.trim();
  if (Buffer.byteLength(input, "utf8") > MAX_RUNTIME_ROOT_BYTES) {
    throw new Error(`OPEN_COWORK_STANDALONE_GATEWAY_RUNTIME_ROOT exceeds ${MAX_RUNTIME_ROOT_BYTES} bytes.`);
  }
  if (input.includes("\0")) {
    throw new Error("OPEN_COWORK_STANDALONE_GATEWAY_RUNTIME_ROOT contains an invalid null byte.");
  }
  if (!isAbsolute(input)) {
    throw new Error("OPEN_COWORK_STANDALONE_GATEWAY_RUNTIME_ROOT must be an absolute path.");
  }
  const runtimeRoot = normalize(input);
  if (runtimeRoot === parse(runtimeRoot).root) {
    throw new Error("OPEN_COWORK_STANDALONE_GATEWAY_RUNTIME_ROOT must be a dedicated directory, not a filesystem root.");
  }
  return runtimeRoot;
}
