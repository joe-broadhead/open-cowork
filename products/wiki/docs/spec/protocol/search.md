# Search

## 11. Search Protocol

Search is a first-class protocol area. OpenWiki search follows the same broad
pattern as dbt-nova: deterministic lexical search first, optional semantic
retrievers, weighted RRF fusion, optional reranking, and explainable score
adjustments.

### 11.1 Search Philosophy

1. BM25/full-text first.
2. Graph and metadata signals second.
3. Embeddings third.
4. Reranking is optional and bounded.
5. Permissions are filters, not ranking signals.
6. Final ordering must be deterministic.

Vector search must never become the source of truth. It only contributes
candidates and ranking evidence.

### 11.2 Search Request

```json
{
  "query": "agent memory",
  "types": ["page", "source", "claim"],
  "persona": "researcher",
  "limit": 20,
  "offset": 0,
  "mode": "hybrid",
  "fuzzy": false,
  "include_highlights": true,
  "include_explain": true,
  "filters": {
    "topics": ["agents"],
    "status": ["active", "published"],
    "updated_after": "2026-01-01T00:00:00Z"
  }
}
```

### 11.3 Search Response

```json
{
  "results": [
    {
      "id": "page:concept:agent-memory",
      "type": "page",
      "title": "Agent Memory",
      "summary": "Overview of memory systems used by AI agents.",
      "url": "https://wiki.example.com/concepts/agent-memory",
      "uri": "openwiki://page/concept/agent-memory",
      "score": 0.91,
      "matched_fields": ["title", "summary", "body"],
      "citations": [
        {
          "source_id": "source:2026-05-21-001",
          "title": "Agent Memory Survey",
          "url": "https://example.com/agent-memory"
        }
      ],
      "updated_at": "2026-05-21T10:00:00Z",
      "highlights": {
        "title": ["Agent Memory"],
        "body": ["Overview of memory systems used by AI agents."]
      },
      "explain": {
        "retrieval": {
          "total_score": 0.0712,
          "retrievers": {
            "bm25": { "rank": 1, "score": 0.0164 },
            "ngram": { "rank": 3, "score": 0.0159 },
            "graph": { "rank": 2, "score": 0.0161 }
          }
        },
        "ranking_signals": {
          "source_reliability": 1.05,
          "citation_density": 1.1,
          "staleness_factor": 1.0
        },
        "final_score": 0.91
      }
    }
  ],
  "count": 1,
  "total": 1,
  "truncated": false,
  "persona": "researcher",
  "explain": {
    "query_tokens": ["agent", "memory"],
    "mode": "hybrid",
    "fuzzy": false,
    "rrf": {
      "enabled": true,
      "k": 60,
      "overfetch": 3,
      "fetch_limit": 60
    },
    "retrievers_used": ["exact", "bm25", "ngram", "graph"],
    "retriever_stats": {
      "bm25": { "enabled": true, "weight": 1.0, "candidate_count": 12 },
      "graph": { "enabled": true, "weight": 1.2, "candidate_count": 8 }
    },
    "ranking_signals": [
      "source_reliability",
      "citation_density",
      "claim_confidence",
      "decision_support"
    ],
    "reranker": {
      "enabled": false,
      "applied": false,
      "top_n": 0
    }
  }
}
```

### 11.4 Indexed Record Types

Search MUST support:

- pages
- source records
- source fragments when available
- claims
- proposals
- decisions
- recent changes
- durable events

Source fragment records are derived index records. They use IDs such as
`fragment:source:2026-05-21-001:0001`, cite their parent source, and are
rebuilt from captured source content. They are not canonical Git ledger records.

Search SHOULD index these fields:

| Field | Purpose |
| --- | --- |
| `title` | Highest-value human label. |
| `slug` | Exact page lookup and URL matching. |
| `aliases` | Alternate terms and redirects. |
| `summary` | Short semantic description. |
| `body` | Page content. |
| `headings` | Section-level navigation. |
| `topics` | Domain routing. |
| `claims` | Claim text and claim labels. |
| `sources` | Source titles, authors, URLs, and excerpts. |
| `path` | File path and repo structure. |
| `decisions` | Governance and rationale discovery. |

### 11.5 Retrieval Channels

OpenWiki defines retrieval channels, not one fixed engine.

Required channels:

- `bm25`: keyword full-text ranking.
- `exact`: exact ID, URI, title, slug, alias, path, and source URL matches.
- `graph`: link, citation, backlink, and claim-source graph signals.

Recommended local channels:

- `ngram`: trigram or token n-gram recall for partial terms.
- `fuzzy`: edit-distance recall, request-gated.

Optional semantic channels:

- `dense`: dense vector retrieval.
- `sparse`: sparse embedding retrieval.
- `reranker`: cross-encoder or LLM reranker over top-N fused results.

Optional governance channels:

- `source_reliability`: source quality and trust.
- `citation_density`: density and freshness of supporting citations.
- `claim_confidence`: claim-level confidence and verification status.
- `decision_support`: presence of accepted decision records.

### 11.6 Fusion Pipeline

Search engines MUST implement this logical pipeline even if some channels are
disabled:

1. Validate query, filters, scopes, and pagination.
2. Resolve actor permissions.
3. Tokenize and normalize the query.
4. Run exact lookup.
5. Run BM25/full-text retrieval.
6. Run optional n-gram and fuzzy retrieval.
7. Run optional graph retrieval.
8. Run optional dense and sparse retrieval.
9. Overfetch per channel.
10. Fuse ranked lists with weighted RRF.
11. Apply bounded metadata and governance adjustments.
12. Optionally rerank top-N fused results.
13. Sort deterministically.
14. Return explain data when requested.

When `include_explain` is true, implementations SHOULD return both per-result
retrieval contributions and a response-level pipeline snapshot. The snapshot
SHOULD include query tokens, active mode, RRF settings, retrievers used,
per-retriever candidate counts and persona weights, bounded ranking signals,
and reranker status. This mirrors the dbt-nova search debugging model and makes
agent behavior auditable.

Permissions MUST be applied before returning results. Engines MAY apply
permission filters before retrieval, after retrieval, or both, but unauthorized
records MUST NOT appear in results or explain payloads.

### 11.7 Weighted RRF

Default fusion uses weighted Reciprocal Rank Fusion.

```text
rrf_score(record, channel) = channel_weight / (k + rank + 1)
final_retrieval_score(record) = sum(rrf_score(record, channel))
```

Where:

- `rank` is 0-based within a channel.
- `k` defaults to `60`.
- `channel_weight` is selected from the active persona profile.
- Missing channels contribute `0`.

Default settings:

```json
{
  "enable_rrf": true,
  "rrf_k": 60,
  "overfetch": 3,
  "default_limit": 20,
  "max_page_size": 200,
  "max_query_length": 2000,
  "rerank_top_n": 20
}
```

### 11.8 Persona Weights

Personas adjust weights without changing the record contract.

Initial personas:

- `default`
- `researcher`
- `editor`
- `reviewer`
- `governance`

Initial weights:

| Channel | Default | Researcher | Editor | Reviewer | Governance |
| --- | ---: | ---: | ---: | ---: | ---: |
| exact | 2.0 | 1.8 | 2.4 | 1.8 | 1.8 |
| bm25 | 1.0 | 1.0 | 1.3 | 1.0 | 1.1 |
| ngram | 0.8 | 0.9 | 1.0 | 0.8 | 0.8 |
| fuzzy | 0.6 | 0.7 | 0.8 | 0.6 | 0.6 |
| graph | 1.0 | 1.2 | 0.9 | 1.2 | 1.3 |
| dense | 1.0 | 1.4 | 0.8 | 1.0 | 1.0 |
| sparse | 1.0 | 1.2 | 0.9 | 1.1 | 1.2 |
| source_reliability | 1.0 | 1.3 | 1.0 | 1.4 | 1.4 |
| citation_density | 1.0 | 1.2 | 1.0 | 1.3 | 1.4 |
| claim_confidence | 1.0 | 1.2 | 1.0 | 1.4 | 1.5 |
| decision_support | 1.0 | 1.0 | 1.0 | 1.4 | 1.6 |

The values are draft defaults. They MUST be configurable.

### 11.9 Deterministic Sorting

After all scoring:

1. Sort by final score descending.
2. Then by citation/support score descending.
3. Then by `updated_at` descending.
4. Then by canonical ID ascending.

Tie-breaking MUST NOT depend on map iteration order, database physical order, or
parallel execution timing.

### 11.10 Search Deployment Profiles

Local mode:

- SQLite FTS5 for BM25.
- SQLite tables for graph and metadata.
- Optional local embeddings.
- Weighted RRF in TypeScript.

Static mode:

- Generated JSON/JSONL indexes.
- Pagefind or Minisearch for browser-side search.
- Precomputed graph, claim, and source metadata.
- No live write operations.

Small hosted mode:

- Postgres full-text search.
- Optional pgvector. Until a pgvector adapter is enabled, Postgres search MUST
  report vector retrieval as unsupported while still storing derived chunks and
  embedding metadata for future rebuilds.
- Postgres-backed job queue.
- Object storage for large source files.

Enterprise mode:

- Postgres for metadata.
- OpenSearch, Meilisearch, or Typesense for keyword search.
- pgvector, Qdrant, Weaviate, or equivalent for embeddings if enabled.
- Object storage and worker pools.
