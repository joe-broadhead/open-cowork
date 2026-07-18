import { type ClaimRecord, type OpenWikiApprovalRuleRecord, type OpenWikiConfig, type OpenWikiGrantRecord, type OpenWikiSectionRecord } from "@openwiki/core";

export type WorkspaceTemplateName = "team-wiki" | "basic" | "personal-wiki" | "company-wiki" | "public-encyclopedia" | "github-pages";

export interface CreateWorkspaceOptions {
  title?: string;
  template?: WorkspaceTemplateName;
}

interface WorkspaceTemplateSpec {
  name: WorkspaceTemplateName;
  description: string;
  runtimeProfile?: NonNullable<OpenWikiConfig["runtime"]>["profile"];
  policy?: WorkspaceTemplatePolicy;
  source: {
    title: string;
    sourceType: string;
    reliability: string;
    sensitivity: string;
  };
  pages: WorkspaceTemplatePage[];
}

interface WorkspaceTemplatePolicy {
  sections: OpenWikiSectionRecord[];
  grants: OpenWikiGrantRecord[];
  approvalRules: OpenWikiApprovalRuleRecord[];
}

interface WorkspaceTemplatePage {
  pageType: string;
  slug: string;
  title: string;
  summary: string;
  status: string;
  topics: string[];
  body: string;
  claim: string;
  confidence?: ClaimRecord["confidence"];
  risk?: ClaimRecord["risk"];
}

/** Workspace templates available through `openwiki init --template`. */
export const WORKSPACE_TEMPLATES: Record<WorkspaceTemplateName, WorkspaceTemplateSpec> = {
  basic: {
    name: "basic",
    description: "Minimal local OpenWiki starter.",
    source: {
      title: "OpenWiki Protocol Draft",
      sourceType: "manual",
      reliability: "medium",
      sensitivity: "public",
    },
    pages: [
      {
        pageType: "concept",
        slug: "agent-memory",
        title: "Agent Memory",
        summary: "Overview of memory systems used by AI agents.",
        status: "draft",
        topics: ["agents", "memory"],
        claim:
          "OpenWiki stores agent-readable knowledge as cited pages, sources, claims, proposals, decisions, and Git history.",
        body: [
          "Agent memory is the set of durable context, retrieved knowledge, and working state an agent can use across a task or across sessions.",
          "",
          "OpenWiki stores memory as cited pages, sources, claims, proposals, decisions, and Git history so humans and agents can inspect why a statement exists.",
          "",
          "## Open Questions",
          "",
          "- How should OpenWiki rank disputed claims?",
        ].join("\n"),
      },
    ],
  },
  "personal-wiki": {
    name: "personal-wiki",
    description: "Personal knowledge base with projects, concepts, and open questions.",
    source: {
      title: "Personal OpenWiki Starter Notes",
      sourceType: "manual",
      reliability: "medium",
      sensitivity: "private",
    },
    pages: [
      {
        pageType: "concept",
        slug: "personal-knowledge-base",
        title: "Personal Knowledge Base",
        summary: "Operating notes for a personal OpenWiki workspace.",
        status: "draft",
        topics: ["personal", "knowledge"],
        claim: "A personal OpenWiki can track durable notes, cited sources, decisions, and open questions.",
        body: [
          "Use this workspace to keep cited notes, decisions, recurring research, and durable context that should survive individual agent sessions.",
          "",
          "Start by turning important files, web pages, and conversations into source records before making durable claims.",
          "",
          "## Open Questions",
          "",
          "- Which recurring topics should become dedicated pages?",
        ].join("\n"),
      },
      {
        pageType: "project",
        slug: "active-projects",
        title: "Active Projects",
        summary: "A starting index for ongoing work and project context.",
        status: "draft",
        topics: ["projects"],
        claim: "Project pages should link decisions, sources, and follow-up questions in one durable context.",
        body: [
          "Track each active project with its goals, source material, decisions, and next questions.",
          "",
          "Use proposal reviews when an agent suggests changing durable project context.",
        ].join("\n"),
      },
      {
        pageType: "meeting",
        slug: "meetings",
        title: "Meetings",
        summary: "Index and conventions for transcript-derived meeting pages.",
        status: "draft",
        topics: ["meetings", "transcripts"],
        claim: "Meeting pages should separate transcript facts, agent interpretation, sources, action items, decisions, and open questions.",
        body: [
          "Use one meeting page per durable meeting or transcript when the content should be reviewable later.",
          "",
          "Meeting pages should link people, organizations, projects, topics, decisions, action items, and source IDs.",
          "",
          "Keep transcript facts separate from agent interpretation. Missing dates, attendees, owners, and due dates should become open questions instead of guesses.",
        ].join("\n"),
      },
      {
        pageType: "person",
        slug: "people",
        title: "People",
        summary: "Index for people mentioned in meetings, sources, and projects.",
        status: "draft",
        topics: ["people", "relationships"],
        claim: "People pages should only record roles, relationships, responsibilities, and commitments when evidence states them.",
        body: [
          "Use people pages for evidence-backed context about collaborators, customers, vendors, and stakeholders.",
          "",
          "Agents should search existing people pages before proposing new ones and should preserve uncertainty when identity is ambiguous.",
        ].join("\n"),
      },
      {
        pageType: "organization",
        slug: "organizations",
        title: "Organizations",
        summary: "Index for companies, teams, vendors, customers, and groups.",
        status: "draft",
        topics: ["organizations", "relationships"],
        claim: "Organization pages should collect source-backed relationships, projects, decisions, and open questions.",
        body: [
          "Use organization pages for companies, teams, vendors, customers, and groups that recur across meetings or sources.",
          "",
          "Link organization pages to people, projects, meetings, decisions, and source records.",
        ].join("\n"),
      },
      {
        pageType: "topic",
        slug: "open-questions",
        title: "Open Questions",
        summary: "Questions and ambiguities that should not be turned into facts yet.",
        status: "draft",
        topics: ["questions", "uncertainty"],
        claim: "Open questions preserve uncertainty until a source or human review can resolve it.",
        body: [
          "Use this page to keep unresolved ambiguities from meetings, transcripts, research, and projects.",
          "",
          "Agents should add missing owners, dates, attendee identity conflicts, unclear decisions, and unsupported inferences here instead of inventing facts.",
        ].join("\n"),
      },
    ],
  },
  "team-wiki": teamWorkspaceTemplate("team-wiki"),
  "company-wiki": teamWorkspaceTemplate("company-wiki"),
  "public-encyclopedia": {
    name: "public-encyclopedia",
    description: "Public, citation-first wiki starter.",
    source: {
      title: "Public Encyclopedia Starter Notes",
      sourceType: "manual",
      reliability: "medium",
      sensitivity: "public",
    },
    pages: [
      {
        pageType: "reference",
        slug: "citation-guidelines",
        title: "Citation Guidelines",
        summary: "Starter guidance for public OpenWiki citation quality.",
        status: "published",
        topics: ["citations", "public"],
        claim: "Public OpenWiki pages should make citations, claims, history, and open questions inspectable.",
        body: [
          "Public pages should be written for humans and agents, with adjacent JSON, Markdown, sources, claims, history, and proposal context.",
          "",
          "Prefer stable primary sources and record uncertainty when evidence is incomplete.",
          "",
          "## Open Questions",
          "",
          "- Which source reliability labels should public reviewers use first?",
        ].join("\n"),
      },
      {
        pageType: "concept",
        slug: "open-knowledge-protocol",
        title: "Open Knowledge Protocol",
        summary: "A public-facing overview of protocol-first knowledge infrastructure.",
        status: "published",
        topics: ["protocol", "agents"],
        claim: "Protocol-first knowledge infrastructure lets humans, agents, scripts, and static sites consume the same records.",
        body: [
          "A protocol-first wiki defines records and operations before binding them to one application or agent runtime.",
          "",
          "This keeps public knowledge reusable through MCP, HTTP, CLI, static exports, and Git history.",
        ].join("\n"),
      },
    ],
  },
  "github-pages": {
    name: "github-pages",
    description: "Static-first public wiki starter for GitHub Pages.",
    runtimeProfile: "static",
    source: {
      title: "GitHub Pages OpenWiki Starter Notes",
      sourceType: "manual",
      reliability: "medium",
      sensitivity: "public",
    },
    pages: [
      {
        pageType: "guide",
        slug: "publishing-with-github-pages",
        title: "Publishing With GitHub Pages",
        summary: "Starter guide for static OpenWiki publishing.",
        status: "published",
        topics: ["publishing", "static"],
        claim: "GitHub Pages OpenWiki deployments publish static HTML, JSONL, OpenAPI, MCP manifests, and llms.txt artifacts.",
        body: [
          "Use static export or wiki.publish to generate machine-readable artifacts for GitHub Pages.",
          "",
          "Static deployments can support read and search through generated assets while using issues, pull requests, or external workers for suggestions.",
          "",
          "## Open Questions",
          "",
          "- Which public proposal channel should this wiki use first?",
        ].join("\n"),
      },
    ],
  },
};

function teamWorkspaceTemplate(name: "team-wiki" | "company-wiki"): WorkspaceTemplateSpec {
  return {
    name,
    description: "Private team knowledge base with spaces, proposal review, and agent access.",
    policy: teamWorkspacePolicy(),
    source: {
      title: "Team OpenWiki Starter Notes",
      sourceType: "manual",
      reliability: "medium",
      sensitivity: "internal",
    },
    pages: [
      {
        pageType: "organization",
        slug: "team-knowledge-base",
        title: "Team Knowledge Base",
        summary: "A versioned, permissioned knowledge base for teams and agents.",
        status: "draft",
        topics: ["team", "knowledge", "permissions"],
        claim: "OpenWiki gives teams a versioned, permissioned knowledge base where humans and agents can search, read, and propose changes.",
        body: [
          "Use this workspace as the shared source of truth for team knowledge that should be easy to search, read, review, and improve.",
          "",
          "Humans work through the web UI. Agents use the same knowledge through MCP, HTTP, or CLI tools, with scoped permissions and proposal review.",
          "",
          "## Open Questions",
          "",
          "- Which teams should own review authority for sensitive spaces?",
        ].join("\n"),
      },
      {
        pageType: "guide",
        slug: "proposing-edits",
        title: "Proposing Edits",
        summary: "How people and agents suggest changes without rewriting trusted knowledge immediately.",
        status: "draft",
        topics: ["proposals", "review"],
        claim: "Team edits should flow through proposals so changes remain reviewable, attributable, and reversible.",
        body: [
          "Propose edits from a page when knowledge is incomplete, stale, or wrong. Reviewers can inspect the diff, discuss the rationale, and apply accepted changes.",
          "",
          "Agents should default to proposing edits. Review, apply, commit, and publish permissions should stay scoped to trusted maintainers.",
        ].join("\n"),
      },
    ],
  };
}

function teamWorkspacePolicy(): WorkspaceTemplatePolicy {
  return {
    sections: [
      {
        id: "section:team-knowledge",
        title: "Team Knowledge",
        paths: ["wiki/**", "sources/**", "claims/**", "facts/**", "takes/**", "proposals/**", "decisions/**"],
        visibility: "internal",
        description: "Default private-team space for authenticated users behind the trusted boundary.",
      },
      {
        id: "section:governance",
        title: "Governance Ledgers",
        paths: ["policy/**", "events/**", "runs/**"],
        visibility: "private",
        description: "Policy, audit events, and job runs are maintainer-visible by default.",
      },
      {
        id: "section:catchall",
        title: "Private Catch-All",
        paths: ["**"],
        visibility: "private",
        description: "Default private fallback so unmatched paths do not produce policy warnings.",
      },
    ],
    grants: [
      { principal: "group:all-users", section: "section:team-knowledge", role: "viewer" },
      { principal: "group:knowledge-contributors", section: "section:team-knowledge", role: "contributor" },
      { principal: "group:knowledge-reviewers", section: "section:team-knowledge", role: "reviewer" },
      { principal: "group:knowledge-maintainers", section: "section:team-knowledge", role: "maintainer" },
      { principal: "group:knowledge-admins", section: "section:governance", role: "admin" },
      { principal: "group:knowledge-maintainers", section: "section:governance", role: "maintainer" },
    ],
    approvalRules: [
      {
        id: "approval:team-default",
        paths: ["wiki/**", "sources/**", "claims/**", "facts/**", "takes/**"],
        required_reviewers: [{ principal: "group:knowledge-reviewers", role: "reviewer" }],
        require_separate_actor: true,
      },
      {
        id: "approval:policy",
        paths: ["policy/**"],
        required_reviewers: [{ principal: "group:knowledge-admins", role: "admin" }],
        require_separate_actor: true,
      },
    ],
  };
}

/** Normalize legacy string init input and modern template options. */
export function workspaceOptions(titleOrOptions: string | CreateWorkspaceOptions): Required<CreateWorkspaceOptions> {
  if (typeof titleOrOptions === "string") {
    return { title: titleOrOptions, template: "basic" };
  }
  const template = titleOrOptions.template ?? "basic";
  if (!(template in WORKSPACE_TEMPLATES)) {
    throw new Error(`Unknown OpenWiki template: ${template}`);
  }
  return { title: titleOrOptions.title ?? "OpenWiki", template };
}

/** Render a seed page for a freshly initialized workspace template. */
export function renderTemplatePage(
  page: WorkspaceTemplatePage,
  ids: { now: string; sourceId: string; claimId: string; pageId: string },
): string {
  return [
    "---",
    `id: ${ids.pageId}`,
    `type: ${page.pageType}`,
    `title: ${page.title}`,
    `summary: ${page.summary}`,
    `status: ${page.status}`,
    "topics:",
    ...page.topics.map((topic) => `  - ${topic}`),
    "source_ids:",
    `  - ${ids.sourceId}`,
    "claim_ids:",
    `  - ${ids.claimId}`,
    `created_at: ${ids.now}`,
    `updated_at: ${ids.now}`,
    "---",
    "",
    `# ${page.title}`,
    "",
    page.body.trim(),
    "",
  ].join("\n");
}

export function pluralizePageType(pageType: string): string {
  if (pageType === "entity") {
    return "entities";
  }
  if (pageType === "person") {
    return "people";
  }
  if (pageType.endsWith("s")) {
    return pageType;
  }
  return `${pageType}s`;
}

/** Default permissive local policy used when a workspace has no policy files yet. */
export function defaultPolicyBundle(): WorkspaceTemplatePolicy {
  return {
    sections: defaultPolicySections(),
    grants: defaultPolicyGrants(),
    approvalRules: defaultApprovalRules(),
  };
}

export function defaultPolicySections(): OpenWikiSectionRecord[] {
  return [
    {
      id: "section:all",
      title: "All Workspace Content",
      paths: ["**"],
      visibility: "public",
      description: "Default permissive local section. Production workspaces should replace this with explicit team sections.",
    },
  ];
}

export function defaultPolicyGrants(): OpenWikiGrantRecord[] {
  return [{ principal: "group:all-users", section: "section:all", role: "maintainer" }];
}

export function defaultApprovalRules(): OpenWikiApprovalRuleRecord[] {
  return [];
}
