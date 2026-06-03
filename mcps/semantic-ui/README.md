# Open Cowork Semantic UI MCP

Read-only MCP server for product-owned UI status and snapshots.

The server talks to the local Open Cowork semantic UI bridge over loopback
HTTP. It exposes structured product state through `ui_status` and
`ui_snapshot`; it does not target DOM selectors, CSS classes, coordinates, or
screenshots.
