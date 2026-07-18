import { READ_TOOL_DEFINITIONS } from "./tool-definitions-read.ts";
import { PROPOSAL_TOOL_DEFINITIONS } from "./tool-definitions-proposal.ts";
import { WRITE_TOOL_DEFINITIONS } from "./tool-definitions-write.ts";

export { READ_TOOL_DEFINITIONS } from "./tool-definitions-read.ts";
export { PROPOSAL_TOOL_DEFINITIONS } from "./tool-definitions-proposal.ts";
export { WRITE_TOOL_DEFINITIONS } from "./tool-definitions-write.ts";

export const TOOL_DEFINITIONS = [...READ_TOOL_DEFINITIONS, ...PROPOSAL_TOOL_DEFINITIONS, ...WRITE_TOOL_DEFINITIONS];
