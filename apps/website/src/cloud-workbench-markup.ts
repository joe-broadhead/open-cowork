import { escapeHtml } from './html-utils.ts'
import {
  cloudStudioHeaderButtonMarkup,
  cloudStudioHeaderFilterMarkup,
  cloudStudioPageHeaderMarkup,
  cloudWorkflowScheduleFieldsMarkup,
  routePanelAttrs,
  routeParityMarkup,
} from './route-markup.ts'

// The Studio workbench route panels (Approvals, Coworkers, Tools & Skills,
// Playbooks, Channels, Artifacts). Extracted from render.ts so the SSR template
// stays within its module budget, and so each route header is a single
// `.studio-page-header` (eyebrow / h1 / description / actions) matching desktop's
// shared StudioPageHeader — the cloud markup layer is a string template, so we
// emit the same class structure the React primitive renders and the shared CSS
// (single-sourced in @open-cowork/ui, embedded on the website) styles it.
//
// Every existing control id (`#capability-filter`, `#refresh-capabilities`,
// `#workflow-filter`, `#refresh-workflows`, `#channel-filter`,
// `#workflow-form`, the agent/policy/artifact list ids) and `data-*-control`
// attribute is preserved so the React controllers bind exactly as before.
export function cloudWorkbenchRouteSectionsMarkup(options: {
  profileName: string
  chatEnabled: boolean
  workflowsEnabled: boolean
}) {
  const { profileName, chatEnabled, workflowsEnabled } = options
  return `<section ${routePanelAttrs('approvals')}>
          ${cloudStudioPageHeaderMarkup({
            eyebrow: 'Review',
            title: 'Approvals',
            description: 'OpenCode permission requests and questions stay runtime-owned; this is one place to answer waiting inputs across chats and channels.',
            actionsMarkup: cloudStudioHeaderButtonMarkup({
              label: 'New chat',
              variant: 'primary',
              attrs: 'data-new-thread-shortcut="true" data-chat-control="true"',
            }),
          })}
          <div class="approval-route-shell">
            ${routeParityMarkup('approvals')}
            <div id="cloud-approvals-queue" class="studio-approvals-surface">
              <p class="empty">Approvals load after sign-in.</p>
            </div>
          </div>
        </section>

        <section ${routePanelAttrs('agents')}>
          ${cloudStudioPageHeaderMarkup({
            eyebrow: 'Team',
            title: 'Coworkers',
            description: 'Profile-allowed collaborators you can assign work to in chat, each with clear roles, skills, and tools.',
            actionsMarkup: cloudStudioHeaderButtonMarkup({
              label: 'Refresh',
              attrs: 'id="refresh-capabilities" data-capability-control="true"',
            }),
          })}
          <div class="grid">
            ${routeParityMarkup('agents')}
            <div class="panel">
              <h3>Available coworkers</h3>
              <div class="list" id="workbench-agent-list">
                <p class="empty">No coworkers loaded.</p>
              </div>
            </div>
            <div class="panel">
              <h3>Policy</h3>
              <div class="list" id="agent-policy-list">
                <div class="row compact"><strong>Profile</strong><span>${escapeHtml(profileName)}</span></div>
                <div class="row compact"><strong>Chat</strong><span>${chatEnabled ? 'enabled' : 'disabled'}</span></div>
              </div>
            </div>
          </div>
        </section>

        <section ${routePanelAttrs('capabilities')}>
          ${cloudStudioPageHeaderMarkup({
            eyebrow: 'Capabilities',
            title: 'Tools & Skills',
            description: 'Inspect the OpenCode tools and skills available to coworkers and playbooks in this workspace.',
            actionsMarkup: cloudStudioHeaderFilterMarkup({
              inputId: 'capability-filter',
              label: 'Filter',
              placeholder: 'tool, skill, coworker, source',
              controlAttr: 'data-capability-control="true"',
            }),
          })}
          <div class="grid">
            ${routeParityMarkup('capabilities')}
            <div class="panel">
              <h3>Capability library</h3>
              <div id="capability-tabs"></div>
              <div class="list" id="capability-active-list">
                <p class="empty">No capabilities loaded.</p>
              </div>
            </div>
            <div class="panel">
              <h3>Policy notes</h3>
              <div class="list" id="capability-policy-note">
                <p class="empty">Cloud-safe capability metadata loads after sign-in.</p>
              </div>
            </div>
          </div>
        </section>

        <section ${routePanelAttrs('workflows')}>
          ${cloudStudioPageHeaderMarkup({
            eyebrow: 'Playbooks',
            title: 'Playbooks',
            description: 'Save repeatable work, then run it manually, on a schedule, or from a webhook.',
            metaMarkup: `<span class="pill" data-kind="${workflowsEnabled ? 'ok' : 'warn'}">${workflowsEnabled ? 'enabled' : 'disabled'}</span>`,
            actionsMarkup: cloudStudioHeaderFilterMarkup({
              inputId: 'workflow-filter',
              label: 'Filter',
              placeholder: 'title, coworker, trigger, status',
              controlAttr: 'data-workflow-control="true"',
            }) + cloudStudioHeaderButtonMarkup({
              label: 'Refresh',
              attrs: 'id="refresh-workflows" data-workflow-control="true"',
            }),
          })}
          <div class="workbench-split">
            ${routeParityMarkup('workflows')}
            <div class="panel">
              <div class="table-shell" role="table" aria-label="Cloud playbooks">
                <div class="table-row table-head" role="row">
                  <span role="columnheader">Playbook</span>
                  <span role="columnheader">Status</span>
                  <span role="columnheader">Last run</span>
                  <span role="columnheader">Next run</span>
                </div>
                <div id="workflow-list">
                  <div class="table-row empty-row" role="row">
                    <span role="cell">No playbooks loaded.</span>
                    <span role="cell">-</span>
                    <span role="cell">-</span>
                    <span role="cell">-</span>
                  </div>
                </div>
              </div>
              <h3>Runs</h3>
              <div class="list" id="workflow-run-list">
                <p class="empty">No runs loaded.</p>
              </div>
            </div>
            <div class="panel">
              <form id="workflow-form">
                <h3>Create playbook</h3>
                <div class="form-grid">
                  <label class="span"><span>Title</span><input name="title" autocomplete="off" placeholder="Daily review" data-workflow-control="true"></label>
                  <label><span>Lead coworker</span><input name="agentName" autocomplete="off" placeholder="build" data-workflow-control="true"></label>
                  <label><span>Trigger</span><select name="triggerType" data-workflow-control="true">
                    <option value="manual">Manual</option>
                    <option value="schedule">Schedule</option>
                    <option value="webhook">Webhook</option>
                  </select></label>
                  ${cloudWorkflowScheduleFieldsMarkup()}
                  <label><span>Tools</span><input name="toolIds" autocomplete="off" placeholder="comma-separated" data-workflow-control="true"></label>
                  <label><span>Skills</span><input name="skillNames" autocomplete="off" placeholder="comma-separated" data-workflow-control="true"></label>
                  <label class="span"><span>Instructions</span><textarea name="instructions" placeholder="What this playbook should do" data-workflow-control="true"></textarea></label>
                  <button class="primary span" type="submit" data-workflow-control="true">Create playbook</button>
                </div>
              </form>
              <h3>Selected playbook</h3>
              <div class="list" id="workflow-detail">
                <p class="empty">Select or create a playbook.</p>
              </div>
            </div>
          </div>
        </section>

        <section ${routePanelAttrs('channels')}>
          <div class="channel-route-shell">
            ${routeParityMarkup('channels')}
            <div class="channel-filter-bar">
              ${cloudStudioHeaderFilterMarkup({
                inputId: 'channel-filter',
                label: 'Filter channels',
                placeholder: 'provider, channel, status, coworker',
                controlAttr: 'data-channel-control="true"',
              })}
            </div>
            <div id="channel-gateway-surface" class="studio-channels-surface">
              <p class="empty">Channels load after sign-in.</p>
            </div>
          </div>
        </section>

        <section ${routePanelAttrs('artifacts')}>
          ${cloudStudioPageHeaderMarkup({
            eyebrow: 'Deliverables',
            title: 'Artifacts',
            description: 'Generated files, charts, and Cloud-safe attachments across projects, sessions, and coworkers.',
          })}
          <div class="grid">
            ${routeParityMarkup('artifacts')}
            <div class="panel">
              <h3>Artifact library</h3>
              <div class="list" id="artifact-list">
                <p class="empty">No artifacts loaded.</p>
              </div>
            </div>
            <div class="panel">
              <h3>Library scope</h3>
              <div class="list" id="artifact-history">
                <p class="empty">No indexed artifacts loaded.</p>
              </div>
            </div>
            <div class="panel">
              <h3>Inspector</h3>
              <div class="list ui-diff-view cloud-artifact-review" id="artifact-detail" aria-label="Artifact metadata" data-diff-view="true">
                <p class="empty">Choose Inspect on an artifact to load metadata.</p>
              </div>
            </div>
          </div>
        </section>`
}
