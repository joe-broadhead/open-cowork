# OpenWiki Edit Review

Use OpenWiki proposal tools for changes to canonical wiki content.

Workflow:

1. Read the target page and supporting claims.
2. Search for conflicting or stale records.
3. Draft the full replacement page body.
4. Call `wiki.propose_edit` with a concise rationale.
5. Use `wiki.comment_on_proposal` for non-decision review notes or missing
   evidence requests.
6. Use `wiki.close_proposal` only in reviewer/maintainer loadouts when a proposal
   is invalid, stale, duplicate, withdrawn, or superseded by another proposal.
7. Do not apply proposals unless the agent has an explicit maintainer loadout
   with write tools enabled.

Reviewers should check that the diff is scoped, cited, and consistent with
existing source and claim records.
