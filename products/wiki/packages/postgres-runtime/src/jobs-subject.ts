import type { OpenWikiSectionVisibility } from "@openwiki/core";

export function optionalRunSubjectPaths(runType: string, explicitPaths: string[] | undefined): { subject_paths: string[] } | {} {
  const subjectPaths = runSubjectPaths(runType, explicitPaths);
  return subjectPaths === undefined ? {} : { subject_paths: subjectPaths };
}

export function optionalEventSubjectPaths(runType: string, explicitPaths: string[] | undefined): { subject_paths: string[] } | {} {
  const subjectPaths = runSubjectPaths(runType, explicitPaths);
  return subjectPaths === undefined ? {} : { subject_paths: subjectPaths };
}

export function optionalRunSensitivity(runType: string): { sensitivity: OpenWikiSectionVisibility } | {} {
  const sensitivity = runSensitivity(runType);
  return sensitivity === undefined ? {} : { sensitivity };
}

export function optionalEventSensitivity(runType: string): { sensitivity: OpenWikiSectionVisibility } | {} {
  const sensitivity = runSensitivity(runType);
  return sensitivity === undefined ? {} : { sensitivity };
}

export function runSubjectPaths(runType: string, explicitPaths: string[] | undefined): string[] | undefined {
  const paths = [...(explicitPaths ?? []), ...(runType === "source.fetch" ? ["sources/manifests", "sources/raw"] : [])]
    .map((entry) => entry.trim())
    .filter((entry, index, values) => entry.length > 0 && values.indexOf(entry) === index);
  return paths.length === 0 ? undefined : paths;
}

export function runSensitivity(runType: string): OpenWikiSectionVisibility | undefined {
  return runType === "source.fetch" ? "internal" : undefined;
}

// postgres.js types the in-transaction handle (passed to `sql.begin`) as a distinct generic
// instantiation that does not structurally unify with PostgresSql, even though both accept the
// same tagged-template queries. Narrow it once, here, instead of at every transaction call site.
