#!/usr/bin/env node
/* eslint-disable */
//
// scripts/check-schema.js — schema-enforcement gate for the HNC CRM.
//
// Walks index.html + api/**/*.js, finds every Supabase writer call site
// (db.from('TABLE').insert(...) / .update(...) / .upsert(...)), extracts
// the column names being written, and validates them against the column
// set in schema-snapshot.json. Exits non-zero on any column that doesn't
// exist in the snapshot — which fails the Vercel build and blocks the
// deploy.
//
// The four "core" tables (appointments / leads / clients / cleaners) are
// the only ones validated; writes to other tables (settings, error_logs,
// tasks, notifications, etc.) are skipped silently. To extend coverage,
// add more tables to scripts/snapshot-schema.sql and re-snapshot.
//
// Three argument shapes are handled:
//   1. Inline object literal — `.update({ a: 1, b: 2 })` — keys parsed directly
//   2. Array of literals    — `.insert([{ a: 1 }])` — keys parsed from each
//   3. Variable reference   — `.update(payload)` — keys collected by walking
//      backwards in the same file for `var payload = {...}` plus any
//      `payload.field = ...` / `payload['field'] = ...` assignments before
//      the call. Resolution is conservative: if it can't resolve, it warns
//      but does not fail (false-positives would be deadly; we accept the
//      rare false-negative).
//
// Computed keys (`{[expr]: val}`) and spreads (`{...other}`) are skipped
// silently — they're rare in this codebase and unparseable statically.
//
// USAGE:
//   node scripts/check-schema.js          # check (exit 1 on miss)
//   node scripts/check-schema.js --verbose  # also list every site checked
//
// Wired into Vercel build via vercel.json's `buildCommand`. Local check:
//   npm run check-schema
//
// See DEVELOPMENT_GUIDE.md → "Schema enforcement workflow" for the
// regenerate-snapshot-on-migration discipline.

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.join(__dirname, '..');
const SNAPSHOT_PATH = path.join(REPO_ROOT, 'schema-snapshot.json');
const VERBOSE = process.argv.includes('--verbose');

// Tables we enforce. Writes to other tables are skipped.
const ENFORCED_TABLES = new Set(['appointments', 'leads', 'clients', 'cleaners']);

// ─── Load snapshot ───────────────────────────────────────────────────────
let snapshot;
try {
  snapshot = JSON.parse(fs.readFileSync(SNAPSHOT_PATH, 'utf8'));
} catch (e) {
  console.error('FATAL: cannot read schema-snapshot.json — run scripts/snapshot-schema.sql in Supabase and update the snapshot first.');
  console.error(e.message);
  process.exit(2);
}

const SCHEMA = {}; // {tableName: Set<columnName>}
for (const [t, cols] of Object.entries(snapshot.tables || {})) {
  SCHEMA[t] = new Set(cols.map(c => c.column));
}
for (const t of ENFORCED_TABLES) {
  if (!SCHEMA[t]) {
    console.error(`FATAL: snapshot is missing table '${t}'. Re-run scripts/snapshot-schema.sql.`);
    process.exit(2);
  }
}

// ─── Source-aware position skipping ──────────────────────────────────────
// Skips strings ('...', "...", `...`), regex /.../flags, line and block
// comments. Returns the position immediately after the construct, or the
// same position if not at one. Caller advances by 1 if no skip happened.

function skipSrcConstruct(src, i) {
  const c = src[i];
  // Line comment
  if (c === '/' && src[i + 1] === '/') {
    let j = i + 2;
    while (j < src.length && src[j] !== '\n') j++;
    return j;
  }
  // Block comment
  if (c === '/' && src[i + 1] === '*') {
    let j = i + 2;
    while (j < src.length - 1 && !(src[j] === '*' && src[j + 1] === '/')) j++;
    return j + 2;
  }
  // Single or double quoted string
  if (c === '"' || c === "'") {
    let j = i + 1;
    while (j < src.length) {
      if (src[j] === '\\') { j += 2; continue; }
      if (src[j] === c) return j + 1;
      j++;
    }
    return j;
  }
  // Template literal (no nested ${} parsing — good enough; we only need
  // to skip past it)
  if (c === '`') {
    let j = i + 1;
    while (j < src.length) {
      if (src[j] === '\\') { j += 2; continue; }
      if (src[j] === '`') return j + 1;
      // Skip ${...} interpolation balanced
      if (src[j] === '$' && src[j + 1] === '{') {
        let depth = 1; j += 2;
        while (j < src.length && depth > 0) {
          const k = skipSrcConstruct(src, j);
          if (k > j) { j = k; continue; }
          if (src[j] === '{') depth++;
          else if (src[j] === '}') depth--;
          j++;
        }
        continue;
      }
      j++;
    }
    return j;
  }
  return i;
}

// Find the position of the matching closing bracket (for `(`, `[`, or
// `{`) starting AFTER position `openPos` (which points at the opener).
// Returns the index of the closing bracket, or -1 if not found.
function findMatchingClose(src, openPos) {
  const open = src[openPos];
  const close = open === '(' ? ')' : open === '[' ? ']' : open === '{' ? '}' : null;
  if (!close) return -1;
  let depth = 1;
  let i = openPos + 1;
  while (i < src.length) {
    const k = skipSrcConstruct(src, i);
    if (k > i) { i = k; continue; }
    const c = src[i];
    if (c === open) depth++;
    else if (c === close) {
      depth--;
      if (depth === 0) return i;
    } else if (c === '(' || c === '[' || c === '{') {
      // Different bracket type — recurse via local depth tracking
      const inner = findMatchingClose(src, i);
      if (inner === -1) return -1;
      i = inner;
    }
    i++;
  }
  return -1;
}

// Skip whitespace forward
function skipWs(src, i) {
  while (i < src.length) {
    if (/\s/.test(src[i])) { i++; continue; }
    const k = skipSrcConstruct(src, i);
    if (k > i) { i = k; continue; }
    break;
  }
  return i;
}

// ─── Object literal key extraction ──────────────────────────────────────
// Given the content between `{` and `}` (NOT including the braces), extract
// the top-level keys. Returns { keys: Set, computed: boolean, spreads: boolean }.
function extractKeysFromObjectBody(body) {
  const keys = new Set();
  let computed = false;
  let spreads = false;
  let i = 0;
  while (i < body.length) {
    i = skipWs(body, i);
    if (i >= body.length) break;
    // Spread: ...
    if (body[i] === '.' && body[i + 1] === '.' && body[i + 2] === '.') {
      spreads = true;
      // Skip to next ',' at top level
      i = skipToTopLevelComma(body, i);
      if (i < body.length) i++;
      continue;
    }
    // Computed: [expr]
    if (body[i] === '[') {
      computed = true;
      const close = findMatchingClose(body, i);
      if (close === -1) break;
      i = close + 1;
      // Skip past ': value' and on to next ','
      i = skipToTopLevelComma(body, i);
      if (i < body.length) i++;
      continue;
    }
    // Quoted key: '...' or "..."
    if (body[i] === "'" || body[i] === '"') {
      const quote = body[i];
      let j = i + 1, k = '';
      while (j < body.length && body[j] !== quote) {
        if (body[j] === '\\') { k += body[j + 1]; j += 2; continue; }
        k += body[j];
        j++;
      }
      keys.add(k);
      i = j + 1;
      // Expect : or ,
      i = skipWs(body, i);
      if (body[i] === ':') {
        i = skipToTopLevelComma(body, i + 1);
      }
      if (i < body.length) i++;
      continue;
    }
    // Bare identifier key
    const idMatch = body.slice(i).match(/^([A-Za-z_$][\w$]*)/);
    if (idMatch) {
      const name = idMatch[1];
      const after = i + name.length;
      const afterWs = skipWs(body, after);
      if (body[afterWs] === ':') {
        // Regular key
        keys.add(name);
        i = skipToTopLevelComma(body, afterWs + 1);
      } else if (body[afterWs] === ',' || afterWs >= body.length || body[afterWs] === '}') {
        // Shorthand property (e.g. { foo, bar })
        keys.add(name);
        i = afterWs;
      } else if (body[afterWs] === '(') {
        // Method definition (e.g. { foo() {} }) — skip body
        const parenClose = findMatchingClose(body, afterWs);
        let braceOpen = parenClose + 1;
        braceOpen = skipWs(body, braceOpen);
        if (body[braceOpen] === '{') {
          const braceClose = findMatchingClose(body, braceOpen);
          i = braceClose + 1;
        } else {
          i = parenClose + 1;
        }
      } else {
        // Unexpected — bail to next comma
        i = skipToTopLevelComma(body, afterWs);
      }
      if (i < body.length && body[i] === ',') i++;
      continue;
    }
    // Anything else — bail to next comma
    i = skipToTopLevelComma(body, i);
    if (i < body.length) i++;
  }
  return { keys, computed, spreads };
}

// Skip to the next top-level comma (or end of body), respecting brackets,
// strings, and comments.
function skipToTopLevelComma(src, i) {
  while (i < src.length) {
    const k = skipSrcConstruct(src, i);
    if (k > i) { i = k; continue; }
    const c = src[i];
    if (c === ',') return i;
    if (c === '(' || c === '[' || c === '{') {
      const close = findMatchingClose(src, i);
      if (close === -1) return src.length;
      i = close + 1;
      continue;
    }
    i++;
  }
  return i;
}

// ─── Variable resolution ────────────────────────────────────────────────
// Given a variable name and the file contents, find all places where it's
// initialized as an object literal AND all `name.field = ...` /
// `name['field'] = ...` assignments. Returns Set<columnName>.
//
// Scope is approximated as: from the var/let/const declaration up to the
// call site. If multiple declarations exist (different scopes), we use the
// nearest declaration before `callSiteOffset`.
function resolveVarKeys(src, varName, callSiteOffset) {
  const keys = new Set();
  let resolved = false;
  let computed = false;
  let spreads = false;

  // Find the nearest `(var|let|const)\s+varName\s*=\s*{` BEFORE callSiteOffset.
  // We scan from offset 0 forward, tracking the latest match.
  let declStart = -1;
  let declBraceOpen = -1;
  const declRe = new RegExp(`\\b(?:var|let|const)\\s+${escapeRe(varName)}\\s*=`, 'g');
  let m;
  while ((m = declRe.exec(src)) !== null) {
    if (m.index >= callSiteOffset) break;
    // After the `=`, find first non-ws — must be `{` for an object literal init
    const afterEq = skipWs(src, m.index + m[0].length);
    if (src[afterEq] === '{') {
      declStart = m.index;
      declBraceOpen = afterEq;
    } else {
      // Could be a non-object initializer; record decl position but no init keys
      declStart = m.index;
      declBraceOpen = -1;
    }
  }

  if (declStart === -1) {
    // No declaration found in this file — variable is from a wider scope or
    // is a parameter. Treat as unresolved.
    return { keys, resolved: false, computed: false, spreads: false };
  }
  resolved = true;

  if (declBraceOpen !== -1) {
    const close = findMatchingClose(src, declBraceOpen);
    if (close !== -1) {
      const body = src.slice(declBraceOpen + 1, close);
      const r = extractKeysFromObjectBody(body);
      r.keys.forEach(k => keys.add(k));
      computed = computed || r.computed;
      spreads = spreads || r.spreads;
    }
  }

  // Find `varName.field = ...` and `varName['field'] = ...` between
  // declStart and callSiteOffset.
  const dotRe = new RegExp(`\\b${escapeRe(varName)}\\.([A-Za-z_$][\\w$]*)\\s*(?:=(?!=)|\\?\\?=|\\|\\|=)`, 'g');
  dotRe.lastIndex = declStart;
  while ((m = dotRe.exec(src)) !== null) {
    if (m.index >= callSiteOffset) break;
    keys.add(m[1]);
  }

  const bracketRe = new RegExp(`\\b${escapeRe(varName)}\\[(['"])([^'"]+)\\1\\]\\s*(?:=(?!=)|\\?\\?=|\\|\\|=)`, 'g');
  bracketRe.lastIndex = declStart;
  while ((m = bracketRe.exec(src)) !== null) {
    if (m.index >= callSiteOffset) break;
    keys.add(m[2]);
  }

  return { keys, resolved, computed, spreads };
}

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

// ─── Writer call site discovery ─────────────────────────────────────────
// Match `db.from('table').(insert|update|upsert)(`. Tolerates other
// receivers like `supa.`, `supabase.`, and chained queries.
const WRITER_RE = /\.from\(\s*['"]([a-zA-Z_]+)['"]\s*\)\.(insert|update|upsert)\s*\(/g;

function findWriters(src, fileLabel) {
  const out = [];
  // Disable regex skipping inside strings/comments — naive but mostly fine
  // because the .from() call pattern doesn't appear in HTML/CSS.
  let m;
  WRITER_RE.lastIndex = 0;
  while ((m = WRITER_RE.exec(src)) !== null) {
    const table = m[1];
    const op = m[2];
    const parenOpen = m.index + m[0].length - 1; // points at '('
    out.push({ table, op, parenOpen, fileLabel });
  }
  return out;
}

// Find `.from()` table reference for a writer where table-name is not
// captured by the regex (none currently — the regex requires literal
// quoted name).
//
// Calls where `.from(VAR)` is used are NOT matched, by design — we can't
// validate dynamic table names statically.

// ─── Main: walk files, collect violations ──────────────────────────────
const TARGET_FILES = [];
function collectFiles() {
  TARGET_FILES.push(path.join(REPO_ROOT, 'index.html'));
  // All .js files under api/
  walkDir(path.join(REPO_ROOT, 'api'), f => f.endsWith('.js'));
  // Top-level .js files (gcal-sync.js, service-worker.js, run-migration.js)
  for (const f of fs.readdirSync(REPO_ROOT)) {
    const full = path.join(REPO_ROOT, f);
    if (fs.statSync(full).isFile() && f.endsWith('.js') && !f.startsWith('.')) {
      TARGET_FILES.push(full);
    }
  }
}

function walkDir(dir, filter) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.git') continue;
    const full = path.join(dir, entry);
    const st = fs.statSync(full);
    if (st.isDirectory()) walkDir(full, filter);
    else if (filter(entry)) TARGET_FILES.push(full);
  }
}

const violations = []; // {file, line, table, op, badKeys, msg}
const warnings = [];   // {file, line, table, op, msg}
let stats = { sites: 0, enforced: 0, skipped: 0, literal: 0, varResolved: 0, varUnresolved: 0 };

function lineOf(src, offset) {
  let line = 1;
  for (let i = 0; i < offset && i < src.length; i++) {
    if (src[i] === '\n') line++;
  }
  return line;
}

function checkFile(filePath) {
  const src = fs.readFileSync(filePath, 'utf8');
  const fileLabel = path.relative(REPO_ROOT, filePath);
  const writers = findWriters(src, fileLabel);

  for (const w of writers) {
    stats.sites++;
    const lineNo = lineOf(src, w.parenOpen);

    if (!ENFORCED_TABLES.has(w.table)) {
      stats.skipped++;
      continue;
    }
    stats.enforced++;

    const argClose = findMatchingClose(src, w.parenOpen);
    if (argClose === -1) {
      warnings.push({ file: fileLabel, line: lineNo, table: w.table, op: w.op, msg: 'unmatched paren — parser bug?' });
      continue;
    }
    const argSrc = src.slice(w.parenOpen + 1, argClose);

    // Determine arg shape
    let argInner = skipWsString(argSrc, 0);
    const c = argSrc[argInner];

    let writeKeys = new Set();
    let resolved = false;
    let shapeNote = '';

    if (c === '{') {
      // Inline literal object (e.g. update({...}))
      const close = findMatchingClose(argSrc, argInner);
      if (close !== -1) {
        const body = argSrc.slice(argInner + 1, close);
        const r = extractKeysFromObjectBody(body);
        r.keys.forEach(k => writeKeys.add(k));
        resolved = true;
        shapeNote = 'literal object';
        if (r.spreads) shapeNote += ' (with spread)';
        if (r.computed) shapeNote += ' (with computed key)';
        stats.literal++;
      }
    } else if (c === '[') {
      // Array — could be [{...}] (literal) or [varname] or [{...},{...},...]
      const close = findMatchingClose(argSrc, argInner);
      if (close !== -1) {
        const arrayBody = argSrc.slice(argInner + 1, close);
        // Iterate top-level array elements
        let i = 0;
        let allLiteral = true;
        while (i < arrayBody.length) {
          i = skipWsString(arrayBody, i);
          if (i >= arrayBody.length) break;
          if (arrayBody[i] === '{') {
            const cb = findMatchingClose(arrayBody, i);
            if (cb !== -1) {
              const r = extractKeysFromObjectBody(arrayBody.slice(i + 1, cb));
              r.keys.forEach(k => writeKeys.add(k));
              i = cb + 1;
            } else { i++; }
          } else if (/[A-Za-z_$]/.test(arrayBody[i])) {
            // Variable inside array — resolve against full file scope
            const idMatch = arrayBody.slice(i).match(/^([A-Za-z_$][\w$]*)/);
            if (idMatch) {
              allLiteral = false;
              const r = resolveVarKeys(src, idMatch[1], w.parenOpen);
              if (r.resolved) {
                r.keys.forEach(k => writeKeys.add(k));
                resolved = true;
                shapeNote = `array containing var \`${idMatch[1]}\` resolved`;
                if (r.spreads) shapeNote += ' (with spread)';
              } else {
                shapeNote = `array containing unresolved var \`${idMatch[1]}\``;
              }
              i = skipToTopLevelComma(arrayBody, i + idMatch[1].length);
            } else { i++; }
          } else {
            i++;
          }
          if (arrayBody[i] === ',') i++;
        }
        if (allLiteral && writeKeys.size > 0) {
          resolved = true;
          shapeNote = shapeNote || 'array of literal objects';
          stats.literal++;
        }
      }
    } else if (/[A-Za-z_$]/.test(c)) {
      // Bare variable — e.g. update(payload)
      const idMatch = argSrc.slice(argInner).match(/^([A-Za-z_$][\w$]*)/);
      if (idMatch) {
        const r = resolveVarKeys(src, idMatch[1], w.parenOpen);
        if (r.resolved) {
          r.keys.forEach(k => writeKeys.add(k));
          resolved = true;
          shapeNote = `var \`${idMatch[1]}\` resolved`;
          if (r.spreads) shapeNote += ' (with spread)';
          if (r.computed) shapeNote += ' (with computed key)';
          stats.varResolved++;
        } else {
          shapeNote = `var \`${idMatch[1]}\` unresolved`;
          stats.varUnresolved++;
        }
      }
    }

    if (!resolved) {
      warnings.push({
        file: fileLabel, line: lineNo, table: w.table, op: w.op,
        msg: `couldn't statically resolve write payload (${shapeNote || 'unknown shape'}); skipped`
      });
      continue;
    }

    // Validate keys against schema
    const valid = SCHEMA[w.table];
    const badKeys = [...writeKeys].filter(k => !valid.has(k));
    if (badKeys.length > 0) {
      violations.push({
        file: fileLabel, line: lineNo, table: w.table, op: w.op,
        badKeys, shapeNote, allKeys: [...writeKeys]
      });
    }

    if (VERBOSE) {
      console.log(`  ${fileLabel}:${lineNo} .${w.op}('${w.table}') — ${shapeNote} — ${writeKeys.size} keys${badKeys.length ? ' [BAD: ' + badKeys.join(', ') + ']' : ''}`);
    }
  }
}

// Tiny inline-friendly version of skipWs for argSrc strings
function skipWsString(src, i) {
  while (i < src.length) {
    if (/\s/.test(src[i])) { i++; continue; }
    const k = skipSrcConstruct(src, i);
    if (k > i) { i = k; continue; }
    break;
  }
  return i;
}

// ─── Run ────────────────────────────────────────────────────────────────
collectFiles();
console.log(`[check-schema] snapshot generated_at: ${snapshot.generated_at || '?'}`);
console.log(`[check-schema] enforcing tables: ${[...ENFORCED_TABLES].sort().join(', ')}`);
console.log(`[check-schema] scanning ${TARGET_FILES.length} files...`);

for (const f of TARGET_FILES) checkFile(f);

console.log(`\n[check-schema] sites scanned: ${stats.sites}`);
console.log(`  enforced (core tables): ${stats.enforced}`);
console.log(`    literal-resolved: ${stats.literal}`);
console.log(`    var-resolved: ${stats.varResolved}`);
console.log(`    var-unresolved: ${stats.varUnresolved}`);
console.log(`  skipped (other tables): ${stats.skipped}`);

if (warnings.length > 0) {
  console.log(`\n[check-schema] ${warnings.length} warning(s) (unresolvable, but not failing the build):`);
  for (const w of warnings) {
    console.log(`  ⚠ ${w.file}:${w.line} .${w.op}('${w.table}') — ${w.msg}`);
  }
}

if (violations.length > 0) {
  console.error(`\n[check-schema] ❌ FAILED: ${violations.length} call site(s) write columns that don't exist in the snapshot.\n`);
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line}`);
    console.error(`    .${v.op}('${v.table}')  [${v.shapeNote}]`);
    console.error(`    ❌ unknown columns: ${v.badKeys.join(', ')}`);
    console.error(`    (all keys written: ${v.allKeys.join(', ')})`);
    console.error('');
  }
  console.error('To fix:');
  console.error('  - If the column SHOULD exist: ship a migration adding it, then refresh schema-snapshot.json (run scripts/snapshot-schema.sql in Supabase).');
  console.error('  - If the column name is a typo: fix the code.');
  console.error('  - If the column was renamed/dropped: update the code to use the current name.');
  process.exit(1);
}

console.log('\n[check-schema] ✅ all writes match the snapshot.');
process.exit(0);
