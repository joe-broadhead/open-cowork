# Branding Assets

This directory is reserved for downstream branding assets referenced by `open-cowork.config.json`, such as sidebar logos. Only configured image assets are copied into packaged builds.

Upstream Open Cowork does not enable these assets by default. Downstream
builders can copy `sample/sidebar-logo.svg`, replace it with their own
artwork, and reference the path from their config overlay.

Example config:

```json
{
  "brand": {
    "assets": {
      "sidebarLogo": "branding/sample/sidebar-logo.svg"
    }
  }
}
```
