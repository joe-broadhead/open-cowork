import { routePanelAttrs, routeParityMarkup } from './route-markup.ts'

export function cloudKnowledgeRouteMarkup() {
  return `<section ${routePanelAttrs('knowledge')}>
          <div class="section-header">
            <div>
              <h2>Knowledge</h2>
              <div class="meta">Versioned Spaces, review queue, backlinks, and graph context</div>
            </div>
            <div class="row-actions">
              <button id="refresh-knowledge" type="button" data-knowledge-control="true">Refresh</button>
              <button class="primary" id="knowledge-capture-shortcut" type="button" data-knowledge-control="true">Capture to knowledge</button>
            </div>
          </div>
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
                <div class="panel" id="knowledge-review-queue">
                  <p class="empty">No proposals loaded.</p>
                </div>
                <div class="panel" id="knowledge-version-history">
                  <p class="empty">No version history loaded.</p>
                </div>
                <div class="panel" id="knowledge-graph">
                  <p class="empty">Knowledge graph loads with pages.</p>
                </div>
              </aside>
            </div>
          </div>
        </section>`
}
