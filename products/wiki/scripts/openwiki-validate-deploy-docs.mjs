import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const errors = [];

function fail(message) {
  errors.push(message);
}

async function read(relativePath) {
  return readFile(path.join(root, relativePath), "utf8");
}

async function listMarkdownFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const absolutePath = path.join(directory, entry.name);
    const relativePath = path.relative(root, absolutePath);
    if (entry.isDirectory()) {
      if (relativePath === "docs/archive") {
        continue;
      }
      files.push(...await listMarkdownFiles(absolutePath));
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      files.push(relativePath);
    }
  }
  return files;
}

function serviceNamesFromCompose(composeText) {
  const services = new Set();
  let inServices = false;
  for (const line of composeText.split("\n")) {
    if (line.trim() === "services:") {
      inServices = true;
      continue;
    }
    if (inServices && /^[A-Za-z0-9_-]+:/.test(line)) {
      break;
    }
    const match = /^  ([A-Za-z0-9_-]+):\s*$/.exec(line);
    if (inServices && match?.[1]) {
      services.add(match[1]);
    }
  }
  return services;
}

function sectionAfter(text, heading) {
  const start = text.indexOf(heading);
  if (start < 0) {
    return "";
  }
  const rest = text.slice(start + heading.length);
  const nextHeading = rest.search(/\n## /);
  return nextHeading < 0 ? rest : rest.slice(0, nextHeading);
}

const composeText = await read("deploy/compose/docker-compose.yml");
const composeServices = serviceNamesFromCompose(composeText);
const umbrelText = await read("deploy/umbrel/docker-compose.yml");
const umbrelServices = serviceNamesFromCompose(umbrelText);

if (!composeText.includes('"127.0.0.1:3030:3030"')) {
  fail("deploy/compose/docker-compose.yml must bind OpenWiki to 127.0.0.1:3030 by default");
}
if (/^\s*-\s*["']?3030:3030["']?\s*$/m.test(composeText)) {
  fail("deploy/compose/docker-compose.yml must not expose 3030 on all interfaces by default");
}

const docs = [
  "README.md",
  ...await listMarkdownFiles(path.join(root, "docs")),
  ...await listMarkdownFiles(path.join(root, "deploy")),
];
const supportedSetupModes = new Set(["personal", "team"]);

for (const file of docs) {
  const text = await read(file);
  if (/\bopenwiki\s+setup\s+hosted\b/.test(text)) {
    fail(`${file}: openwiki setup hosted is not a supported CLI command`);
  }
  for (const match of text.matchAll(/\bopenwiki\s+setup\s+([a-z][a-z-]*)\b/g)) {
    const mode = match[1];
    if (mode && !supportedSetupModes.has(mode)) {
      fail(`${file}: unsupported openwiki setup mode "${mode}"`);
    }
  }
  if (/-p\s+3030:3030\b/.test(text)) {
    fail(`${file}: Docker examples must bind 3030 to loopback unless explicitly overriding in prose`);
  }
  for (const match of text.matchAll(/docker compose -f deploy\/compose\/docker-compose\.yml\s+(?:--profile\s+[A-Za-z0-9_-]+\s+)?(?:run|exec)\s+(?:--rm\s+)?([A-Za-z0-9_-]+)/g)) {
    const service = match[1];
    if (service && !composeServices.has(service)) {
      fail(`${file}: deploy/compose command references unknown service "${service}"`);
    }
  }
}

const umbrelDoc = await read("docs/deployment/profiles/umbrel.md");
for (const match of umbrelDoc.matchAll(/docker compose exec\s+([A-Za-z0-9_-]+)/g)) {
  const service = match[1];
  if (service && !umbrelServices.has(service)) {
    fail(`docs/deployment/profiles/umbrel.md: Umbrel command references unknown service "${service}"`);
  }
}

for (const file of [
  "docs/deployment/profiles/kubernetes-helm.md",
  "docs/deployment/profiles/gcp.md",
]) {
  const text = await read(file);
  const quickstart = sectionAfter(text, "## Quickstart");
  if (/ingress\.enabled=true/.test(quickstart)) {
    fail(`${file}: quickstart must be port-forward-first; keep ingress in an authenticated section`);
  }
}

if (errors.length > 0) {
  for (const error of errors) {
    console.error(error);
  }
  process.exit(1);
}

console.log(`Deployment docs validation passed (${docs.length} markdown files, ${composeServices.size + umbrelServices.size} services checked).`);
