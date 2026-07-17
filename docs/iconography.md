# Iconography

Open Cowork uses Lucide through the renderer `Icon` wrapper at
`packages/ui/src/Icon.tsx`.

Use the wrapper instead of bespoke inline SVGs for app chrome, navigation,
toolbars, menus, and shared primitives:

```tsx
<Icon name="search" size={16} />
<IconButton icon="settings-2" label="Open settings" />
```

The wrapper sets `currentColor`, a 24px Lucide grid, and a size-aware default
`strokeWidth` (1.75 at 16px, 1.5 at 20px, 1.25 at 24px), overridable via the
`strokeWidth` prop. Icons are decorative by default with
`aria-hidden="true"`; interactive labels belong on the button or menu item
that contains the icon.

## Inventory

| Product meaning | Lucide wrapper name |
| --- | --- |
| Home | `home` |
| Projects | `folder` |
| Knowledge | `book-open` |
| Approvals | `circle-help` |
| Team (coworkers) | `users` |
| Playbooks | `workflow` |
| Channels | `activity` |
| Tools & Skills | `blocks` |
| Artifacts | `file` |
| Admin | `shield-check` |
| Health / readiness | `heart-pulse` or `activity` |
| Tools / actions | `wrench` |
| Coworker (portrait / detail) | `bot` |
| Search | `search` |
| Settings | `settings-2` |
| Sidebar toggle | `panel-left` |
| Send | `arrow-up` |
| Attach file | `paperclip` |
| Stop | `square` |
| Model / intelligence | `sparkles` |
| Reasoning | `brain` |
| Fork project chat | `git-fork` |
| Confirm / selected | `check` |
| Close / dismiss | `x` |
| More options / select | `chevron-down` |
| Empty state / building blocks | `blocks` |
| Warnings | `alert-circle` |
| Help / disabled reason | `circle-help` or `info` |

## Rules

- Add new icon names to `Icon.tsx` with named Lucide imports. Do not import the
  full icon namespace.
- Keep decorative icons hidden from assistive technology. Use `IconButton`
  when the icon itself is the control; its `label` prop is required.
- Use sizes `16`, `20`, or `24` unless a product surface has a documented
  exception.
- Do not use inline SVGs in chrome, navigation, toolbars, or shared primitives.
- Brand logos and downstream-provided brand media remain outside this system.

## Bundle Behavior

`lucide-react` declares `sideEffects: false`; `Icon.tsx` imports named Lucide
icons only for the product inventory above. The desktop Vite build verifies the
icon set stays tree-shakeable because no `* as Icons` namespace import is used.

## Licensing

`lucide-react` is recorded in `THIRD_PARTY_NOTICES.md` from the package
manifest. The bundled font packages for Mona Sans and Schibsted Grotesk are also
recorded there under OFL-1.1.
