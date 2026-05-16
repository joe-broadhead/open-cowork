# Open Cowork Agents MCP

Bundled MCP for creating, previewing, reading, and deleting Open Cowork custom agents.

The MCP does not write agent files directly. It posts to the main-process
loopback bridge so every save uses the same validation, permission building,
and custom-agent store path as the desktop UI.
