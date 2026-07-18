import { createHash } from "node:crypto";
import { isBlockedOpenWikiHost, normalizeOpenWikiHost } from "@openwiki/core";
import type {
  OpenWikiConfig,
  OpenWikiHttpConnectorConfig,
  OpenWikiSecretConfig,
} from "@openwiki/core";

const DEFAULT_OPENWIKI_SECRET_ENV_PREFIX = "OPENWIKI_SECRET_";

type CredentialSecret =
  | {
      kind: "bearer";
      token: string;
    }
  | {
      kind: "header";
      name: string;
      value: string;
    };

interface SecretResolverContext {
  connectorId: string;
  url: string;
}

export interface SecretResolver {
  resolveCredential(credentialRef: string, context: SecretResolverContext): Promise<CredentialSecret | undefined>;
}

interface ResolveHttpConnectorInput {
  config: OpenWikiConfig;
  url: string;
  connectorId?: string;
  credentialRef?: string;
  baseHeaders?: Record<string, string>;
  secretResolver?: SecretResolver;
}

interface ResolvedHttpConnector {
  headers: Record<string, string>;
  trust: {
    connector_kind?: SourceFetchConnectorKind;
    connector_id?: string;
    credential_ref?: string;
    authenticated?: boolean;
    repository?: string;
    source_path?: string;
    ref?: string;
  };
}

export const SOURCE_FETCH_CONNECTOR_KINDS = ["http", "github", "gitlab"] as const;
export type SourceFetchConnectorKind = typeof SOURCE_FETCH_CONNECTOR_KINDS[number];
export const SOURCE_FETCH_CONNECTOR_KIND_LABEL = SOURCE_FETCH_CONNECTOR_KINDS.join(", ");

export function isSourceFetchConnectorKind(value: string): value is SourceFetchConnectorKind {
  return (SOURCE_FETCH_CONNECTOR_KINDS as readonly string[]).includes(value);
}

interface ResolveSourceFetchRequestInput {
  config: OpenWikiConfig;
  connectorKind?: SourceFetchConnectorKind;
  connectorId?: string;
  credentialRef?: string;
  url?: string;
  github?: {
    owner: string;
    repo: string;
    path: string;
    ref?: string;
  };
  gitlab?: {
    project: string;
    path: string;
    ref: string;
  };
  baseHeaders?: Record<string, string>;
  secretResolver?: SecretResolver;
}

interface ResolvedSourceFetchRequest extends ResolvedHttpConnector {
  connectorKind: SourceFetchConnectorKind;
  requestUrl: string;
  sourceUrl: string;
}

const SENSITIVE_DEFAULT_HEADER_NAMES = new Set([
  "authorization",
  "cookie",
  "proxy-authorization",
  "set-cookie",
  "x-api-key",
  "api-key",
  "x-auth-token",
]);

const FORBIDDEN_CREDENTIAL_HEADER_NAMES = new Set(["set-cookie", "proxy-authorization"]);

async function resolveHttpConnectorForFetch(input: ResolveHttpConnectorInput): Promise<ResolvedHttpConnector> {
  if (input.credentialRef !== undefined && input.connectorId === undefined) {
    throw new Error("Source fetch credential_ref requires connector_id");
  }

  if (input.connectorId === undefined) {
    return {
      headers: normalizeBaseHeaders(input.baseHeaders),
      trust: {},
    };
  }

  const connector = (input.config.runtime?.connectors?.http ?? []).find(
    (candidate) => candidate.id === input.connectorId,
  );
  if (connector === undefined) {
    throw new Error(`Unknown source fetch HTTP connector: ${input.connectorId}`);
  }

  if (!connector.allowed_hosts?.length) {
    throw new Error(`HTTP connector '${connector.id}' must define allowed_hosts`);
  }
  const hostname = normalizeOpenWikiHost(new URL(input.url).hostname);
  if (!hostAllowedByConnector(hostname, connector.allowed_hosts)) {
    throw new Error(`Source fetch URL host '${hostname}' is not allowed for connector '${connector.id}'`);
  }

  const headers = buildHttpConnectorHeaders(connector, input.baseHeaders);
  const trust: ResolvedHttpConnector["trust"] = {
    connector_kind: "http",
    connector_id: connector.id,
  };

  await applyCredentialRef({
    config: input.config,
    connectorId: connector.id,
    requestUrl: input.url,
    headers,
    trust,
    ...(input.credentialRef === undefined ? {} : { credentialRef: input.credentialRef }),
    ...(connector.credential_refs === undefined ? {} : { allowedCredentialRefs: connector.credential_refs }),
    ...(input.secretResolver === undefined ? {} : { secretResolver: input.secretResolver }),
  });

  return { headers, trust };
}

export async function resolveSourceFetchRequest(
  input: ResolveSourceFetchRequestInput,
): Promise<ResolvedSourceFetchRequest> {
  const connectorKind = input.connectorKind ?? "http";

  if (connectorKind === "http") {
    const url = requiredString(input.url, "url");
    const connector = await resolveHttpConnectorForFetch({
      config: input.config,
      url,
      ...(input.connectorId === undefined ? {} : { connectorId: input.connectorId }),
      ...(input.credentialRef === undefined ? {} : { credentialRef: input.credentialRef }),
      ...(input.baseHeaders === undefined ? {} : { baseHeaders: input.baseHeaders }),
      ...(input.secretResolver === undefined ? {} : { secretResolver: input.secretResolver }),
    });
    return {
      connectorKind,
      requestUrl: url,
      sourceUrl: url,
      headers: connector.headers,
      trust: connector.trust,
    };
  }

  if (connectorKind === "github") {
    return resolveGitHubSourceFetch(input);
  }

  if (connectorKind === "gitlab") {
    return resolveGitLabSourceFetch(input);
  }

  throw new Error(`Unsupported source fetch connector kind: ${String(connectorKind)}`);
}

async function resolveGitHubSourceFetch(input: ResolveSourceFetchRequestInput): Promise<ResolvedSourceFetchRequest> {
  const connectorId = requiredString(input.connectorId, "connector_id");
  const connector = (input.config.runtime?.connectors?.github ?? []).find((candidate) => candidate.id === connectorId);
  if (connector === undefined) {
    throw new Error(`Unknown GitHub source connector: ${connectorId}`);
  }

  const github = input.github;
  if (github === undefined) {
    throw new Error("GitHub source fetch requires github_owner, github_repo, and source_path");
  }
  const owner = requiredReferencePart(github.owner, "github_owner");
  const repo = requiredReferencePart(github.repo, "github_repo");
  const sourcePath = normalizeSourcePath(github.path);
  const repository = `${owner}/${repo}`;
  assertRepositoryAllowed(repository, connector.allowed_repositories, connector.id);

  const apiBaseUrl = normalizeBaseUrl(connector.api_base_url ?? "https://api.github.com");
  const webBaseUrl = normalizeBaseUrl(connector.web_base_url ?? "https://github.com");
  const encodedPath = encodePathPreservingSlash(sourcePath);
  const requestUrl = `${apiBaseUrl}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${encodedPath}${
    github.ref === undefined ? "" : `?ref=${encodeURIComponent(github.ref)}`
  }`;
  const sourceUrl = `${webBaseUrl}/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/blob/${encodeURIComponent(
    github.ref ?? "HEAD",
  )}/${encodedPath}`;
  const headers = normalizeBaseHeaders(input.baseHeaders);
  headers.accept = "application/vnd.github.raw";

  const trust: ResolvedHttpConnector["trust"] = {
    connector_kind: "github",
    connector_id: connector.id,
    repository,
    source_path: sourcePath,
    ...(github.ref === undefined ? {} : { ref: github.ref }),
  };
  await applyCredentialRef({
    config: input.config,
    connectorId: connector.id,
    requestUrl,
    headers,
    trust,
    ...(input.credentialRef === undefined ? {} : { credentialRef: input.credentialRef }),
    ...(connector.credential_refs === undefined ? {} : { allowedCredentialRefs: connector.credential_refs }),
    ...(input.secretResolver === undefined ? {} : { secretResolver: input.secretResolver }),
  });

  return {
    connectorKind: "github",
    requestUrl,
    sourceUrl,
    headers,
    trust,
  };
}

async function resolveGitLabSourceFetch(input: ResolveSourceFetchRequestInput): Promise<ResolvedSourceFetchRequest> {
  const connectorId = requiredString(input.connectorId, "connector_id");
  const connector = (input.config.runtime?.connectors?.gitlab ?? []).find((candidate) => candidate.id === connectorId);
  if (connector === undefined) {
    throw new Error(`Unknown GitLab source connector: ${connectorId}`);
  }

  const gitlab = input.gitlab;
  if (gitlab === undefined) {
    throw new Error("GitLab source fetch requires gitlab_project, source_path, and ref");
  }
  const project = requiredReferencePart(gitlab.project, "gitlab_project");
  const sourcePath = normalizeSourcePath(gitlab.path);
  const ref = requiredReferencePart(gitlab.ref, "ref");
  assertRepositoryAllowed(project, connector.allowed_repositories, connector.id);

  const webBaseUrl = normalizeBaseUrl(connector.web_base_url ?? "https://gitlab.com");
  const apiBaseUrl = normalizeBaseUrl(connector.api_base_url ?? `${webBaseUrl}/api/v4`);
  const requestUrl = `${apiBaseUrl}/projects/${encodeURIComponent(project)}/repository/files/${encodeURIComponent(
    sourcePath,
  )}/raw?ref=${encodeURIComponent(ref)}`;
  const sourceUrl = `${webBaseUrl}/${encodePathPreservingSlash(project)}/-/blob/${encodeURIComponent(ref)}/${encodePathPreservingSlash(
    sourcePath,
  )}`;
  const headers = normalizeBaseHeaders(input.baseHeaders);
  headers.accept = "text/plain,text/markdown,text/html,application/json,application/xml,text/xml;q=0.9,*/*;q=0.1";

  const trust: ResolvedHttpConnector["trust"] = {
    connector_kind: "gitlab",
    connector_id: connector.id,
    repository: project,
    source_path: sourcePath,
    ref,
  };
  await applyCredentialRef({
    config: input.config,
    connectorId: connector.id,
    requestUrl,
    headers,
    trust,
    ...(input.credentialRef === undefined ? {} : { credentialRef: input.credentialRef }),
    ...(connector.credential_refs === undefined ? {} : { allowedCredentialRefs: connector.credential_refs }),
    ...(input.secretResolver === undefined ? {} : { secretResolver: input.secretResolver }),
  });

  return {
    connectorKind: "gitlab",
    requestUrl,
    sourceUrl,
    headers,
    trust,
  };
}

function createEnvironmentSecretResolver(
  config: OpenWikiSecretConfig | undefined,
  env: NodeJS.ProcessEnv = process.env,
): SecretResolver {
  return {
    async resolveCredential(credentialRef: string): Promise<CredentialSecret | undefined> {
      if (config?.backend === "none") {
        return undefined;
      }
      const envName = credentialRefToEnvName(credentialRef, config?.env_prefix);
      const raw = env[envName];
      if (raw === undefined || !raw.trim()) {
        return undefined;
      }
      return parseCredentialSecret(raw);
    },
  };
}

function credentialRefToEnvName(credentialRef: string, envPrefix?: string): string {
  const trimmed = credentialRef.trim();
  const suffix = credentialRef
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (!suffix) {
    throw new Error("Credential reference cannot be empty");
  }
  const digest = createHash("sha256").update(trimmed).digest("hex").slice(0, 8).toUpperCase();
  return `${envPrefix ?? DEFAULT_OPENWIKI_SECRET_ENV_PREFIX}${suffix}_${digest}`;
}

function parseCredentialSecret(raw: string): CredentialSecret {
  const value = raw.trim();
  if (!value) {
    throw new Error("Credential secret cannot be empty");
  }

  if (value.toLowerCase().startsWith("header:")) {
    const rest = value.slice("header:".length);
    const separator = rest.indexOf("=");
    if (separator <= 0) {
      throw new Error("Header credential secrets must use header:Name=value");
    }
    const name = rest.slice(0, separator).trim();
    const headerValue = rest.slice(separator + 1).trim();
    validateCredentialHeader(name, headerValue);
    return { kind: "header", name: name.toLowerCase(), value: headerValue };
  }

  if (/^bearer\s+/i.test(value)) {
    return { kind: "header", name: "authorization", value };
  }

  return { kind: "bearer", token: value };
}

function buildHttpConnectorHeaders(
  connector: OpenWikiHttpConnectorConfig,
  baseHeaders?: Record<string, string>,
): Record<string, string> {
  const headers = normalizeBaseHeaders(baseHeaders);
  for (const [name, value] of Object.entries(connector.default_headers ?? {})) {
    if (typeof value !== "string") {
      throw new Error(`Connector '${connector.id}' default header '${name}' must be a string`);
    }
    const normalizedName = normalizeHeaderName(name, connector.id);
    if (SENSITIVE_DEFAULT_HEADER_NAMES.has(normalizedName)) {
      throw new Error(`Connector '${connector.id}' default header '${name}' is sensitive and cannot be persisted`);
    }
    validateHeaderValue(value, `Connector '${connector.id}' default header '${name}'`);
    headers[normalizedName] = value;
  }
  return headers;
}

function hostAllowedByConnector(hostname: string, allowedHosts: string[]): boolean {
  return allowedHosts.some((rule) => {
    const normalizedRule = rule.trim().toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
    if (!normalizedRule) {
      return false;
    }
    if (normalizedRule.startsWith("*.")) {
      const suffix = normalizedRule.slice(2);
      return hostname.endsWith(`.${suffix}`);
    }
    return hostname === normalizedRule;
  });
}

function assertRepositoryAllowed(repository: string, allowedRepositories: string[] | undefined, connectorId: string): void {
  if (!allowedRepositories?.length) {
    throw new Error(`Source connector '${connectorId}' must define allowed_repositories`);
  }
  if (!repositoryAllowedByConnector(repository, allowedRepositories)) {
    throw new Error(`Repository '${repository}' is not allowed for connector '${connectorId}'`);
  }
}

function repositoryAllowedByConnector(repository: string, allowedRepositories: string[]): boolean {
  const normalizedRepository = repository.toLowerCase();
  return allowedRepositories.some((rule) => {
    const normalizedRule = rule.trim().toLowerCase();
    if (!normalizedRule) {
      return false;
    }
    if (normalizedRule === "*") {
      return true;
    }
    if (normalizedRule.endsWith("/*")) {
      return normalizedRepository.startsWith(normalizedRule.slice(0, -1));
    }
    return normalizedRepository === normalizedRule;
  });
}

async function applyCredentialRef(input: {
  config: OpenWikiConfig;
  connectorId: string;
  credentialRef?: string;
  allowedCredentialRefs?: string[];
  requestUrl: string;
  headers: Record<string, string>;
  trust: ResolvedHttpConnector["trust"];
  secretResolver?: SecretResolver;
}): Promise<void> {
  if (input.credentialRef === undefined) {
    return;
  }
  if (!(input.allowedCredentialRefs ?? []).includes(input.credentialRef)) {
    throw new Error(`Credential reference '${input.credentialRef}' is not allowed for connector '${input.connectorId}'`);
  }
  assertCredentialTransportSafe(input.requestUrl, input.connectorId);
  const resolver = input.secretResolver ?? createEnvironmentSecretResolver(input.config.runtime?.secrets);
  const credential = await resolver.resolveCredential(input.credentialRef, {
    connectorId: input.connectorId,
    url: input.requestUrl,
  });
  if (credential === undefined) {
    const envName = credentialRefToEnvName(input.credentialRef, input.config.runtime?.secrets?.env_prefix);
    throw new Error(`Credential reference '${input.credentialRef}' could not be resolved; expected ${envName}`);
  }
  applyCredential(input.headers, credential);
  input.trust.credential_ref = input.credentialRef;
  input.trust.authenticated = true;
}

function assertCredentialTransportSafe(requestUrl: string, connectorId: string): void {
  const parsed = new URL(requestUrl);
  if (parsed.protocol === "https:") {
    return;
  }
  if (process.env.OPENWIKI_ALLOW_INSECURE_CONNECTOR_CREDENTIALS === "1") {
    return;
  }
  throw new Error(
    `Credential reference for connector '${connectorId}' requires an HTTPS request URL; set OPENWIKI_ALLOW_INSECURE_CONNECTOR_CREDENTIALS=1 only for local development`,
  );
}

function applyCredential(headers: Record<string, string>, credential: CredentialSecret): void {
  if (credential.kind === "bearer") {
    validateCredentialHeader("authorization", credential.token);
    headers.authorization = `Bearer ${credential.token}`;
    return;
  }

  validateCredentialHeader(credential.name, credential.value);
  headers[credential.name.toLowerCase()] = credential.value;
}

function requiredString(value: string | undefined, field: string): string {
  if (value === undefined || !value.trim()) {
    throw new Error(`Source fetch requires ${field}`);
  }
  return value;
}

function requiredReferencePart(value: string | undefined, field: string): string {
  const part = requiredString(value, field).trim();
  if (/[\r\n]/.test(part)) {
    throw new Error(`Source fetch field '${field}' cannot contain newlines`);
  }
  return part.replace(/^\/+|\/+$/g, "");
}

function normalizeSourcePath(value: string): string {
  const sourcePath = requiredReferencePart(value, "source_path");
  if (sourcePath.includes("..") || sourcePath.startsWith(".")) {
    throw new Error("Source path cannot contain dot-directory traversal");
  }
  return sourcePath;
}

function normalizeBaseUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`Invalid connector base URL: ${value}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`Unsupported connector base URL protocol: ${parsed.protocol}`);
  }
  const hostname = normalizeOpenWikiHost(parsed.hostname);
  if (isBlockedOpenWikiHost(hostname)) {
    throw new Error(`Blocked private or metadata connector base URL host: ${hostname}`);
  }
  parsed.hash = "";
  parsed.search = "";
  return parsed.toString().replace(/\/+$/, "");
}

function encodePathPreservingSlash(value: string): string {
  return value
    .split("/")
    .filter(Boolean)
    .map((part) => encodeURIComponent(part))
    .join("/");
}

function normalizeBaseHeaders(baseHeaders: Record<string, string> | undefined): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(baseHeaders ?? {})) {
    const normalizedName = normalizeHeaderName(name, "base");
    validateHeaderValue(value, `Base header '${name}'`);
    headers[normalizedName] = value;
  }
  return headers;
}

function validateCredentialHeader(name: string, value: string): void {
  const normalizedName = normalizeHeaderName(name, "credential");
  if (FORBIDDEN_CREDENTIAL_HEADER_NAMES.has(normalizedName)) {
    throw new Error(`Credential header '${name}' is not allowed`);
  }
  validateHeaderValue(value, `Credential header '${name}'`);
}

function normalizeHeaderName(name: string, owner: string): string {
  const normalizedName = name.trim().toLowerCase();
  if (!normalizedName) {
    throw new Error(`Connector '${owner}' has an empty header name`);
  }
  if (!/^[!#$%&'*+\-.^_`|~0-9a-z]+$/.test(normalizedName)) {
    throw new Error(`Header '${name}' contains invalid characters`);
  }
  return normalizedName;
}

function validateHeaderValue(value: string, label: string): void {
  if (/[\r\n]/.test(value)) {
    throw new Error(`${label} contains an invalid newline`);
  }
}
