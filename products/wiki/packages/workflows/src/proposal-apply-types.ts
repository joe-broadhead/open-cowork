import type { ProposalRecord, ValidationReport } from "@openwiki/core";
import type { RepositoryValidationReport } from "@openwiki/validation";

export interface ApplyProposalInput {
  root: string;
  proposalId: string;
  actorId?: string;
  commit?: boolean;
  message?: string;
}

export interface ApplyProposalRebaseResult {
  performed: boolean;
  strategy: "append_jsonl";
  paths: string[];
  appended_record_ids: string[];
}

export interface ApplyProposalResult {
  proposal: ProposalRecord;
  applied_paths: string[];
  validation: ValidationReport | null;
  repository_validation: RepositoryValidationReport;
  commit?: string;
  rebase?: ApplyProposalRebaseResult;
}
