import { pageMutationSource, submitPageMutation, validateMutationSlug } from '../persistence/page-mutations.ts';
import { suffixedSlugDryRun } from '../persistence/suffixed-slug.ts';
import { AGENT_CONTENT_PARAMS, PAGE_MUTATION_PARAMS, CAPTURE_EVENT_PARAMS, CAPTURE_CLI_PROVENANCE_PARAMS, WRITE_WAIT_PARAM } from '../persistence/params.ts';
import { assertPurgeParams } from '../persistence/purge-params.ts';
/**
 * Page CRUD operation cluster — pure move from operations.ts (v0.46.x
 * tranche 1). Op consts stay module-private; `pagesOperations` below lists
 * them in EXACTLY the order they appear in the canonical `operations` array
 * in ../operations.ts (order is contractual — docs/TOOL_CATALOG.md is
 * generated from that array). Never import from '../operations.ts' here
 * (cycle); shared contract/context helpers come from the ops/ foundation.
 */

import { clampSearchLimit, type BrainEngine } from '../engine.ts';
import type { Page } from '../types.ts';
import { decodeDeepResearchId, deepResearchPageUrl } from '../deep-research-id.ts';
import { PageSnapshotAmbiguousError, type PageSnapshot } from '../page-state/types.ts';
import { serializePageToMarkdown } from '../markdown.ts';
import { pageTrustForRead, projectFetchText, projectGetPage, readQuarantined } from './get-page-projection.ts';
import { MIN_TRUST_PARAM } from '../eligibility/policy.ts';
import { stampRowTrust } from '../eligibility/stamp.ts';
import { isAutoLinkEnabled } from '../link-extraction.ts';
import { sanitizeRemoteBody } from '../remote-body.ts';
import { getContentFlag } from '../quarantine.ts';
import { fileHeldField, readHeldPages } from '../persistence/held-reads.ts';
import { bumpLastRetrievedAt } from '../last-retrieved.ts';
import { resolveExcludePrivatePages, isPrivatePage, findPrivateOnlySlugs } from '../search/private-visibility.ts';
import { LIST_PAGES_DESCRIPTION, CAPTURE_DESCRIPTION } from '../operations-descriptions.ts';
import { listPagesPagination, listingTruncatedNotice } from './list-pages-pagination.ts';
import { OperationError, opError, type Operation, type OperationContext } from './contract.ts';
import { hasScope } from '../scope.ts';
import { invalidParam, readFix } from './op-fix.ts';
import { isDatetimeInputError } from '../utils.ts';
import { rethrowNamingRevisionSource } from './put-page-revision-source.ts';
import {
  assertExplicitSourceLive,
  enforceSubagentSlugFence,
  slugOutsideCallerFence,
  enforceClientSlugFence,
  federatedSearchScope,
  normalizeSlugPrefix,
  parseSourceIdParam,
  readPolicyOpts,
  validatePageSlug, pageNotFoundError,
} from './context.ts';

// --- Page CRUD ---

/**
 * #4352 remediation — filter fuzzy-resolution candidates so get_page's
 * ambiguous_slug candidate list can't enumerate private slugs to an
 * untrusted caller. Probe SQL lives ONCE in findPrivateOnlySlugs (a slug
 * with at least one non-private in-scope page stays visible; candidates
 * come from resolveSlugs, so every slug has a live page row).
 * Order-preserving (resolveSlugs returns ranked candidates). Read-only,
 * scope-threaded — not a getPage/putPage pair (no unscoped-check/scoped-write
 * hazard).
 */
async function dropPrivateSlugs(
  engine: BrainEngine,
  candidates: string[],
  scope: { sourceId?: string; sourceIds?: string[] },
  includeDeleted: boolean,
): Promise<string[]> {
  const hidden = await findPrivateOnlySlugs(engine, candidates, scope, { includeDeleted });
  return candidates.filter(c => !hidden.has(c));
}

/**
 * #3625: strip the takes/private-facts fences from BOTH compiled_truth and
 * timeline before a page reaches an untrusted reader. Pre-#3625 this only
 * covered compiled_truth — a `## Facts` fence written below the
 * `<!-- timeline -->` sentinel lands in the `timeline` column (splitBody's
 * split boundary), which get_page/fetch_page returned verbatim, unstripped.
 * A private fact fence misplaced there was fully readable by any remote MCP
 * caller. Same stripping rule as compiled_truth: takes fence dropped
 * entirely, facts fence keeps only `world`-visibility rows.
 */
function stripPrivacyFencesForRemoteReader(page: Page): Page {
  const opts = { includeWithdrawn: true, keepMaterializedMarkers: true }; // #5567: markers round-trip remote edits
  return { ...page, compiled_truth: sanitizeRemoteBody(page.compiled_truth, opts), timeline: sanitizeRemoteBody(page.timeline ?? '', opts) };
}

const get_page: Operation = {
  name: 'get_page',
  idempotent: true,
  outputRedaction: { exempt: 'explicit page read by slug/id; governed by page visibility, not output redaction (CEO-17 raw-read exception)' },
  description: 'Read a page by slug. To edit, pass include_content:true and send `content` to put_page, or use edit_page.',
  params: {
    slug: { type: 'string', description: 'Page slug.', required: true },
    fuzzy: { type: 'boolean', description: 'Fuzzy slug match.' },
    include_content: { type: 'boolean', description: 'Full markdown + revision, for editing.' },
    content_only: { type: 'boolean', description: 'Round-trip fields only.' },
    include_deleted: { type: 'boolean', description: 'Include soft-deleted pages.' },
    include_timeline_entries: { type: 'boolean', description: 'Also return timeline rows.' },
    grammar_diagnostics: { type: 'boolean', description: 'Also return every line-grammar finding for the page.', fullSurfaceOnly: true },
    source_id: { type: 'string', description: "One source, or '__all__'." },
    include_quarantined: { type: 'boolean', description: 'Admin: quarantined body.' },
    min_trust: MIN_TRUST_PARAM,
  },
  handler: async (ctx, p) => {
    const slug = p.slug as string;
    const fuzzy = (p.fuzzy as boolean) || false;
    const includeDeleted = (p.include_deleted as boolean) === true;
    const includeContent = (p.include_content as boolean) === true;
    const includeTimelineEntries = (p.include_timeline_entries as boolean) === true;
    // #4329: honor a per-call source_id (pre-fix it was silently dropped).
    // resolveRequestedScope (inside federatedSearchScope) enforces the remote
    // caller's grant on the explicit value.
    const sourceIdParam = parseSourceIdParam(p.source_id, 'get_page', { allowAll: true });
    // #1393: route BOTH the exact-match read and the fuzzy resolveSlugs through
    // the canonical precedence ladder (federated array > scalar > nothing). The
    // exact path previously used scalar `ctx.sourceId` only, so a remote client
    // with a federated `allowedSources` grant (and no single ctx.sourceId) got
    // an UNSCOPED exact lookup — a cross-source read of any page by slug. getPage
    // now honors sourceIds[] (both engines), so the same scope closes both paths.
    // #3242: federatedSearchScope (not bare sourceScopeOpts) so an unqualified
    // read sees pages in `federated: true` sources, matching search/query.
    const sourceOpts = federatedSearchScope(ctx, sourceIdParam);
    // #4620: an explicit source_id must name a live source (after the grant check).
    await assertExplicitSourceLive(ctx, sourceIdParam);
    const fuzzyScope = sourceOpts;

    // #4352 remediation: untrusted callers never read `visibility: private`
    // bodies — the same resolveExcludePrivatePages gate search/recall/entity
    // already apply (trusted local + the operator opt-outs resolve to false).
    // A gated private page behaves exactly like a missing one (no existence
    // oracle), composing with — not replacing — the source-grant scope above.
    const excludePrivate = await resolveExcludePrivatePages(ctx.engine, ctx.remote);

    let snapshot = await ctx.engine.readPageSnapshot(slug, { includeDeleted, excludePrivate, ...sourceOpts, resolveAlias: true });
    let page = snapshot?.page ?? null;
    if (page && excludePrivate && isPrivatePage(page)) page = null;
    let resolved_slug: string | undefined = page && page.slug !== slug ? page.slug : undefined;

    if (!page && fuzzy) {
      const fallback = await ctx.engine.transaction(async tx => {
        await tx.executeRaw('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
        let candidates = await tx.resolveSlugs(slug, { ...fuzzyScope, excludePrivate });
        if (excludePrivate && candidates.length > 0) {
          candidates = await dropPrivateSlugs(tx, candidates, fuzzyScope, includeDeleted);
        }
        return { candidates, snapshot: candidates.length === 1
          ? await tx.readPageSnapshot(candidates[0], { includeDeleted, excludePrivate, ...sourceOpts }) : null };
      });
      if (fallback.candidates.length > 1) return { error: 'ambiguous_slug', candidates: fallback.candidates };
      if (fallback.snapshot && !(excludePrivate && isPrivatePage(fallback.snapshot.page))) {
        snapshot = fallback.snapshot;
        page = snapshot.page;
        resolved_slug = page.slug;
      }
    }

    if (!page) {
      let elsewhereSource: string | undefined;
      // #4516: source scoping is by-design isolation, but the miss diagnostic
      // should say WHERE the slug actually lives. Trusted local callers only
      // (`ctx.remote === false`) — for a remote caller the probe would be a
      // cross-source existence oracle outside its grant. Only when the lookup
      // was actually scoped (an unscoped read already spanned every source).
      if (ctx.remote === false && (sourceOpts.sourceId !== undefined || sourceOpts.sourceIds !== undefined)) {
        try {
          // gbrain-allow-unscoped-getpage: read-only diagnostic existence probe —
          // deliberately spans all sources to name where the slug lives.
          const elsewhere = await ctx.engine.getPage(slug, { includeDeleted });
          if (elsewhere && !(excludePrivate && isPrivatePage(elsewhere))) {
            elsewhereSource = elsewhere.source_id;
          }
        } catch {
          // Diagnostic only — a probe failure must never mask the real error.
        }
      }
      throw pageNotFoundError(ctx, slug, { includeDeleted, sourceIdParam, elsewhereSource });
    }
    const readable = await pageTrustForRead(ctx, page, p.min_trust); // #5575: below the read floor reads as missing
    if (!readable) throw pageNotFoundError(ctx, slug, { includeDeleted, sourceIdParam });

    // v0.37.0 (D11): op-layer write-back for the `last_retrieved_at` stale
    // signal. Fire-and-forget — caller does NOT await. Internal callers
    // (sync, migrations, dream cycle) bypass this op handler so the signal
    // stays clean. Throttled to ~1 write / 5 min per page via the SQL clause
    // inside bumpLastRetrievedAt (D2).
    bumpLastRetrievedAt(ctx.engine, [page.id]);

    // #2200: tags come from the concrete page's source: federated `sourceOpts` has no
    // scalar sourceId, and getTags would fall back to 'default' (the wrong source).
    const tags = snapshot!.tags;
    // Only explicitly trusted local reads retain protected body sections.
    // Holder grants and page-visibility opt-outs do not bypass this boundary.
    const isUntrustedReader = ctx.remote !== false;
    const visibleBody = isUntrustedReader
      ? stripPrivacyFencesForRemoteReader(page)
      : page;
    // v0.42 (#1699) agent-warning channel: surface the page's content_flag
    // marker as a top-level field (parallel to SearchResult.content_flag) so
    // an agent reading a page directly gets the same "this looks odd, examine
    // it" signal it would get from search. The marker is also in frontmatter;
    // this is the clean, documented accessor.
    const content_flag = getContentFlag(page.frontmatter as Record<string, unknown> | null);
    // #5988: sync holds the page's newer file (one indexed lookup, fail-open).
    const held = (await readHeldPages(ctx.engine, [page.id], ctx).catch(() => null))?.get(page.id);
    // #2225: `content` is the canonical serialized markdown (frontmatter +
    // compiled_truth + `<!-- timeline -->` sentinel + timeline). Clients that
    // edit-and-put_page this field round-trip losslessly; hand-concatenating
    // compiled_truth + timeline without the sentinel used to silently destroy
    // pages.timeline on the next write. Built from visibleBody so the
    // privacy-fence strip above applies to untrusted readers here too.
    // Opt-in (include_content: true): get_page is the most-called read op, and
    // `content` roughly duplicates compiled_truth + timeline — always emitting
    // it would double every reader's payload for the round-trip minority.
    const timelineEntries = includeTimelineEntries
      ? await stampRowTrust(ctx.engine, 'timeline_entries', await ctx.engine.getTimeline(page.slug, { ...await readPolicyOpts(ctx, { sourceId: page.source_id }), eligibility: readable.eligibility }), e => e.id) : undefined;
    // Read-only, over the same visibility-filtered body the reader gets.
    const lineGrammar = p.grammar_diagnostics === true ? await (await import('../line-grammar-report.ts')).lineGrammarReport(ctx.engine, { slug: page.slug, sourceId: page.source_id, body: visibleBody.compiled_truth }) : undefined;
    const quarantined = readQuarantined(ctx, page, p.include_quarantined === true); // #6259
    const projected = projectGetPage(visibleBody, {
      revision: snapshot!.revision, tags, includeContent, contentOnly: (p.content_only as boolean) === true, resolved_slug, content_flag, quarantined, trust: readable.trust,
      ...(timelineEntries ? { timeline_entries: timelineEntries } : {}),
      ...(held ? { file_held: fileHeldField(held, isUntrustedReader) } : {}),
    });
    return lineGrammar ? { ...projected, line_grammar: lineGrammar } : projected;
  },
  scope: 'read', mutating: false,
  cliHints: { name: 'get', positional: ['slug'] },
};

const fetch_page: Operation = {
  name: 'fetch',
  idempotent: true,
  outputRedaction: { exempt: 'explicit page read by slug/id; governed by page visibility, not output redaction (CEO-17 raw-read exception)' },
  description: "Fetch the full text of one search result by its opaque, source-qualified `id` (OpenAI deep-research contract: the search/fetch pair). Pass the id unchanged; it does not grant access. Legacy slug ids work only when unambiguous within your current read scope. Returns { id, title, text, url, metadata } — `text` is the page's canonical markdown. For fuzzy slugs, soft-delete recovery, or lossless edit round-trips, use get_page.",
  params: {
    id: { type: 'string', required: true, description: 'Opaque result id from a prior `search` call. Pass unchanged. Unambiguous legacy slugs are also accepted.' },
    include_quarantined: { type: 'boolean', description: 'Admin: quarantined body.' },
    min_trust: MIN_TRUST_PARAM,
  },
  handler: async (ctx, p) => {
    const id = p.id as string;
    if (typeof id !== 'string' || !id.trim()) {
      throw opError('invalid_params', 'fetch requires a non-empty id', 'Pass the `id` field from a `search` result. Search rows carry `id` only when `fetch` is callable on this connection, so a row from a search run before `fetch` was callable has none: re-run `search` now that `fetch` is callable, or pass the row\'s `slug` as `id` (accepted when it is unambiguous within your read scope).');
    }
    let identity: ReturnType<typeof decodeDeepResearchId>;
    try { identity = decodeDeepResearchId(id); }
    catch { throw opError('invalid_params', 'Invalid fetch result id', 'Pass the unchanged `id` field from a `search` result.'); }
    const slug = identity?.slug ?? id.trim();
    const missing = () => opError('page_not_found', 'Page not found', 'Pass an id returned by a current `search` call.');
    let sourceOpts: ReturnType<typeof federatedSearchScope>;
    try { sourceOpts = federatedSearchScope(ctx, identity?.sourceId); }
    catch (error) {
      if (error instanceof OperationError && error.code === 'permission_denied') throw missing();
      throw error;
    }
    if (ctx.remote !== false && sourceOpts.sourceIds === undefined && sourceOpts.sourceId === undefined) throw missing();
    if (identity) {
      if (ctx.remote !== false && (sourceOpts.sourceIds !== undefined
        ? !sourceOpts.sourceIds.includes(identity.sourceId)
        : sourceOpts.sourceId !== undefined && sourceOpts.sourceId !== identity.sourceId)) throw missing();
      sourceOpts = { sourceId: identity.sourceId };
    }
    const excludePrivate = await resolveExcludePrivatePages(ctx.engine, ctx.remote);
    let snapshot: PageSnapshot | null;
    try {
      snapshot = await ctx.engine.readPageSnapshot(slug, {
        ...sourceOpts, excludePrivate, resolveAlias: true, requireUnambiguous: identity === null, requireLiveSource: true, preserveExactIdentity: true,
      });
    } catch (error) {
      if (error instanceof PageSnapshotAmbiguousError) {
        throw opError('ambiguous_id', 'The legacy id matches multiple readable pages', 'Search again and pass the source-qualified result id.');
      }
      throw error;
    }
    const page = snapshot?.page;
    if (!page || (excludePrivate && isPrivatePage(page))) throw missing();
    const readable = await pageTrustForRead(ctx, page, p.min_trust); // #5575: below the read floor reads as missing
    if (!readable) throw missing();
    bumpLastRetrievedAt(ctx.engine, [page.id]);
    const tags = snapshot!.tags;
    // Same boundaries as get_page: untrusted readers never see takes or private facts fences, nor a quarantined body (#6259).
    const visibleBody = ctx.remote === false ? page : stripPrivacyFencesForRemoteReader(page);
    const quarantined = readQuarantined(ctx, page, p.include_quarantined === true);
    return {
      id: identity ? id : page.slug,
      title: page.title,
      text: projectFetchText(visibleBody as Page, tags, quarantined, readable.trust),
      // Pages have no public http home; a stable brain-local URI satisfies
      // the contract's citation slot without inventing a fake web URL.
      url: deepResearchPageUrl(page.source_id, page.slug),
      metadata: {
        revision: snapshot!.revision,
        type: page.type,
        source_id: page.source_id,
        updated_at: page.updated_at,
        tags, ...(quarantined ? { quarantined } : {}), ...readable.trust,
      },
    };
  },
  scope: 'read', mutating: false,
  cliHints: { name: 'fetch', positional: ['id'] },
};

const put_page: Operation = {
  name: 'put_page',
  idempotent: true,
  outputRedaction: 'no_stored_text',
  description: 'Complete content REPLACES the whole page: read get_page include_content:true; send its revision as expected_revision. Keep a request_id UUID; retry with identical arguments. Remote callers: existing-page [[links]] become mentions; typed links are skipped (stdio `gbrain serve` sweeps them later, `gbrain serve --http` does not self-sweep). Edits: edit_page; >3 pages: put_pages.',
  params: {
    ...AGENT_CONTENT_PARAMS,
    slug: { type: 'string', description: 'Page slug.', required: true },
    content: { type: 'string', required: true, description: 'Complete markdown (get_page include_content:true).' },
    allow_empty: { type: 'boolean', required: false, description: 'Allow emptying the page.' },
    drop_timeline: { type: 'boolean', required: false, description: 'No Timeline in content: delete its entries.' },
    wait_ms: WRITE_WAIT_PARAM,
    // v0.39.3.0 provenance write-through (WARN-8 + A1 + CV6). Optional fields
    // for trusted local callers (capture CLI, autopilot, dream cycle). Remote
    // MCP callers (ctx.remote !== false) have their values OVERRIDDEN with
    // server stamps below; the params are accepted on the wire only so the
    // op schema stays uniform across transports. Audit-trail spoofing is
    // closed structurally — clients cannot poison source_kind labels.
    source_kind: { type: 'string', description: 'Server-stamped remotely.', required: false },
    source_uri: { type: 'string', description: 'Server-stamped remotely.', required: false },
    ingested_via: { type: 'string', description: 'Server-stamped remotely.', required: false },
  },
  mutating: true,
  scope: 'write',
  handler: async (ctx, p) => {
    const sourceId = pageMutationSource(ctx, p, 'put_page');
    if (ctx.dryRun) {
      if (typeof p.slug === 'string') {
        validatePageSlug(p.slug);
        enforceClientSlugFence(ctx, p.slug, 'put_page');
        enforceSubagentSlugFence(ctx, p.slug, 'put_page');
        await suffixedSlugDryRun(ctx, sourceId, p.slug);
      }
      return { dry_run: true, action: 'put_page', slug: p.slug };
    }
    return submitPageMutation(ctx, { operation: 'put_page', params: p }).catch(error => rethrowNamingRevisionSource(ctx, sourceId, p, error));
  },
  cliHints: { name: 'put', positional: ['slug'], stdin: 'content' },
};

// v0.31.2: isFactsBackstopEligible moved to src/core/facts/eligibility.ts
// so sync.ts, file_upload, code_import, and runFactsBackstop all share one
// predicate. Imported above.

/** Legacy key export retained for callers; publication now uses canonical page guards. */
export function autoLinkLockKey(sourceId: string | undefined, slug: string): string {
  return `auto_link:${sourceId ?? ''}:${slug}`;
}

/** Revisit forward references after a oneshot batch, conditional on its current snapshot. */
export async function autoLinkWrittenPage(
  engine: BrainEngine,
  slug: string,
  opts?: { sourceId?: string },
): Promise<void> {
  try {
    if (!(await isAutoLinkEnabled(engine))) return;
    await runAutoLink(engine, slug, opts);
  } catch (e) {
    process.stderr.write(`[oneshot] post-batch auto-link for ${slug} failed (best-effort): ${e instanceof Error ? e.message : String(e)}\n`);
  }
}

/** Reconcile derived links only if the prepared canonical snapshot is still current. */
async function runAutoLink(
  engine: BrainEngine,
  slug: string,
  opts?: { sourceId?: string },
) {
  const sourceId = opts?.sourceId ?? 'default';
  const snapshot = await engine.readPageSnapshot(slug, { sourceId });
  if (!snapshot) return;
  const { prepareAutomaticLinks } = await import('../persistence/links-preparation.ts');
  const prepared = await prepareAutomaticLinks(engine, slug, { ...snapshot.page, frontmatter: snapshot.page.frontmatter ?? {} }, sourceId);
  return engine.transaction(async tx => {
    await tx.lockPageKeys([{sourceId,slug}, ...prepared.pageKeys]);
    const current = await tx.readPageSnapshot(slug, {sourceId});
    if (!current || current.page.id !== snapshot.page.id || current.revision !== snapshot.revision) return;
    return prepared.apply(tx);
  });
}

const delete_page: Operation = {
  name: 'delete_page',
  idempotent: true,
  outputRedaction: 'no_stored_text',
  description: 'Soft-delete a page and remove its markdown file from the source working tree (the source local_path, or sync.repo_path when the source has none). File removal is skipped when sync.write_through is off; the committed receipt reports the persistence mode and write_through outcome. Read the page revision first and pass expected_revision; retain request_id for replay. The row is hidden from search and from get_page/list_pages, but is recoverable via restore_page within 72h, which re-creates the file. The autopilot purge phase hard-deletes after the recovery window. Pass include_deleted: true to get_page to verify the soft-delete landed. A page whose file another live page of the source records is hidden without touching that file (receipt write_through.skipped: shared_origin): the file and the surviving page remain, nothing is erased, and the next sync imports the file\'s current content into the surviving page. purge: true is trusted-local CLI only and removes the row, chunks, links and raw data immediately after its recorded markdown artifact is removed. Purge uses the same revision, request_id and recovery protocol, including for existing tombstones. A removal failure preserves the prior row and never reports purge success; repair the artifact and submit a new request_id. A purge of a page whose file is shared refuses and names the soft delete. A committed purge warns that git history, synced copies, exports and derived rows may retain content; rotate exposed credentials.',
  params: {
    ...PAGE_MUTATION_PARAMS,
    slug: { type: 'string', required: true, description: "Slug of the page to soft-delete, e.g. 'people/alice-example'." },
    source_id: { type: 'string', description: "#4329: source holding the row to soft-delete (a multi-source brain can hold the same slug in several sources). Defaults to ctx.sourceId. Remote callers may only target their write source — federated read grants do not confer delete access." },
    purge: { type: 'boolean', description: 'Hard-delete after coordinated artifact removal (no 72h recovery; status purged). Honored only for the trusted local CLI; remote/MCP callers get permission_denied (a non-boolean value is invalid_params) and keep the soft-delete path.' },
  },
  mutating: true,
  scope: 'write',
  handler: async (ctx, p) => {
    const sourceId = pageMutationSource(ctx, p, 'delete_page');
    assertPurgeParams(p, ctx.remote);
    if (ctx.dryRun) {
      if (typeof p.slug === 'string') {
        await validateMutationSlug(ctx, 'delete_page', p.slug, sourceId);
        enforceClientSlugFence(ctx, p.slug, 'delete_page');
        enforceSubagentSlugFence(ctx, p.slug, 'delete_page');
      }
      return { dry_run: true, action: p.purge === true ? 'purge_page' : 'delete_page', slug: p.slug };
    }
    return (await import('../persistence/page-purge.ts')).finishPagePurge(ctx, await submitPageMutation(ctx, { operation: 'delete_page', params: p }));
  },
  cliHints: { name: 'delete', positional: ['slug'] },
};

const restore_page: Operation = {
  name: 'restore_page',
  idempotent: true,
  outputRedaction: 'no_stored_text',
  description: 'Restore a soft-deleted page (clear deleted_at) and re-create its markdown file on disk (the counterpart to delete_page removing it; the result write_through field reports the outcome). Returns success only if the page was actually soft-deleted. After this op, the page reappears in search and in get_page/list_pages without the include_deleted flag.',
  params: {
    ...PAGE_MUTATION_PARAMS,
    slug: { type: 'string', required: true, description: "Slug of the soft-deleted page to restore, e.g. 'people/alice-example'." },
    source_id: { type: 'string', description: "#4329: source holding the row to restore (a multi-source brain can hold the same slug in several sources). Defaults to ctx.sourceId. Remote callers may only target their write source — federated read grants do not confer restore access." },
  },
  mutating: true,
  scope: 'write',
  handler: async (ctx, p) => {
    const sourceId = pageMutationSource(ctx, p, 'restore_page');
    if (ctx.dryRun) {
      if (typeof p.slug === 'string') {
        await validateMutationSlug(ctx, 'restore_page', p.slug, sourceId);
        enforceClientSlugFence(ctx, p.slug, 'restore_page');
        enforceSubagentSlugFence(ctx, p.slug, 'restore_page');
      }
      return { dry_run: true, action: 'restore_page', slug: p.slug };
    }
    return submitPageMutation(ctx, { operation: 'restore_page', params: p });
  },
  cliHints: { name: 'restore', positional: ['slug'] },
};

const purge_deleted_pages: Operation = {
  name: 'purge_deleted_pages',
  idempotent: false,
  outputRedaction: 'no_stored_text',
  description: 'Admin-only. Hard-deletes pages whose deleted_at is older than older_than_hours (default 72), in every source. Cascades through content_chunks, page_links, chunk_relations. Trusted local CLI only; the command is `gbrain pages purge-deleted`, which asks first (yes: true is the consent). Manual escape hatch alongside the autopilot purge phase.',
  params: {
    older_than_hours: { type: 'number', description: 'Age cutoff in hours. Default 72.' },
    yes: { type: 'boolean', description: 'Consent to the irreversible brain-wide purge. Ask the user first.' },
  },
  mutating: true,
  scope: 'admin',
  localOnly: true, cliOnly: { argv: ['gbrain', 'pages', 'purge-deleted', '--dry-run', '--json'] },
  handler: async (ctx, p) => {
    const olderThanHours = (p.older_than_hours as number | undefined) ?? 72;
    if (ctx.dryRun) return { dry_run: true, action: 'purge_deleted_pages', older_than_hours: olderThanHours };
    if (ctx.remote !== false) throw (await import('./callable.ts')).cliOnlyRefusal(purge_deleted_pages);
    return (await import('../persistence/purge-deleted.ts')).consentedPurgeDeletedPages(ctx.engine, olderThanHours, p.yes === true);
  },
  cliHints: { name: 'purge-deleted', hidden: true },
};

const LIST_PAGES_SORT_VALUES = ['updated_desc', 'updated_asc', 'created_desc', 'slug'] as const;
type ListPagesSort = typeof LIST_PAGES_SORT_VALUES[number];

const list_pages: Operation = {
  name: 'list_pages',
  idempotent: true,
  outputRedaction: 'retrieval',
  description: LIST_PAGES_DESCRIPTION,
  params: {
    type: { type: 'string', description: 'Page type.' },
    tag: { type: 'string', description: 'Tag.' },
    limit: { type: 'number', description: 'Max rows (default 50; remote max 100).' },
    offset: {
      type: 'number', description: 'Rows to skip.',
    },
    // v0.29 — surface filter that already exists on PageFilters.
    updated_after: {
      type: 'string',
      description: 'Pages updated after this ISO time.',
    },
    updated_after_slug: {
      type: 'string',
      description: "Last row's slug (with updated_after).",
    },
    sort: {
      type: 'string', description: 'Default updated_desc.',
      enum: [...LIST_PAGES_SORT_VALUES],
    },
    include_deleted: { type: 'boolean', description: 'Include soft-deleted pages.' },
    // #4400 — list_pages had no source-scoping param at all: unlike
    // search/query it silently ignored any caller-supplied source and always
    // fell back to whatever federatedSearchScope() resolved from ctx alone,
    // so a non-federated source's pages could never be enumerated remotely
    // (get_stats counts them; list_pages could not list them). Mirrors the
    // `source_id` param already on search/query, same '__all__' semantics.
    source_id: {
      type: 'string',
      description: "One source, or '__all__'.",
    },
    // v0.51.x — folder/prefix enumeration and batched list metadata. Same
    // contract as the Wegent-informed patch these came from: opt-in only, so
    // the default path stays a bare array and pays no COUNT or tag query.
    slug_prefix: {
      type: 'string',
      description: 'Literal prefix filter for page slugs, for example wiki/error-. Use with pagination to enumerate a folder or filename prefix.',
    },
    include_tags: {
      type: 'boolean',
      description: 'Include page tags in the list response using one batched query. Default false.',
    },
    include_total: {
      type: 'boolean',
      description: 'v0.51.x: when true, return { total, limit, offset, has_more, pages } instead of a bare array. total is one COUNT(*) matching the same filters.',
    },
  },
  handler: async (ctx, p) => {
    // Whitelist the sort enum at the handler before passing to the engine.
    // Engines also whitelist via PAGE_SORT_SQL but defending here keeps
    // unsupported strings from reaching the SQL layer.
    const rawSort = p.sort as string | undefined;
    let sort = rawSort && (LIST_PAGES_SORT_VALUES as readonly string[]).includes(rawSort)
      ? (rawSort as ListPagesSort)
      : undefined;
    // The keyset is only coherent under updated_asc's (updated_at, slug) total order.
    const updatedAfter = typeof p.updated_after === 'string' ? p.updated_after : undefined;
    const updatedAfterSlug = typeof p.updated_after_slug === 'string' ? p.updated_after_slug : undefined;
    if (updatedAfterSlug !== undefined && updatedAfter === undefined) {
      throw invalidParam(ctx, 'list_pages', 'updated_after', "list_pages: updated_after_slug requires updated_after (the cursor row's updated_at_iso).", { def: list_pages.params.updated_after, example: '2026-08-11T00:00:00.000000Z' });
    }
    const updatedAfterKeyset = updatedAfter !== undefined && updatedAfterSlug !== undefined
      ? { updatedAt: updatedAfter, slug: updatedAfterSlug }
      : undefined;
    if (updatedAfterKeyset) sort = 'updated_asc';
    // v0.34.1 (#861 — P0 leak seal): thread the auth'd client's source scope
    // into the listPages filter so an OAuth client scoped to src-A cannot
    // enumerate src-B pages. Pre-fix, ctx.sourceId / ctx.auth?.allowedSources
    // were ignored at this op handler and the engine returned every source's
    // pages indiscriminately.
    // #3242 / #4400: federatedSearchScope so unqualified listing spans
    // federated sources (same visibility set as search / get_page); an
    // explicit per-call source_id (including '__all__') wins, same contract
    // as search/query's sourceIdParam. parseSourceIdParam (same as get_page)
    // rejects whitespace/malformed/non-string ids loudly instead of letting
    // them silently return [] or, for the CLI's `--source-id ""`, widen to
    // every source.
    const sourceIdParam = parseSourceIdParam(p.source_id, 'list_pages', { allowAll: true });
    const scope = federatedSearchScope(ctx, sourceIdParam);
    // v0.51.x — literal slug-prefix folder enumeration. Escaped as a LIKE
    // literal in the shared WHERE builder, so it cannot inject wildcards.
    const slugPrefix = typeof p.slug_prefix === 'string' ? p.slug_prefix.trim() : undefined;
    if (slugPrefix !== undefined && slugPrefix.length > 200) {
      throw invalidParam(ctx, 'list_pages', 'slug_prefix', 'list_pages: slug_prefix must be at most 200 characters.', { def: list_pages.params.slug_prefix, example: 'wiki/error-' });
    }
    // #4620: an explicit source_id must name a live source (after the grant check).
    await assertExplicitSourceLive(ctx, sourceIdParam);
    // #4352 remediation: untrusted listing never enumerates
    // `visibility: private` pages (slugs + titles are the leak surface here).
    // Composes with the #4400 per-call source_id and the v0.34.1 grant scope
    // above — an ADDITIONAL predicate threaded into PageFilters, never a
    // replacement for the source filter. Trusted local enumeration unchanged.
    const excludePrivate = await resolveExcludePrivatePages(ctx.engine, ctx.remote);
    // The 100-row cap exists to protect remote MCP/OAuth transports from
    // unbounded result dumps. Local CLI callers (ctx.remote === false — the
    // same trust boundary that already bypasses scope enforcement, see the
    // Operation.scope doc above) own the machine, and a full enumeration is a
    // legitimate local operation, so an explicit limit above 100 is honored.
    // Anything that is not strictly `false` stays remote/untrusted (defense
    // in depth, matching the ctx.remote contract).
    const requestedLimit = p.limit as number | undefined;
    const isLocal = ctx.remote === false;
    const limit = isLocal
      ? clampSearchLimit(requestedLimit, 50, Number.MAX_SAFE_INTEGER)
      : clampSearchLimit(requestedLimit, 50, 100);
    if (!isLocal && requestedLimit !== undefined && Number.isFinite(requestedLimit) && requestedLimit > limit) {
      // Loud clamp, parity with the three search paths ("search limit clamped
      // from N to 100"). logger.warn goes to stderr — `list` stdout is
      // tab-separated and consumed by scripts, so it must stay clean.
      ctx.logger.warn(`[gbrain] Warning: list limit clamped from ${requestedLimit} to ${limit}; use offset to paginate`);
    }
    // Thread offset through — PageFilters has supported it all along; the op
    // layer just never passed it, so `--offset` was accepted and ignored.
    const includeTags = p.include_tags === true;
    const requestedOffset = p.offset as number | undefined;
    const offset =
      requestedOffset !== undefined && Number.isFinite(requestedOffset) && requestedOffset > 0
        ? Math.floor(requestedOffset)
        : undefined;
    // Probe one row past the effective limit so truncation is detectable
    // without a COUNT query. The bug class sealed here is SILENT truncation
    // — an exhaustive consumer (audit, scan, backfill) gets a full-looking
    // list and never learns rows were dropped, and with the default
    // updated_desc sort the dropped rows are always the OLDEST, i.e. exactly
    // the pages such consumers exist to find.
    const rows = await ctx.engine.listPages({
      type: p.type as any,
      tag: p.tag as string,
      limit: limit + 1,
      offset,
      includeDeleted: (p.include_deleted as boolean) === true,
      updated_after: updatedAfterKeyset ? undefined : updatedAfter,
      updatedAfterKeyset,
      sort,
      slugPrefix: slugPrefix || undefined,
      includeTags: p.include_tags === true,
      excludePrivate,
      listColumnsOnly: true,
      ...scope,
    }).catch((e: unknown) => {
      // #6103: an updated_after the database cannot parse is the caller's input, not a server fault.
      if (updatedAfter === undefined || !isDatetimeInputError(e)) throw e;
      throw invalidParam(ctx, 'list_pages', 'updated_after', 'list_pages: updated_after is not a date or timestamp the database can read.', {
        def: list_pages.params.updated_after, example: '2026-08-11T00:00:00Z',
        fix: readFix('Lists pages updated after a well-formed ISO timestamp.', { argv: ['gbrain', 'list', '--updated-after', '2026-08-11T00:00:00Z', '--limit', '1'],
          mcp: { tool: 'list_pages', arguments: { updated_after: '2026-08-11T00:00:00Z', limit: 1 } } }),
      });
    });
    const truncated = rows.length > limit;
    const pages = truncated ? rows.slice(0, limit) : rows;
    // Warn only when the caller's limit was NOT honored (unset → default 50):
    // an explicit honored limit that happens to land on more rows is ordinary
    // pagination, not a trap. Local (CLI) only — same operator-facing stderr
    // channel as the put_page unknown-type hint above — but with no isTTY
    // gate: scripted callers are precisely the consumers that cannot detect
    // truncation any other way, and stderr keeps stdout parseable for them.
    // (Local explicit limits are honored unbounded since #3322, so the
    // requestedLimit > limit arm is defense in depth only.)
    if (truncated && isLocal && (requestedLimit === undefined || requestedLimit > limit)) {
      console.error(
        `[list_pages] output truncated at ${limit} rows (default 50). ` +
        `Pass an explicit limit, page through with ` +
        `updated_after=<last row's updated_at_iso> + ` +
        `updated_after_slug=<last row's slug>, or narrow with type/tag.`,
      );
    }
    // MCP callers see neither that notice nor the clamp warning (server log):
    // `_meta.pagination` carries the data, the listing_truncated notice tells the model.
    const pagination = listPagesPagination({ truncated, limit, requestedLimit, offset, sort, last: pages[pages.length - 1] });
    ctx.emitResponseMeta?.('pagination', pagination);
    const truncatedNotice = isLocal ? null : listingTruncatedNotice(pagination, p);
    if (truncatedNotice) ctx.emitNotice?.(truncatedNotice);
    const mapped = pages.map(pg => ({
      slug: pg.slug,
      source_id: pg.source_id,
      type: pg.type,
      title: pg.title,
      updated_at: pg.updated_at,
      updated_at_iso: pg.updated_at_iso,
      ...(includeTags ? { tags: pg.tags ?? [] } : {}),
      ...(pg.deleted_at ? { deleted_at: pg.deleted_at } : {}),
    }));
    // v0.51.x — Wegent-style pagination metadata: one COUNT over the exact
    // same predicates, only when the caller explicitly opts in. The default
    // path stays a bare array and pays zero COUNT cost, so legacy consumers
    // (and the CLI's tab-separated output) are untouched.
    if (p.include_total === true) {
      const total = await ctx.engine.listPagesCount({
        type: p.type as any,
        tag: p.tag as string,
        includeDeleted: (p.include_deleted as boolean) === true,
        updated_after: updatedAfterKeyset ? undefined : updatedAfter,
        updatedAfterKeyset,
        sort,
        slugPrefix: slugPrefix || undefined,
        excludePrivate,
        ...scope,
      });
      const effectiveOffset = offset ?? 0;
      return {
        total,
        limit,
        offset: effectiveOffset,
        has_more: effectiveOffset + mapped.length < total,
        pages: mapped,
      };
    }
    return mapped;
  },
  scope: 'read', mutating: false,
  cliHints: { name: 'list' },
};


// Ops in EXACTLY the order they appear in the canonical `operations` array
/**
 * CLI→MCP gap-closure wave — `capture` over MCP (D2A). The documented "just
 * get this into my brain" entrypoint: three separate docs carried the
 * "unknown tool: capture → use put_page" FAQ because agents kept reaching for
 * it. Thin sugar that DELEGATES to the put_page handler with the same ctx
 * (inheriting every fence: slug fence, dedupe, unknown-type audit,
 * write-through, remote auto-link skip) after adding what agents had to
 * hand-roll: a stable content-derived default slug + the frontmatter merge +
 * the binary/empty guards. Remote provenance stays the CV6 server-stamp
 * `mcp:put_page` (the write API truthfully IS put_page); the result carries
 * channel: 'capture' for the receipt. Joins STARTER_OPS as a direct literal
 * [EV8] so the plugin/starter lanes that retired the FAQ can actually call it.
 */
const capture: Operation = {
  name: 'capture',
  idempotent: true,
  outputRedaction: 'no_stored_text',
  description: CAPTURE_DESCRIPTION,
  params: {
    ...AGENT_CONTENT_PARAMS,
    ...CAPTURE_EVENT_PARAMS, ...CAPTURE_CLI_PROVENANCE_PARAMS,
    content: { type: 'string', required: true, description: 'Markdown or text (not a file path).' },
    local_file: { type: 'string', description: 'Local CLI only.', required: false },
    slug: { type: 'string', required: false, description: 'Default inbox/<date>-<hash>.' },
    type: { type: 'string', required: false, description: 'Page type (default note).' },
  },
  scope: 'write',
  mutating: true,
  area: 'pages',
  // 'capture' is in CLI_ONLY (rich local UX: --file/--stdin/event sugar);
  // hidden hint per the advisor pattern.
  cliHints: { name: 'capture', hidden: true },
  handler: async (ctx, p) => {
    pageMutationSource(ctx, p, 'capture');
    if (ctx.dryRun) {
      if (typeof p.slug === 'string') {
        validatePageSlug(p.slug);
        enforceClientSlugFence(ctx, p.slug, 'capture');
        enforceSubagentSlugFence(ctx, p.slug, 'capture');
      }
      return { dry_run: true, action: 'capture', slug: p.slug };
    }
    return submitPageMutation(ctx, { operation: 'capture', params: p });
  },
};

// --- Local port: memory-library folder/file explorer (upstream #4400) ---
// Ported from the 0.48 development line. `source_inventory` and `purge_pages`
// are not upstream in 0.60; they power gbrain-web's Memory Library (per-source
// folder tree + permanent delete). Kept here rather than upstreamed so a
// future `gbrain self-upgrade` does not silently drop them again.
const source_inventory: Operation = {
  name: 'source_inventory',
  description: 'Return a source-scoped folder inventory and one paginated batch of direct files. Intended for large Memory Library sources; does not enumerate every page into the client.',
  params: {
    source_id: { type: 'string', required: true, description: 'One source id.' },
    folder: { type: 'string', description: 'Folder path in the source file namespace. Empty string means the root.' },
    limit: { type: 'number', description: 'Direct files per batch (default 48, max 100).' },
    offset: { type: 'number', description: 'Offset within direct files.' },
    type: { type: 'string', description: 'Optional page type filter.' },
    tag: { type: 'string', description: 'Optional tag filter.' },
    sort: { type: 'string', enum: ['updated_desc', 'updated_asc', 'created_desc', 'slug'], description: 'Page ordering for stable pagination.' },
    recursive: { type: 'boolean', description: 'Include every descendant file in the folder; empty folder means the entire source and should only be used with pagination/dry-run.' },
    include_source_id: { type: 'boolean', description: 'Include each folder entry source_id in cross-source inventory responses.' },
  },
  scope: 'read',
  handler: async (ctx, p) => {
    const requestedSourceId = typeof p.source_id === 'string' ? p.source_id.trim() : '';
    if (!requestedSourceId) throw new OperationError('invalid_params', 'source_id is required.');
    const scope = federatedSearchScope(ctx, requestedSourceId);
    const folder = typeof p.folder === 'string' ? p.folder.trim().replace(/^\/+|\/+$/g, '') : '';
    const recursive = p.recursive === true;
    if (requestedSourceId === '__all__' && recursive && !folder) {
      // The Memory Library enumerates each registered source separately so it
      // can track per-source pagination and cross-source identity. A single
      // source-wide recursive sweep would both defeat that and (for a frontend
      // that maps folder → source) risk mis-scoping folder deletes.
      throw new OperationError('invalid_params', 'recursive source-wide inventory must be queried one concrete source at a time.');
    }
    const includeSourceId = p.include_source_id === true;
    const limit = Math.max(1, Math.min(Number.isFinite(p.limit as number) ? Math.floor(p.limit as number) : 48, 100));
    const offset = Number.isFinite(p.offset as number) && (p.offset as number) > 0 ? Math.floor(p.offset as number) : 0;
    const pathExpr = `CASE WHEN p.page_kind = 'code' THEN COALESCE(NULLIF(p.frontmatter->>'file', ''), p.source_path, p.slug) ELSE p.slug END`;
    const privateExclude = await resolveExcludePrivatePages(ctx.engine, ctx.remote);
    const privateWhere = privateExclude ? ` AND COALESCE(p.frontmatter->>'visibility', 'world') <> 'private'` : '';
    const hasType = typeof p.type === 'string' && p.type.length > 0;
    const hasTag = typeof p.tag === 'string' && p.tag.length > 0;
    const rawSort = typeof p.sort === 'string' ? p.sort : 'slug';
    const sort = (['updated_desc', 'updated_asc', 'created_desc', 'slug'] as const).includes(rawSort as 'updated_desc' | 'updated_asc' | 'created_desc' | 'slug')
      ? rawSort as 'updated_desc' | 'updated_asc' | 'created_desc' | 'slug'
      : 'slug';
    const sortColumn = sort === 'updated_desc' || sort === 'updated_asc' ? 'p.updated_at' : sort === 'created_desc' ? 'p.created_at' : pathExpr;
    const sortDirection = sort === 'updated_desc' || sort === 'created_desc' ? 'DESC' : 'ASC';
    const pageOrder = sort === 'slug'
      ? `${pathExpr} ASC, p.source_id ASC, p.slug ASC`
      : `${sortColumn} ${sortDirection} NULLS LAST, p.source_id ASC, p.slug ASC`;
    const sourcePredicate = (params: unknown[]): string => {
      if (scope.sourceIds && scope.sourceIds.length > 0) {
        params.push(scope.sourceIds);
        return `p.source_id = ANY($${params.length}::text[])`;
      }
      if (scope.sourceId) {
        params.push(scope.sourceId);
        return `p.source_id = $${params.length}`;
      }
      return 'TRUE';
    };
    const buildWhere = (params: unknown[], folderMode: 'direct' | 'subtree' | 'root') => {
      const clauses = [sourcePredicate(params), `p.deleted_at IS NULL${privateWhere}`];
      if (folderMode === 'subtree') {
        if (folder) {
          params.push(folder);
          const folderParam = `$${params.length}::text`;
          clauses.push(`left((${pathExpr}), char_length(${folderParam}) + 1) = ${folderParam} || '/'`);
        }
        // Empty subtree folder is the source root: no path predicate, so a
        // recursive inventory can safely enumerate every page in that source.
      } else if (folderMode === 'direct') {
        params.push(folder);
        const folderParam = `$${params.length}::text`;
        clauses.push(`left((${pathExpr}), char_length(${folderParam}) + 1) = ${folderParam} || '/'`);
        clauses.push(`substring((${pathExpr}) FROM char_length(${folderParam}) + 2) NOT LIKE '%/%'`);
      } else {
        clauses.push(`(${pathExpr}) NOT LIKE '%/%'`);
      }
      if (hasType) {
        params.push(p.type);
        clauses.push(`p.type = $${params.length}`);
      }
      if (hasTag) {
        params.push(p.tag);
        clauses.push(`EXISTS (SELECT 1 FROM tags pt WHERE pt.page_id = p.id AND pt.tag = $${params.length})`);
      }
      return clauses.join(' AND ');
    };
    const directParams: unknown[] = [];
    const directWhere = buildWhere(directParams, folder ? (recursive ? 'subtree' : 'direct') : (recursive ? 'subtree' : 'root'));
    directParams.push(limit);
    const limitParam = `$${directParams.length}`;
    directParams.push(offset);
    const offsetParam = `$${directParams.length}`;
    const pages = await ctx.engine.executeRaw<Record<string, unknown>>(
      `SELECT p.slug, p.source_id, p.type, p.title, p.updated_at,
              COALESCE((SELECT jsonb_agg(pt.tag ORDER BY pt.tag) FROM tags pt WHERE pt.page_id = p.id), '[]'::jsonb) AS tags
         FROM pages p WHERE ${directWhere}
        ORDER BY ${pageOrder} LIMIT ${limitParam} OFFSET ${offsetParam}`,
      directParams,
    );
    const countParams: unknown[] = [];
    const countWhere = buildWhere(countParams, folder ? (recursive ? 'subtree' : 'direct') : (recursive ? 'subtree' : 'root'));
    const countRows = await ctx.engine.executeRaw<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM pages p WHERE ${countWhere}`,
      countParams,
    );
    const inventoryParams: unknown[] = [];
    const inventorySource = sourcePredicate(inventoryParams);
    inventoryParams.push(folder);
    const folderRef = `$${inventoryParams.length}::text`;
    let inventoryWhere = `${inventorySource} AND p.deleted_at IS NULL${privateWhere}`;
    if (hasType) {
      inventoryParams.push(p.type);
      inventoryWhere += ` AND p.type = $${inventoryParams.length}`;
    }
    if (hasTag) {
      inventoryParams.push(p.tag);
      inventoryWhere += ` AND EXISTS (SELECT 1 FROM tags pt WHERE pt.page_id = p.id AND pt.tag = $${inventoryParams.length})`;
    }
    const folderRows = await ctx.engine.executeRaw<Record<string, unknown>>(
      `WITH page_paths AS (
         SELECT p.source_id, ${pathExpr} AS path FROM pages p WHERE ${inventoryWhere}
       ), scoped AS (
         SELECT source_id, CASE WHEN ${folderRef} = '' THEN path ELSE substring(path FROM char_length(${folderRef}) + 2) END AS rel
           FROM page_paths WHERE (${folderRef} = '' OR left(path, char_length(${folderRef}) + 1) = ${folderRef} || '/')
       ), child_pages AS (
         SELECT source_id, split_part(rel, '/', 1) AS child, rel FROM scoped WHERE rel LIKE '%/%'
       )
       SELECT child AS name,
              CASE WHEN ${folderRef} = '' THEN child ELSE ${folderRef} || '/' || child END AS path,
              NULL::text AS source_id,
              ${includeSourceId ? `array_agg(DISTINCT source_id ORDER BY source_id)` : `NULL::text[]`} AS source_ids,
              COUNT(*)::int AS subtree_count,
              COUNT(DISTINCT source_id)::int AS source_count,
              COUNT(*) FILTER (WHERE rel NOT LIKE '%/%')::int AS direct_count,
              COUNT(DISTINCT source_id || ':' || split_part(substring(rel FROM char_length(child) + 2), '/', 1)) FILTER (WHERE rel LIKE '%/%')::int AS child_folder_count
         FROM child_pages GROUP BY child ORDER BY child`,
      inventoryParams,
    );
    return {
      source_id: requestedSourceId,
      folder,
      total: Number(countRows[0]?.count ?? 0),
      has_more: offset + pages.length < Number(countRows[0]?.count ?? 0),
      pages,
      folders: folderRows,
    };
  },
  cliHints: { name: 'source_inventory', hidden: true },
};

const purge_pages: Operation = {
  name: 'purge_pages',
  description: 'Permanently delete a bounded batch of source-scoped pages immediately. This is irreversible and cascades chunks, embeddings, links, timeline, tags, versions, and code edges. Requires admin scope and explicit confirmation.',
  idempotent: false,
  outputRedaction: 'no_stored_text',
  params: {
    slugs: { type: 'array', required: true, items: { type: 'string' }, description: 'Page slugs to permanently delete (max 200). All must belong to source_id.' },
    source_id: { type: 'string', required: true, description: 'Source holding the pages.' },
    confirm_destructive: { type: 'boolean', required: true, description: 'Must be true to perform irreversible deletion.' },
    dry_run: { type: 'boolean', description: 'Return impact without deleting.' },
  },
  mutating: true,
  scope: 'admin',
  handler: async (ctx, p) => {
    const slugs = Array.isArray(p.slugs) ? p.slugs.filter((slug): slug is string => typeof slug === 'string' && slug.length > 0) : [];
    const sourceId = parseSourceIdParam(p.source_id, 'purge_pages');
    if (!sourceId) throw new OperationError('invalid_params', 'purge_pages requires source_id');
    if (slugs.length === 0 || slugs.length > 200) throw new OperationError('invalid_params', 'purge_pages requires 1-200 slugs');
    for (const slug of slugs) validatePageSlug(slug);
    // Server-side authority gate, mirroring 0.60's stance that an irreversible
    // purge needs an admin-granted caller: the local CLI, or a remote client
    // holding the `admin` scope (gbrain-web's OAuth client does). The
    // `confirm_destructive` flag is only an intent check the caller can forge,
    // so it is NOT the security boundary.
    if (ctx.remote !== false && !hasScope(ctx.auth?.scopes ?? [], 'admin')) {
      throw new OperationError('permission_denied', 'purge_pages requires the local CLI or an admin-scoped client');
    }
    const dryRun = p.dry_run === true || ctx.dryRun;
    const rows = await ctx.engine.executeRaw<{ slug: string }>(
      `SELECT slug FROM pages WHERE source_id = $1 AND slug = ANY($2::text[])`,
      [sourceId, slugs],
    );
    const found = rows.map((row) => row.slug);
    if (dryRun) return { status: 'dry_run', source_id: sourceId, requested: slugs.length, found: found.length, slugs: found };
    if (p.confirm_destructive !== true) throw new OperationError('confirmation_required', 'purge_pages requires confirm_destructive=true');
    const deleted = await ctx.engine.deletePages(found, { sourceId });
    return { status: 'purged', source_id: sourceId, count: deleted.length, slugs: deleted };
  },
  cliHints: { name: 'purge_pages', hidden: true },
};

// (Page CRUD quartet first, then the v0.26.5 destructive-guard ops:
// page-level soft-delete recovery + admin purge, then capture.)
export const pagesOperations: Operation[] = [
  get_page, put_page, delete_page, list_pages, source_inventory,
  restore_page, purge_pages, purge_deleted_pages, capture,
  fetch_page,
];
