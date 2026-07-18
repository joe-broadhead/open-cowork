import { DEFAULT_OPENWIKI_SEARCH_CONFIG, type OpenWikiSearchConfig, type SearchPersona, type SearchRetriever } from "@openwiki/core";
import { SEARCH_PERSONAS, type ResolvedSearchConfig } from "./types.ts";

export function resolveSearchConfig(config: OpenWikiSearchConfig | undefined): ResolvedSearchConfig {
  const defaults = DEFAULT_OPENWIKI_SEARCH_CONFIG;
  const enabled_retrievers = { ...defaults.enabled_retrievers, ...(config?.enabled_retrievers ?? {}) };
  const embedding = {
    ...defaults.embedding,
    ...(config?.embedding ?? {}),
  };
  const persona_weights = Object.fromEntries(
    SEARCH_PERSONAS.map((persona) => [
      persona,
      {
        ...defaults.persona_weights[persona],
        ...(config?.persona_weights?.[persona] ?? {}),
      },
    ]),
  ) as Record<SearchPersona, Record<SearchRetriever, number>>;

  return {
    default_persona: config?.default_persona ?? defaults.default_persona,
    default_limit: positiveInteger(config?.default_limit, defaults.default_limit),
    max_limit: positiveInteger(config?.max_limit, defaults.max_limit),
    max_query_length: positiveInteger(config?.max_query_length, defaults.max_query_length),
    overfetch: positiveInteger(config?.overfetch, defaults.overfetch),
    rrf_k: positiveNumber(config?.rrf_k, defaults.rrf_k),
    ngram_min: positiveInteger(config?.ngram_min, defaults.ngram_min),
    fuzzy_min_length: positiveInteger(config?.fuzzy_min_length, defaults.fuzzy_min_length),
    fuzzy_mid_length: positiveInteger(config?.fuzzy_mid_length, defaults.fuzzy_mid_length),
    fuzzy_max_distance: positiveInteger(config?.fuzzy_max_distance, defaults.fuzzy_max_distance),
    embedding: {
      enabled: Boolean(embedding.enabled),
      provider: embedding.provider === "local" ? embedding.provider : defaults.embedding.provider,
      model: nonEmptyString(embedding.model, defaults.embedding.model),
      dimensions: positiveInteger(embedding.dimensions, defaults.embedding.dimensions),
      max_chunk_characters: positiveInteger(embedding.max_chunk_characters, defaults.embedding.max_chunk_characters),
      chunk_overlap_characters: nonNegativeInteger(embedding.chunk_overlap_characters, defaults.embedding.chunk_overlap_characters),
      batch_size: positiveInteger(embedding.batch_size, defaults.embedding.batch_size),
      rebuild: embedding.rebuild === "manual" || embedding.rebuild === "index" ? embedding.rebuild : defaults.embedding.rebuild,
    },
    enabled_retrievers,
    persona_weights,
  };
}

export function positiveInteger(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : fallback;
}

function positiveNumber(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

function nonNegativeInteger(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : fallback;
}

function nonEmptyString(value: string | undefined, fallback: string): string {
  return typeof value === "string" && value.trim().length > 0 ? value : fallback;
}
