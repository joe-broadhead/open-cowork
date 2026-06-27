import { cloudStudioHeaderButtonMarkup, cloudStudioPageHeaderMarkup, routePanelAttrs, routeParityMarkup } from './route-markup.ts'

export function cloudKnowledgeRouteMarkup() {
  return `<section ${routePanelAttrs('knowledge')}>
          ${cloudStudioPageHeaderMarkup({
            eyebrow: 'Shared wiki',
            title: 'Knowledge',
            description: 'A shared wiki your coworkers help keep current. Edits are proposed, reviewed, then published — and every version is saved.',
            actionsMarkup: cloudStudioHeaderButtonMarkup({
              label: 'Refresh',
              attrs: 'id="refresh-knowledge" data-knowledge-control="true"',
            }) + cloudStudioHeaderButtonMarkup({
              label: 'Capture to knowledge',
              variant: 'primary',
              attrs: 'id="knowledge-capture-shortcut" data-knowledge-control="true"',
            }),
          })}
          <div class="knowledge-route-shell">
            ${routeParityMarkup('knowledge')}
            <div class="knowledge-layout">
              <aside class="panel knowledge-rail" id="knowledge-space-rail">
                <p class="empty">Knowledge Spaces load after sign-in.</p>
              </aside>
              <article class="panel knowledge-reader" id="knowledge-reader">
                <p class="empty">Select a Knowledge page.</p>
              </article>
              <aside class="knowledge-side">
                <div class="knowledge-side-panel" id="knowledge-review-queue">
                  <p class="empty">No proposals loaded.</p>
                </div>
                <div class="knowledge-side-panel" id="knowledge-version-history">
                  <p class="empty">No version history loaded.</p>
                </div>
                <div class="knowledge-side-panel" id="knowledge-access">
                  <p class="empty">Your access appears with a selected page.</p>
                </div>
                <div class="knowledge-side-panel" id="knowledge-graph">
                  <p class="empty">Knowledge graph loads with pages.</p>
                </div>
              </aside>
            </div>
          </div>
        </section>`
}
