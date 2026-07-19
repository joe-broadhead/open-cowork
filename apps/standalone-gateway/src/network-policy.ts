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
  try {
    return assertPrivateHttpEndpoint(baseUrl, {
      ...options,
      purpose: "OpenCode base URL",
      allowWildcardBind: false,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // Preserve product error contract used by config/doctor tests and ops docs.
    if (message.includes("refuses public hosts")) {
      throw new Error(
        "Refusing public OpenCode endpoint; use loopback/private networking.",
        { cause: error },
      );
    }
    throw error;
  }
}

export function assertPrivateBindHost(host: string): void {
  if (host === "0.0.0.0" || host === "::" || host === "[::]") return;
  if (!isLoopbackOrPrivateHost(host, { allowPrivateDns: true })) {
    throw new Error(
      "Standalone Gateway server host must be loopback/private or explicitly fronted by an authenticated reverse proxy.",
    );
  }
}
