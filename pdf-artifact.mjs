#!/usr/bin/env node

/**
 * Canonical PDF artifact acceptance and tracker reconciliation.
 *
 * generate-pdf.mjs records every report-linked render here after Chromium has
 * written the file and counted its pages. A written overflow is therefore
 * inspectable without being accepted. Only an accepted record may reconcile
 * the tracker PDF cell, and every mutation is revision-checked under the shared
 * tracker lock.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseTrackerRow, resolveColumns } from './tracker-parse.mjs';
import {
  acquireTrackerLock,
  rebuildRow,
  trackerLockDirFor,
  writeFileAtomic,
} from './tracker-utils.mjs';

const MODULE_ROOT = dirname(fileURLToPath(import.meta.url));
const RECORD_VERSION = 1;
const RECORD_DIR = join('.career-ops-web', 'pdf-artifacts');

export const PDF_TRIM_GUIDANCE =
  'Trim the weakest content: extra bullets, older roles, the competencies strip, then secondary projects.';

function digest(value) {
  const input = typeof value === 'string' || value instanceof Uint8Array
    ? value
    : JSON.stringify(value);
  return createHash('sha256').update(input).digest('hex');
}

function checkoutRoot(root) {
  const candidate = resolve(root ?? MODULE_ROOT);
  if (!existsSync(candidate) || !statSync(candidate).isDirectory()) {
    throw new Error(`career-ops checkout root not found: ${candidate}`);
  }
  return candidate;
}

function trackerPath(root) {
  const nested = join(root, 'data', 'applications.md');
  if (existsSync(nested)) return nested;
  const flat = join(root, 'applications.md');
  return existsSync(flat) ? flat : null;
}

function normalizeReport(value) {
  const text = String(value ?? '').trim();
  if (!/^\d+$/.test(text)) return null;
  return text.replace(/^0+(?=\d)/, '');
}

function reportFromRow(row) {
  const linked = String(row.report ?? '').match(/\[(\d+)\]\([^)]+\)/)?.[1];
  return normalizeReport(linked ?? row.num);
}

function relativePath(root, candidate) {
  return relative(root, candidate).split(sep).join('/');
}

function safeRepoPath(root, candidate) {
  const absolute = resolve(candidate);
  const rel = relative(root, absolute);
  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`PDF artifact path must stay inside the checkout: ${candidate}`);
  }
  return { absolute, relative: relativePath(root, absolute) };
}

function recordPath(root, report) {
  const key = normalizeReport(report);
  if (!key) throw new Error('report must be a numeric report number');
  return join(root, RECORD_DIR, `${key}.json`);
}

function withRevision(value) {
  const base = { ...value };
  delete base.revision;
  return { ...base, revision: digest(base) };
}

function parseRecord(value, expectedReport = null) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value;
  const report = normalizeReport(record.report);
  if (
    record.version !== RECORD_VERSION
    || !report
    || (expectedReport && report !== normalizeReport(expectedReport))
    || typeof record.pdfPath !== 'string'
    || typeof record.htmlPath !== 'string'
    || !['a4', 'letter'].includes(record.format)
    || !Number.isSafeInteger(record.pageCount) || record.pageCount <= 0
    || !Number.isSafeInteger(record.maxPages) || record.maxPages < 0
    || !['accepted', 'needs-review'].includes(record.status)
    || !['within-budget', 'explicit-overflow', null].includes(record.acceptedBy)
    || typeof record.trimGuidance !== 'string'
    || typeof record.pdfRevision !== 'string' || !/^[a-f0-9]{64}$/.test(record.pdfRevision)
    || typeof record.generatedAt !== 'string'
    || typeof record.revision !== 'string' || !/^[a-f0-9]{64}$/.test(record.revision)
  ) return null;
  const normalized = { ...record, report };
  return withRevision(normalized).revision === normalized.revision ? normalized : null;
}

function readRecord(root, report) {
  try {
    return parseRecord(JSON.parse(readFileSync(recordPath(root, report), 'utf8')), report);
  } catch {
    return null;
  }
}

function readTracker(root) {
  const path = trackerPath(root);
  if (!path) throw new Error('applications tracker not found');
  const content = readFileSync(path, 'utf8');
  const lines = content.split('\n');
  const columns = resolveColumns(lines);
  const rows = lines
    .map((line, lineIndex) => {
      const row = parseTrackerRow(line, columns);
      return row ? { ...row, lineIndex } : null;
    })
    .filter(Boolean);
  return { path, content, lines, columns, rows };
}

function findRow(snapshot, opportunity) {
  const matches = snapshot.rows.filter((row) => row.num === opportunity);
  if (matches.length !== 1) {
    throw new Error(matches.length ? 'opportunity tracker number is ambiguous' : 'opportunity not found');
  }
  return matches[0];
}

function publicArtifact(root, record) {
  let state = 'available';
  try {
    const pdf = safeRepoPath(root, join(root, record.pdfPath));
    const bytes = readFileSync(pdf.absolute);
    if (digest(bytes) !== record.pdfRevision) state = 'unavailable';
  } catch {
    state = 'unavailable';
  }
  return {
    kind: 'pdf',
    action: 'generate_pdf',
    expectedAction: 'generate_pdf',
    state,
    format: 'canonical',
    path: record.pdfPath,
    revision: record.pdfRevision,
    acceptance: {
      status: record.status,
      actualPages: record.pageCount,
      budget: record.maxPages,
      trimGuidance: record.trimGuidance,
      acceptedBy: record.acceptedBy,
      reviewRevision: record.revision,
    },
  };
}

/** Record one completed Chromium render before page-budget acceptance. */
export function recordPdfArtifact(options) {
  const root = checkoutRoot(options.root);
  const report = normalizeReport(options.report);
  if (!report) return null;
  const pdf = safeRepoPath(root, options.pdfPath);
  let html = null;
  if (options.htmlPath) {
    try { html = safeRepoPath(root, options.htmlPath); } catch { html = null; }
  }
  const pageCount = Number(options.pageCount);
  const maxPages = Number(options.maxPages);
  if (!Number.isSafeInteger(pageCount) || pageCount <= 0) throw new Error('pageCount must be a positive integer');
  if (!Number.isSafeInteger(maxPages) || maxPages < 0) throw new Error('maxPages must be a non-negative integer');
  const allowOverflow = options.allowOverflow === true;
  const overflow = maxPages > 0 && pageCount > maxPages;
  const status = overflow && !allowOverflow ? 'needs-review' : 'accepted';
  const format = String(options.format ?? 'a4').toLowerCase();
  if (!['a4', 'letter'].includes(format)) throw new Error('format must be a4 or letter');
  const record = withRevision({
    version: RECORD_VERSION,
    report,
    pdfPath: pdf.relative,
    htmlPath: html?.relative ?? '',
    format,
    pageCount,
    maxPages,
    status,
    acceptedBy: status === 'needs-review' ? null : overflow ? 'explicit-overflow' : 'within-budget',
    trimGuidance: PDF_TRIM_GUIDANCE,
    pdfRevision: digest(readFileSync(pdf.absolute)),
    generatedAt: new Date().toISOString(),
  });
  mkdirSync(join(root, RECORD_DIR), { recursive: true });
  writeFileAtomic(recordPath(root, report), `${JSON.stringify(record, null, 2)}\n`);
  return { record, artifact: publicArtifact(root, record) };
}

/** Resolve a report number to one exact tracker Opportunity. */
export function opportunityForReport(options) {
  const root = checkoutRoot(options.root);
  const report = normalizeReport(options.report);
  if (!report) return null;
  const snapshot = readTracker(root);
  const matches = snapshot.rows.filter((row) => reportFromRow(row) === report);
  return matches.length === 1 ? matches[0].num : null;
}

/** Read the current canonical PDF record for one tracker row without writing. */
export function inspectPdfArtifact(options) {
  const root = checkoutRoot(options.root);
  const row = options.row;
  const report = reportFromRow(row);
  if (!report) return null;
  const record = readRecord(root, report);
  if (!record) return null;
  return { report, record, artifact: publicArtifact(root, record) };
}

/**
 * Accept an exact written overflow, or reconcile an already accepted render.
 * The expected PDF review revision prevents an older screen from accepting a
 * newer render whose page count or bytes have changed.
 */
export async function reconcilePdfArtifact(options) {
  const root = checkoutRoot(options.root);
  const opportunity = Number(options.opportunity);
  if (!Number.isSafeInteger(opportunity) || opportunity <= 0) throw new Error('opportunity must be a positive tracker number');
  const initialTracker = trackerPath(root);
  if (!initialTracker) throw new Error('applications tracker not found');
  const lock = await acquireTrackerLock(trackerLockDirFor(initialTracker), {
    timeoutMs: Number(options.lockTimeoutMs) || 60_000,
    retryMs: Number(options.lockRetryMs) || 75,
    staleMs: Number(options.lockStaleMs) || 10 * 60_000,
    tracker: initialTracker,
  });
  try {
    const snapshot = readTracker(root);
    const row = findRow(snapshot, opportunity);
    const report = reportFromRow(row);
    const record = report ? readRecord(root, report) : null;
    if (!record) return { code: 'pdf-record-missing', effect: 'unavailable', retryable: true, message: 'The canonical PDF record is unavailable.' };
    if (typeof options.expectedRevision !== 'string' || options.expectedRevision !== record.revision) {
      return {
        code: 'pdf-revision-conflict', effect: 'conflict', retryable: false,
        message: 'The PDF changed after this action was prepared.', artifact: publicArtifact(root, record),
      };
    }

    let accepted = record;
    let acceptanceChanged = false;
    if (options.allowPageCount !== undefined) {
      const allowed = Number(options.allowPageCount);
      if (!Number.isSafeInteger(allowed) || allowed <= 0 || allowed !== record.pageCount) {
        return {
          code: 'pdf-page-count-conflict', effect: 'conflict', retryable: false,
          message: 'The requested page allowance no longer matches this PDF.', artifact: publicArtifact(root, record),
        };
      }
      if (record.status === 'needs-review') {
        accepted = withRevision({ ...record, status: 'accepted', acceptedBy: 'explicit-overflow' });
        acceptanceChanged = true;
      } else if (record.acceptedBy !== 'explicit-overflow' || record.pageCount !== allowed) {
        return {
          code: 'pdf-already-accepted', effect: 'unchanged', retryable: false,
          message: 'The PDF is already accepted.', artifact: publicArtifact(root, record),
        };
      }
    }
    if (accepted.status !== 'accepted') {
      return {
        code: 'pdf-needs-review', effect: 'blocked', retryable: false,
        message: 'The written PDF exceeds its page budget and is not accepted.', artifact: publicArtifact(root, accepted),
      };
    }

    const parts = snapshot.lines[row.lineIndex].split('|').map((cell) => cell.trim());
    if (snapshot.columns.pdf == null) {
      return { code: 'pdf-column-missing', effect: 'unavailable', retryable: false, message: 'The tracker has no PDF column.' };
    }
    while (parts.length <= snapshot.columns.pdf) parts.push('');
    const trackerValue = `[pdf](../${accepted.pdfPath})`;
    const trackerChanged = parts[snapshot.columns.pdf] !== trackerValue;
    if (!acceptanceChanged && !trackerChanged) {
      return {
        code: 'pdf-already-reconciled', effect: 'unchanged', retryable: false,
        message: 'The accepted PDF is already marked ready.', artifact: publicArtifact(root, accepted),
      };
    }

    const previousRecord = record;
    if (acceptanceChanged) writeFileAtomic(recordPath(root, report), `${JSON.stringify(accepted, null, 2)}\n`);
    if (trackerChanged) {
      parts[snapshot.columns.pdf] = trackerValue;
      snapshot.lines[row.lineIndex] = rebuildRow(parts);
      try {
        writeFileAtomic(snapshot.path, snapshot.lines.join('\n'));
      } catch (error) {
        if (acceptanceChanged) writeFileAtomic(recordPath(root, report), `${JSON.stringify(previousRecord, null, 2)}\n`);
        throw error;
      }
    }
    return {
      code: acceptanceChanged ? 'pdf-overflow-allowed' : 'pdf-reconciled',
      effect: 'changed', retryable: false,
      message: acceptanceChanged
        ? `The ${accepted.pageCount}-page PDF was explicitly accepted and marked ready.`
        : 'The accepted PDF was marked ready.',
      artifact: publicArtifact(root, accepted),
    };
  } finally {
    lock.release();
  }
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  const value = (name) => args.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
  const root = value('root') || MODULE_ROOT;
  const opportunity = Number(value('opportunity'));
  const expectedRevision = value('expected-revision');
  if (!['reconcile', 'allow'].includes(command) || !Number.isSafeInteger(opportunity) || !expectedRevision) {
    console.error('Usage: node pdf-artifact.mjs <reconcile|allow> --opportunity=N --expected-revision=SHA [--pages=N] [--root=PATH]');
    process.exitCode = 1;
    return;
  }
  const outcome = await reconcilePdfArtifact({
    root,
    opportunity,
    expectedRevision,
    ...(command === 'allow' ? { allowPageCount: Number(value('pages')) } : {}),
  });
  console.log(JSON.stringify(outcome));
  if (!['changed', 'unchanged'].includes(outcome.effect)) process.exitCode = outcome.effect === 'conflict' ? 3 : 2;
}

if (process.env.CAREER_OPS_PDF_ARTIFACT_CLI === '1' || (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]))) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
