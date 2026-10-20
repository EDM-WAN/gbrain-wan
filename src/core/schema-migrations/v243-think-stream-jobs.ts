import type { Migration } from './types.ts';

// Local port: durable storage for the /think/stream SSE route
// (src/commands/serve-http-think-stream.ts). Upstream 0.60 has no streaming
// think route, so this table does not exist there. On a brain upgraded from
// the 0.48 line the table was created by that line's migration 146 and this
// migration is a no-op (CREATE TABLE IF NOT EXISTS); on a fresh 0.60 install
// it is the only place the table is created, so the copy also lives in
// src/schema.sql for fresh installs.
export const v243: Migration = {
  version: 243,
  name: 'think_stream_jobs',
  idempotent: true,
  sql: `
    CREATE TABLE IF NOT EXISTS think_stream_jobs (
      id TEXT PRIMARY KEY,
      source_id TEXT,
      allowed_sources JSONB,
      status TEXT NOT NULL DEFAULT 'running',
      stream_offset INTEGER NOT NULL DEFAULT 0,
      partial_answer TEXT NOT NULL DEFAULT '',
      retrieval JSONB,
      final_result JSONB,
      error_code TEXT,
      error_message TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      finished_at TIMESTAMPTZ,
      expires_at TIMESTAMPTZ NOT NULL DEFAULT now() + INTERVAL '1 hour',
      CONSTRAINT think_stream_jobs_status CHECK (status IN ('running','completed','failed','cancelled')),
      CONSTRAINT think_stream_jobs_offset_nonnegative CHECK (stream_offset >= 0)
    );
    CREATE INDEX IF NOT EXISTS idx_think_stream_jobs_expiry ON think_stream_jobs (expires_at);
    CREATE INDEX IF NOT EXISTS idx_think_stream_jobs_source ON think_stream_jobs (source_id, created_at DESC);
  `,
};
