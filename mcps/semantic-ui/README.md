# Open Cowork Semantic UI MCP

MCP server for product-owned UI status, snapshots, and approval-gated actions.

The server talks to the local Open Cowork semantic UI bridge over loopback
HTTP. It exposes structured product state through `ui_status`, `ui_snapshot`,
and `ui_list_actions` (read-only), and performs approval-gated product actions
through `ui_execute_action`; it does not target DOM selectors, CSS classes,
coordinates, or screenshots.
