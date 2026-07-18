

export const PROMPT_DEFINITIONS = [
  {
    name: "answer_with_citations",
    title: "Answer With Citations",
    description: "Search OpenWiki and answer only from cited records.",
    arguments: [
      { name: "question", description: "The user question to answer.", required: true },
      { name: "persona", description: "Optional search persona such as researcher or reviewer.", required: false },
    ],
  },
  {
    name: "research_topic",
    title: "Research Topic",
    description: "Research a topic through OpenWiki pages, claims, sources, and open questions.",
    arguments: [{ name: "topic", description: "The topic to research.", required: true }],
  },
  {
    name: "review_edit",
    title: "Review Edit",
    description: "Review a proposed OpenWiki edit against sources, claims, and validation artifacts.",
    arguments: [{ name: "proposal_id", description: "The proposal ID to review.", required: true }],
  },
  {
    name: "ingest_source",
    title: "Ingest Source",
    description: "Convert an external artifact into a safe OpenWiki source proposal or ingestion request.",
    arguments: [
      { name: "title", description: "The source title.", required: true },
      { name: "url", description: "Optional source URL.", required: false },
    ],
  },
  {
    name: "create_synthesis_page",
    title: "Create Synthesis Page",
    description: "Create a cited synthesis page proposal from OpenWiki evidence.",
    arguments: [
      { name: "title", description: "The page title.", required: true },
      { name: "source_ids", description: "Comma-separated supporting source IDs.", required: false },
    ],
  },
  {
    name: "compare_sources",
    title: "Compare Sources",
    description: "Compare two or more OpenWiki sources and identify agreement, gaps, and contradictions.",
    arguments: [{ name: "source_ids", description: "Comma-separated source IDs to compare.", required: true }],
  },
  {
    name: "find_contradictions",
    title: "Find Contradictions",
    description: "Look for conflicting claims or stale evidence around a page, topic, or claim.",
    arguments: [{ name: "target", description: "A page ID, claim ID, or topic.", required: true }],
  },
  {
    name: "prepare_briefing",
    title: "Prepare Briefing",
    description: "Prepare a concise briefing grounded in OpenWiki evidence and recent changes.",
    arguments: [
      { name: "topic", description: "The briefing topic.", required: true },
      { name: "audience", description: "Optional intended audience.", required: false },
    ],
  },
];
