#!/usr/bin/env node
/**
 * normalize-statuses.mjs — Clean non-canonical states in applications.md
 *
 * Maps all non-canonical statuses to canonical ones per states.yml:
 *   Evaluated, Applied, Responded, Interview, Offer, Rejected, Discarded, SKIP
 *
 * Also strips markdown bold (**) and dates from the status field,
 * moving duplicate markers to the notes column.
 *
 * Run: node career-ops/normalize-statuses.mjs [--dry-run]
 */

import { readFileSync, writeFileSync, copyFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { rebuildRow } from './tracker-utils.mjs';

const CAREER_OPS = dirname(fileURLToPath(import.meta.url));
// Support both layouts: data/applications.md (boilerplate) and applications.md (original)
const APPS_FILE = existsSync(join(CAREER_OPS, 'data/applications.md'))
  ? join(CAREER_OPS, 'data/applications.md')
  : join(CAREER_OPS, 'applications.md');
const DRY_RUN = process.argv.includes('--dry-run');

// Ensure required directories exist (fresh setup)
mkdirSync(join(CAREER_OPS, 'data'), { recursive: true });

// Canonical status mapping
function normalizeStatus(raw) {
  // Strip markdown bold
  let s = raw.replace(/\*\*/g, '').trim();
  const lower = s.toLowerCase();

  // Legacy duplicate variants -> Discarded
  if (/^duplicado/i.test(s) || /^dup\b/i.test(s)) {
    return { status: 'Discarded', moveToNotes: raw.trim() };
  }

  // Legacy closed/cancelled/discarded aliases -> Discarded
  if (/^cerrada$/i.test(s)) return { status: 'Discarded' };
  if (/^cancelada/i.test(s)) return { status: 'Discarded' };
  if (/^descartada$/i.test(s)) return { status: 'Discarded' };
  if (/^descartado$/i.test(s)) return { status: 'Discarded' };

  // Legacy rejected aliases -> Rejected
  if (/^rechazada?$/i.test(s)) return { status: 'Rejected' };
  if (/^rechazado\s+\d{4}/i.test(s)) return { status: 'Rejected' };

  // Legacy applied status with date -> Applied (strip date)
  if (/^aplicado\s+\d{4}/i.test(s)) return { status: 'Applied' };

  // Legacy review/hold aliases -> Evaluated
  if (/^(condicional|hold|evaluar|verificar)$/i.test(s)) return { status: 'Evaluated' };

  // Legacy monitor status -> SKIP
  if (/^monitor$/i.test(s)) return { status: 'SKIP' };

  // Geo blocker -> SKIP
  if (/geo.?blocker/i.test(s)) return { status: 'SKIP' };

  // Repost marker -> Discarded
  if (/^repost/i.test(s)) return { status: 'Discarded', moveToNotes: raw.trim() };

  // Empty/no-status markers -> Discarded
  if (s === '—' || s === '-' || s === '') return { status: 'Discarded' };

  // Already canonical (English, per states.yml) — just fix casing/bold
  const canonical = [
    'Evaluated', 'Applied', 'Responded', 'Interview',
    'Offer', 'Hired', 'Rejected', 'Discarded', 'SKIP',
  ];
  for (const c of canonical) {
    if (lower === c.toLowerCase()) return { status: c };
  }

  // Legacy aliases -> English canonicals
  if (['evaluada'].includes(lower)) return { status: 'Evaluated' };
  if (['aplicado', 'enviada', 'aplicada', 'applied', 'sent'].includes(lower)) return { status: 'Applied' };
  if (['respondido'].includes(lower)) return { status: 'Responded' };
  if (['entrevista'].includes(lower)) return { status: 'Interview' };
  if (['oferta'].includes(lower)) return { status: 'Offer' };
  if (['contratado', 'contratada', 'hired', 'accepted', 'accept'].includes(lower)) return { status: 'Hired' };
  if (['cerrada', 'descartada'].includes(lower)) return { status: 'Discarded' };
  if (['no aplicar', 'no_aplicar', 'skip'].includes(lower)) return { status: 'SKIP' };

  // Unknown -> flag it
  return { status: null, unknown: true };
}

// Read applications.md
if (!existsSync(APPS_FILE)) {
  console.log('No applications.md found. Nothing to normalize.');
  process.exit(0);
}
const content = readFileSync(APPS_FILE, 'utf-8');
const lines = content.split('\n');

let changes = 0;
let unknowns = [];

for (let i = 0; i < lines.length; i++) {
  const line = lines[i];
  if (!line.startsWith('|')) continue;

  const parts = line.split('|').map(s => s.trim());
  // Format: ['', '#', 'fecha', 'empresa', 'rol', 'score', 'STATUS', 'pdf', 'report', 'notas', '']
  if (parts.length < 9) continue;
  if (parts[1] === '#' || parts[1] === '---' || parts[1] === '') continue;

  const num = parseInt(parts[1]);
  if (isNaN(num)) continue;

  const rawStatus = parts[6];
  const result = normalizeStatus(rawStatus);

  if (result.unknown) {
    unknowns.push({ num, rawStatus, line: i + 1 });
    continue;
  }

  if (result.status === rawStatus) continue; // Already canonical

  // Apply change
  const oldStatus = rawStatus;
  parts[6] = result.status;

  // Move DUPLICADO info to notes if needed
  if (result.moveToNotes && parts[9]) {
    const existing = parts[9] || '';
    if (!existing.includes(result.moveToNotes)) {
      parts[9] = result.moveToNotes + (existing ? '. ' + existing : '');
    }
  } else if (result.moveToNotes && !parts[9]) {
    parts[9] = result.moveToNotes;
  }

  // Also strip bold from score field
  if (parts[5]) {
    parts[5] = parts[5].replace(/\*\*/g, '');
  }

  // Reconstruct line
  const newLine = rebuildRow(parts);
  lines[i] = newLine;
  changes++;

  console.log(`#${num}: "${oldStatus}" → "${result.status}"`);
}

if (unknowns.length > 0) {
  console.log(`\n⚠️  ${unknowns.length} unknown statuses:`);
  for (const u of unknowns) {
    console.log(`  #${u.num} (line ${u.line}): "${u.rawStatus}"`);
  }
}

console.log(`\n📊 ${changes} statuses normalized`);

if (!DRY_RUN && changes > 0) {
  // Backup first
  copyFileSync(APPS_FILE, APPS_FILE + '.bak');
  writeFileSync(APPS_FILE, lines.join('\n'));
  console.log('✅ Written to applications.md (backup: applications.md.bak)');
} else if (DRY_RUN) {
  console.log('(dry-run — no changes written)');
} else {
  console.log('✅ No changes needed');
}
