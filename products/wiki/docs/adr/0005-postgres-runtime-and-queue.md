# ADR 0005: Postgres Runtime And Queue

Date: 2026-05-29

## Status

Accepted

## Context

Single-user and static deployments can run entirely from Git plus local derived
indexes. Hosted deployments need concurrent readers, job visibility, durable
write coordination, service-account records, and operational queues.

## Decision

Postgres is an optional runtime adapter, not the canonical wiki store. It holds
derived records, search data, identity/runtime rows, write leases, and the job
queue. Git records remain canonical and Postgres can be rebuilt or reconciled
from repository state.

## Consequences

- Hosted deployments can scale read and job surfaces without changing the file
  protocol.
- Runtime migrations must preserve rebuildability and versioned schema
  metadata.
- Database JSON row reads need runtime validation before casting into protocol
  record types.
- Operators need backup and restore guidance for both Git and Postgres runtime
  state.
