# Security Policy

## Supported versions

Open Cowork is early-stage software. Security fixes are expected to land on the latest supported `master` line and the most recent release series.

At minimum, assume:
- the latest release is supported
- older releases may not receive backports

## Reporting a vulnerability

Please do **not** open a public GitHub issue for security-sensitive problems.

Preferred path:
- use GitHub's private vulnerability reporting / security advisories for this repository
  - https://github.com/joe-broadhead/open-cowork/security/advisories/new

If that reporting path is not available yet:
- contact the maintainer privately through GitHub
- avoid posting exploit details publicly until a fix or mitigation exists

## What to include

Please include:
- affected version or commit
- impact summary
- reproduction steps or proof of concept
- whether the issue requires local access, renderer compromise, or configuration control
- any suggested mitigation

## Scope notes

Open Cowork is a desktop app that intentionally exposes powerful local capabilities when users enable them.

That means reports should distinguish between:
- expected trusted-local behavior
- real privilege boundary failures

Examples of expected powerful behavior:
- user-authorized local MCP execution
- project-thread file access in a chosen working directory

Examples of real security issues:
- renderer-to-main privilege escalation
- path traversal outside intended scope
- unauthorized secret disclosure
- broken isolation between sandbox and project behavior

## Disclosure

Please allow time for triage, fix development, and coordinated release before public disclosure.

## Response targets

These are targets, not contractual SLAs, but they set expectations for reporters:

- Critical: acknowledgement within 2 business days; mitigation or release target within 7 days
- High: acknowledgement within 3 business days; mitigation or release target within 14 days
- Medium / Low: acknowledgement within 5 business days; fix scheduled through normal maintenance

Business days are Monday-Friday in Europe/Amsterdam time, excluding local public holidays. If a response target passes without acknowledgement, re-contact the maintainer privately through GitHub with `[security-escalation]` in the subject.
