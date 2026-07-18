import {
  assertPrivateHttpEndpoint,
  isLoopbackOrPrivateHost,
} from "@open-cowork/shared/node";

export function isLoopbackOrPrivateHostLocal(
  hostname: string,
  options: { allowPrivateDns?: boolean } = {},
): boolean {
  return isLoopbackOrPrivateHost(hostname, options);
}

// Preserve public API name used across standalone-gateway.
export { isLoopbackOrPrivateHost };

export function assertPrivateOpenCodeEndpoint(
  baseUrl: string,
  options: { allowPrivateDns?: boolean } = {},
): URL {
  return assertPrivateHttpEndpoint(baseUrl, {
    ...options,
    purpose: "OpenCode base URL",
    allowWildcardBind: false,
  });
}

export function assertPrivateBindHost(host: string): void {
  if (host === "0.0.0.0" || host === "::" || host === "[::]") return;
  if (!isLoopbackOrPrivateHost(host, { allowPrivateDns: true })) {
    throw new Error(
      "Standalone Gateway server host must be loopback/private or explicitly fronted by an authenticated reverse proxy.",
    );
  }
}
