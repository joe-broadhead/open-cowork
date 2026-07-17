# Empty / error density checklist

**Issue:** JOE-888

## Shared pattern for pages

1. **Loading** → `Skeleton` or route-shaped `RouteFallback` (not a single muted word alone on a full page).
2. **Empty** → `@open-cowork/ui` `EmptyState` with title, description, and optional primary action.
3. **Error** → `ErrorState` or global toaster for transient failures; keep page chrome stable.
4. **Inline field errors** → stay next to the control; do not replace the whole page.

## Avoid

- Ad-hoc `text-text-muted` one-liners as the only empty affordance on a primary page.
- Mixing Skeleton and raw “Loading…” without `role="status"`.

## Migration

When touching a page, replace muted-only empties with `EmptyState` / `ErrorState`.
Home, Agents, Knowledge, and Approvals are the priority surfaces.
