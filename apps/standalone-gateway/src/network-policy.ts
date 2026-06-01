const privateIpv4Ranges = [
  /^10\./,
  /^127\./,
  /^169\.254\./,
  /^172\.(1[6-9]|2\d|3[0-1])\./,
  /^192\.168\./,
];

export function isLoopbackOrPrivateHost(hostname: string, options: { allowPrivateDns?: boolean } = {}): boolean {
  const host = hostname.trim().toLowerCase().replace(/^\[(.*)]$/, "$1");
  if (!host) return false;
  if (host === "localhost" || host === "::1" || host === "0:0:0:0:0:0:0:1") return true;
  if (privateIpv4Ranges.some((pattern) => pattern.test(host))) return true;
  if (host.startsWith("fc") || host.startsWith("fd") || host.startsWith("fe80:")) return true;
  if (options.allowPrivateDns && (
    host.endsWith(".internal") ||
    host.endsWith(".local") ||
    host.endsWith(".lan") ||
    host.endsWith(".private")
  )) return true;
  return false;
}

export function assertPrivateOpenCodeEndpoint(baseUrl: string, options: { allowPrivateDns?: boolean } = {}): URL {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch (error) {
    throw new Error(`OpenCode base URL must be a valid URL: ${error instanceof Error ? error.message : String(error)}`, {
      cause: error,
    });
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("OpenCode base URL must use HTTP or HTTPS.");
  }
  if (!isLoopbackOrPrivateHost(url.hostname, options)) {
    throw new Error("Standalone Gateway refuses to use a public OpenCode endpoint. Bind OpenCode to loopback/private networking.");
  }
  if ((url.hostname === "0.0.0.0") || (url.hostname === "::")) {
    throw new Error("OpenCode must not be bound to a wildcard address.");
  }
  return url;
}

export function assertPrivateBindHost(host: string): void {
  if (host === "0.0.0.0" || host === "::" || host === "[::]") return;
  if (!isLoopbackOrPrivateHost(host, { allowPrivateDns: true })) {
    throw new Error("Standalone Gateway server host must be loopback/private or explicitly fronted by an authenticated reverse proxy.");
  }
}
