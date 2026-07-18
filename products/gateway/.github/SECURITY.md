# Security Policy

## Report Privately

Do not open a public issue for a suspected vulnerability, leaked credential, private transcript, provider payload, or exploit detail. Use [GitHub private vulnerability reporting](https://github.com/joe-broadhead/opencode-gateway/security/advisories/new). Include the affected version or commit, impact, minimum reproduction, and any suggested containment. Redact live tokens, channel IDs, private paths, and message content; use disposable test values instead.

If private reporting is unavailable, contact the repository owner privately through the contact method on [@joe-broadhead's GitHub profile](https://github.com/joe-broadhead) and ask for a secure reporting channel. Do not send an exploit or secret in the first message.

The maintainer will acknowledge a usable report when practical, validate it against the local single-operator threat model, coordinate a fix and disclosure, and credit reporters who want attribution. There is no bug-bounty or response-time guarantee.

## Supported Versions

Security fixes target the latest tagged release and `main`. Older releases and arbitrary source snapshots do not receive backports. Until a fixed release is available, operators should stop exposing the affected surface, rotate implicated credentials, and follow the containment supplied in the private advisory.

OpenCode Gateway is a local public beta. Hosted, multi-tenant, compliance-certified, and managed incident-response guarantees are outside the supported security boundary.
