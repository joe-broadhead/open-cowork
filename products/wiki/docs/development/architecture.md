# Architecture

OpenWiki separates durable records from serving layers.

```mermaid
flowchart LR
  Core["@openwiki/core"] --> Repo["@openwiki/repo"]
  Core --> Policy["@openwiki/policy"]
  Core --> Connectors["@openwiki/connectors"]
  Repo --> GitStore["Git Repository"]
  Repo --> Search["@openwiki/search"]
  Repo --> IndexStore["@openwiki/index-store"]
  Repo --> Postgres["@openwiki/postgres-runtime"]
  Repo --> Storage["@openwiki/storage"]
  Repo --> Validation["@openwiki/validation"]
  Connectors --> Workflows["@openwiki/workflows"]
  Policy --> Workflows
  Storage --> Workflows
  Validation --> Workflows
  Workflows --> Jobs["@openwiki/jobs"]
  Workflows --> Harness["@openwiki/harness-opencode"]
  Repo --> Git["@openwiki/git"]
  Web["@openwiki/web"] --> HTTP["@openwiki/http-api"]
  Workflows --> HTTP
  Git --> HTTP
  Search --> HTTP
  IndexStore --> HTTP
  Postgres --> HTTP
  Policy --> HTTP
  Workflows --> MCP["@openwiki/mcp-server"]
  Search --> MCP
  Policy --> MCP
  Web --> Static["@openwiki/static-export"]
  Search --> Static
  Policy --> Static
  HTTP --> CLI["@openwiki/cli"]
  MCP --> CLI
  Jobs --> CLI
  Static --> CLI
```

The repository is canonical. Adapters should not invent separate data contracts;
they should expose the same records, operations, and policies.
