# Architecture Overview

The system is composed of three services that communicate over a message bus.

## Ingestion

The ingestion service consumes events from upstream producers and validates
them against a schema registry. Invalid events are routed to a dead-letter
queue for manual inspection.

## Enrichment

Events are enriched with reference data before rule evaluation.

## Processing

The processing service evaluates business rules against validated events. It is
horizontally scalable and stateless apart from an in-memory schema cache,
which keeps deployment simple.

## Storage

Processed events are written to an append-only log and periodically compacted
into a columnar store for analytics queries.
