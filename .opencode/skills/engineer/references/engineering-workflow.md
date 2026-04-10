# Engineering Workflow Details

## Model design checklist

- Define grain and primary keys
- Ensure required dimensions exist upstream
- Avoid duplicating existing models
- Document model + columns
- Add or update tests for critical fields

## Quality expectations

- Column docs for key metrics
- Tests for primary keys, not-null, and relationships
- Metadata completeness for domains, measures, and use cases

## Recommended sequence

1) Discover relevant models
2) Validate upstream dependencies
3) Draft new model spec
4) Evaluate impact
5) Add tests + metadata
6) Confirm readiness score
