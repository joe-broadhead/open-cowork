# Inbox Agent Orchestration Eval

This deterministic eval gates the inbox-driven autonomous wiki workflow without
calling an external model provider.

Run it with:

```sh
pnpm eval:inbox-agents -- --json
```

The eval creates a temporary team wiki and local bare Git remote, then verifies:

- local transcript inbox item to source to meeting/person/organization/topic proposals;
- hosted Streamable HTTP MCP proposal-mode inbox submit/list/read behavior;
- process denial for proposal-mode remote agents;
- permission filtering across two users and a shared Team Knowledge Space;
- duplicate transcript handling;
- prompt-injection transcript handling as untrusted evidence;
- commit and sync of processed inbox evidence to a local bare Git remote.

The report schema is `openwiki.inbox_agent_evals.v1`. It separates deterministic
OpenWiki product failures from future provider/model categories:

- `openwiki_product_failure`
- `provider_failure`
- `model_refusal`
- `model_timeout`
- `opencode_process_failure`

CI runs this eval as a blocking lightweight release gate and uploads
`artifacts/openwiki-inbox-agent-evals.json`.
