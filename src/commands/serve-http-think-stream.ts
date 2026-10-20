/**
 * `/think/stream` — SSE streaming chat (local port from the 0.48 line).
 *
 * Upstream 0.60 has no streaming think route; gbrain-web's chat console drives
 * its live answer through these three endpoints. The stream is durable: each
 * job row in `think_stream_jobs` carries the partial answer + retrieval so a
 * client that reconnects can resume from `stream_offset` instead of losing the
 * response.
 *
 * Scope rule (the reason this module exists at all): an EXPLICIT `source_id` is
 * the caller's request (the chat dropdown's "this source") and must not be
 * widened by the caller's federated `allowedSources` grant — a global-access
 * OAuth client resolves that array to EVERY active source at verify-time, and
 * the array-wins ladder in gather then hijacked the pick and searched the whole
 * brain. Mirrors the op-layer `resolveRequestedScope` precedence: explicit pick
 * → scalar-only; otherwise the caller's grant.
 */
import type { Express, Request, Response } from 'express';
import express from 'express';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import type { AuthInfo } from '../core/ops/contract.ts';
import type { BrainEngine } from '../core/engine.ts';
import type { OAuthTokenVerifier } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import { embedQuery } from '../core/embedding.ts';
import { GBRAIN_SOURCE_SCOPE_HEADER, narrowAllowedSources } from '../mcp/request-scope.ts';

export interface ThinkStreamDeps {
  engine: BrainEngine;
  resourceVerifier: OAuthTokenVerifier;
  resourceMetadataUrl: string;
}

export function mountThinkStream(app: Express, deps: ThinkStreamDeps): void {
  const { engine, resourceVerifier, resourceMetadataUrl } = deps;
  const requireAuth = requireBearerAuth({ verifier: resourceVerifier, resourceMetadataUrl });

  /**
   * Read authority for a stream job. A job with no recorded source is readable
   * by anyone the bearer check admitted (it was scoped by the caller's own
   * grant at creation); a job naming a source requires that source to be inside
   * the reader's grant.
   */
  const streamJobCanRead = (job: { source_id?: string | null }, authInfo: AuthInfo | undefined): boolean => {
    if (!job.source_id) return true;
    if (!authInfo) return false;
    if (authInfo.allowedSources?.includes(job.source_id)) return true;
    if (authInfo.sourceId === job.source_id) return true;
    return authInfo.hasSourceGrant === false;
  };

  const thinkStreamControllers = new Map<string, AbortController>();

  const cleanupThinkStreamJobs = async (): Promise<void> => {
    try {
      await engine.executeRaw('DELETE FROM think_stream_jobs WHERE expires_at < now()');
    } catch { /* best effort; migration/DB startup errors must not break chat */ }
  };

  const updateThinkStreamJob = async (
    id: string,
    patch: { status?: string; offset?: number; partialAnswer?: string; retrieval?: unknown; finalResult?: unknown; errorCode?: string; errorMessage?: string },
  ): Promise<void> => {
    try {
      await engine.executeRaw(
        `UPDATE think_stream_jobs
            SET status = COALESCE($2, status),
                stream_offset = COALESCE($3, stream_offset),
                partial_answer = CASE WHEN $4 IS NULL THEN partial_answer ELSE LEFT($4, 12000) END,
                retrieval = CASE WHEN $5 IS NULL THEN retrieval ELSE $5::jsonb END,
                final_result = CASE WHEN $6 IS NULL THEN final_result ELSE $6::jsonb END,
                error_code = COALESCE($7, error_code),
                error_message = COALESCE($8, error_message),
                finished_at = CASE WHEN $2 IN ('completed','failed','cancelled') THEN now() ELSE finished_at END,
                updated_at = now()
          WHERE id = $1`,
        [id, patch.status ?? null, patch.offset ?? null, patch.partialAnswer ?? null,
          patch.retrieval == null ? null : JSON.stringify(patch.retrieval),
          patch.finalResult == null ? null : JSON.stringify(patch.finalResult),
          patch.errorCode ?? null, patch.errorMessage ?? null],
      );
    } catch { /* persistence is best effort for the stream UX */ }
  };

  // ---------------------------------------------------------------------------
  // Resume a stream: poll the stored partial answer + retrieval.
  // ---------------------------------------------------------------------------
  app.get('/think/stream/:jobId', requireAuth, async (req: Request, res: Response) => {
    await cleanupThinkStreamJobs();
    const rows = await engine.executeRaw<Record<string, unknown>>(
      'SELECT id, source_id, status, stream_offset, partial_answer, retrieval, final_result, error_code, error_message, created_at, updated_at, finished_at FROM think_stream_jobs WHERE id = $1',
      [req.params.jobId],
    );
    const authInfo = (req as { auth?: AuthInfo }).auth;
    if (rows.length === 0 || !streamJobCanRead(rows[0] as { source_id?: string | null }, authInfo)) {
      return res.status(404).json({ error: 'not_found', message: 'Stream job not found' });
    }
    return res.json(rows[0]);
  });

  // ---------------------------------------------------------------------------
  // Cancel an in-flight stream (client navigated away / hit Stop).
  // ---------------------------------------------------------------------------
  app.post('/think/stream/:jobId/cancel', express.json({ limit: '16kb' }), requireAuth, async (req: Request, res: Response) => {
    const rows = await engine.executeRaw<{ id: string; source_id: string | null }>(
      'SELECT id, source_id FROM think_stream_jobs WHERE id = $1',
      [req.params.jobId],
    );
    const authInfo = (req as { auth?: AuthInfo }).auth;
    if (rows.length === 0 || !streamJobCanRead(rows[0], authInfo)) {
      return res.status(404).json({ error: 'not_found', message: 'Stream job not found' });
    }
    thinkStreamControllers.get(String(req.params.jobId))?.abort();
    await updateThinkStreamJob(String(req.params.jobId), { status: 'cancelled', errorCode: 'cancelled', errorMessage: 'Cancelled by client' });
    return res.json({ status: 'cancelled' });
  });

  // ---------------------------------------------------------------------------
  // Start a stream: SSE with retrieval → delta… → done.
  // ---------------------------------------------------------------------------
  app.post('/think/stream', express.json({ limit: '256kb' }), requireAuth, async (req: Request, res: Response) => {
    const verifiedAuthInfo = (req as { auth?: AuthInfo }).auth;
    // Same narrow-only per-request read scope as /mcp (see mcp/request-scope.ts):
    // the header can only shrink the granted set, never widen it, and
    // an unmatched request fails closed. Without this a shared-client front end
    // cannot scope synthesis per user.
    const narrowed = narrowAllowedSources(
      verifiedAuthInfo?.allowedSources,
      req.get(GBRAIN_SOURCE_SCOPE_HEADER),
    );
    const authInfo: AuthInfo | undefined = verifiedAuthInfo === undefined
      ? undefined
      : narrowed === undefined ? verifiedAuthInfo : { ...verifiedAuthInfo, allowedSources: narrowed };
    const body = (req.body ?? {}) as Record<string, unknown>;
    const question = typeof body.question === 'string' ? body.question.trim() : '';
    if (!question) return res.status(400).json({ error: 'invalid_params', message: 'question is required' });

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
    res.write(': connected\n\n');

    const emit = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    const abort = new AbortController();
    req.on('close', () => abort.abort());

    const jobId = `think-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    thinkStreamControllers.set(jobId, abort);
    await cleanupThinkStreamJobs();
    try {
      await engine.executeRaw(
        `INSERT INTO think_stream_jobs (id, source_id, allowed_sources, status)
         VALUES ($1, $2, $3::jsonb, 'running')`,
        [jobId, typeof body.source_id === 'string' ? body.source_id : null, JSON.stringify(authInfo?.allowedSources ?? [])],
      );
    } catch { /* old brain without migration: stream still works in-memory */ }
    emit('start', { status: 'running', job_id: jobId });

    let partialAnswer = '';
    try {
      const { runThink } = await import('../core/think/index.ts');
      const sourceId = typeof body.source_id === 'string' ? body.source_id : undefined;
      // Scalar-wins: an explicit pick must not be widened by the federated grant.
      const allowedSources = sourceId === undefined ? authInfo?.allowedSources : undefined;
      const result = await runThink(engine, {
        question,
        retrievalQuery: typeof body.retrieval_query === 'string' ? body.retrieval_query : undefined,
        conversationContext: typeof body.conversation_context === 'string' ? body.conversation_context : undefined,
        anchor: typeof body.anchor === 'string' ? body.anchor : undefined,
        since: typeof body.since === 'string' ? body.since : undefined,
        until: typeof body.until === 'string' ? body.until : undefined,
        rounds: typeof body.rounds === 'number' ? body.rounds : undefined,
        model: typeof body.model === 'string' ? body.model : undefined,
        sourceId,
        allowedSources,
        remote: true,
        embedQuestion: (q: string) => embedQuery(q),
        abortSignal: abort.signal,
        stream: {
          onRetrieval: async (data) => { emit('retrieval', data); await updateThinkStreamJob(jobId, { retrieval: data }); },
          onDelta: async (text, offset) => {
            partialAnswer += text;
            emit('delta', { text, offset });
            if (offset % 2048 < text.length) await updateThinkStreamJob(jobId, { offset, partialAnswer });
          },
        },
      });
      await updateThinkStreamJob(jobId, { status: 'completed', offset: result.answer.length, partialAnswer: result.answer, finalResult: result });
      emit('done', { result, offset: result.answer.length });
    } catch (error) {
      if (abort.signal.aborted) {
        await updateThinkStreamJob(jobId, { status: 'cancelled', offset: partialAnswer.length, partialAnswer, errorCode: 'cancelled', errorMessage: 'Client disconnected' });
        emit('cancelled', { offset: partialAnswer.length, partial_answer: partialAnswer });
      } else {
        const message = error instanceof Error ? error.message : 'think stream failed';
        await updateThinkStreamJob(jobId, { status: 'failed', offset: partialAnswer.length, partialAnswer, errorCode: 'stream_error', errorMessage: message });
        emit('error', { code: 'stream_error', message });
      }
    } finally {
      thinkStreamControllers.delete(jobId);
      res.end();
    }
  });
}
