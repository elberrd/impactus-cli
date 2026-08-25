import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';

export function gateReport() {
  const checks = [];
  return {
    checks,
    check(item, ok, note = '') {
      checks.push({ item, ok, note });
      return this;
    },
    get violations() {
      return checks.filter((c) => !c.ok).map((c) => `${c.item}: ${c.note || 'failed'}`);
    },
    get passed() {
      return this.violations.length === 0;
    },
  };
}

function fileSize(path, fs) {
  const n = fs.statSync(path).size;
  return n < 1024 ? `${n}B` : `${(n / 1024).toFixed(1)}KB`;
}

export function artifactsExist(envelope, run) {
  const fs = run.fs;
  const report = gateReport();
  const artifacts = envelope.artifacts || [];
  // An empty list must FAIL, not pass vacuously — otherwise an agent that did
  // nothing (and declared nothing) would sail through the gate.
  if (!artifacts.length) {
    return report.check('artifacts', false, 'the envelope lists no artifacts — the agent must name the files it produced');
  }
  for (const a of artifacts) {
    const exists = fs.existsSync(a);
    report.check(a, exists, exists ? `exists, ${fileSize(a, fs)}` : 'declared artifact does not exist');
  }
  return report;
}

export function filesNonEmpty(envelope, run) {
  const fs = run.fs;
  const report = gateReport();
  const artifacts = envelope.artifacts || [];
  if (!artifacts.length) {
    return report.check('artifacts', false, 'the envelope lists no artifacts — there is nothing to verify');
  }
  for (const a of artifacts) {
    if (!fs.existsSync(a) || !fs.statSync(a).isFile()) continue;
    const empty = fs.statSync(a).size === 0;
    report.check(a, !empty, empty ? 'declared artifact is empty' : fileSize(a, fs));
  }
  return report;
}

export function diffMatchesClaims(envelope, run) {
  const report = gateReport();
  for (const f of envelope.changed_files || []) {
    const exists = run.fs.existsSync(f);
    report.check(f, exists, exists ? 'exists' : 'claimed changed file does not exist');
  }
  return report;
}

/**
 * Why a reproduction test failed — only a test-level assertion (expected vs
 * actual) is a valid RED. A missing module, a syntax error or a broken
 * environment also "fails", but proves nothing about the bug, so it must not
 * unlock the fix phase. Unknown stays invalid on purpose: a RED we cannot
 * explain is not evidence.
 */
const RED_ENVIRONMENT = [
  [/cannot find (module|package)/i, 'module not found'],
  [/ERR_MODULE_NOT_FOUND|MODULE_NOT_FOUND/, 'module not found'],
  [/command not found|ENOENT/, 'command or file not found'],
  [/EADDRINUSE|address already in use/i, 'address already in use'],
  [/(missing|not set|undefined).{0,60}(environment variable|env var)/i, 'missing environment configuration'],
  [/(environment variable|env var).{0,60}(missing|not set|undefined|required)/i, 'missing environment configuration'],
  [/npm ERR!/, 'dependency error'],
];
const RED_SYNTAX = [
  [/SyntaxError/, 'SyntaxError'],
  [/Pars(e|ing) ?[Ee]rror/, 'parse error'],
  [/Unexpected token/, 'unexpected token'],
  [/Transform failed/i, 'transform failed'],
];
/** An explicit assertion report: the runner's error class, or a printed diff. */
const ASSERTION_REPORT = /AssertionError|ERR_ASSERTION|Expected[:\s][\s\S]{0,400}?Received[:\s]/;
const RED_ASSERTION = [
  ASSERTION_REPORT, // node:test, chai, vitest, jest/vitest printed diff
  /expect\(/, // jest/vitest: expect(received).toBe(expected)
  /expected .{1,160} to (be|equal|deep|strictly|match|contain|include|have|throw)/i, // prose assertions
];

/**
 * Blank out the values an assertion report compares — quoted strings and the
 * printed diff lines. A bug about file-not-found handling legitimately expects
 * `'ENOENT'`, and a parser bug expects `"Unexpected token }"`: those tokens
 * describe the behavior under test, not a broken run.
 */
function withoutComparedValues(text) {
  return text
    .replace(/^\s*[+-]\s.*$/gm, '') // diff lines of the printed comparison
    // Quoted expected/actual values — single line, bounded, so a stray
    // apostrophe can never blank out the real reason further down.
    .replace(/(['"`])(?:\\.|(?!\1)[^\\\n]){0,200}\1/g, "''");
}

/** Classify a failing test run's output → { valid, classification, note }. */
export function validateRedReason(outputText) {
  const text = String(outputText || '');
  // Environment and syntax are checked FIRST: their output often quotes test
  // code (an `expect(` code frame) that would otherwise read as an assertion.
  // When the runner DID print an assertion report, those checks read the output
  // without the compared values — otherwise an expectation about 'ENOENT' or a
  // "Unexpected token" message would be misread as a broken environment.
  const scan = ASSERTION_REPORT.test(text) ? withoutComparedValues(text) : text;
  for (const [re, label] of RED_ENVIRONMENT) {
    if (re.test(scan)) {
      return {
        valid: false,
        classification: 'environment',
        note: `${label} — the test fails on setup, not on the bug; fix imports/environment so it fails on an assertion`,
      };
    }
  }
  for (const [re, label] of RED_SYNTAX) {
    if (re.test(scan)) {
      return {
        valid: false,
        classification: 'syntax',
        note: `${label} — the code does not even parse; fix the syntax so the test fails on an assertion`,
      };
    }
  }
  for (const re of RED_ASSERTION) {
    if (re.test(text)) {
      return { valid: true, classification: 'assertion', note: 'test-level assertion failure — the bug is reproduced' };
    }
  }
  return {
    valid: false,
    classification: 'unknown',
    note: 'failure reason unclear — rewrite the reproduction so it fails with an explicit expected-vs-actual assertion',
  };
}

/**
 * Brief/issue line `Spec: 0003 (S-1, FR-2)` → { specId, ids }, or null when
 * the text carries no Spec reference — the coverage check is skipped then
 * (proportionality: not every task is born from a spec).
 */
export function parseSpecLine(text) {
  const m = /^Spec:\s*(\d{4})\s*\(([^)]+)\)/m.exec(String(text || ''));
  if (!m) return null;
  const ids = m[2].split(',').map((s) => s.trim()).filter(Boolean);
  return ids.length ? { specId: m[1], ids } : null;
}

/**
 * Brief/issue meta line `Kind: foundation` or `Kind: kit` → true. The
 * task-sequencer copies the line from the greenfield foundation issue (01) or
 * the core-component-kit issue (02) into the brief (same contract as
 * `Spec:`): it arms the test phase's `npm run build` check — a scaffold
 * whose unit tests pass can still fail the production build, and the kit's
 * shared components must compile in the production build before feature
 * tasks build on them.
 */
export function isFoundationBrief(text) {
  return /^Kind:\s*(foundation|kit)\b/im.test(String(text || ''));
}

/** Explicit opt-in for the runner that deliberately skips tests and review. */
export function isPrototypeBrief(text) {
  let fence = null;
  for (const line of String(text || '').split(/\r?\n/)) {
    const marker = /^\s*(`{3,}|~{3,})/.exec(line);
    if (marker) {
      const candidate = { char: marker[1][0], length: marker[1].length };
      if (!fence) fence = candidate;
      else if (fence.char === candidate.char && candidate.length >= fence.length) fence = null;
      continue;
    }
    if (!fence && /^Mode:\s*prototype\s*$/i.test(line)) return true;
  }
  return false;
}

/**
 * Brief meta line `Surface: ui` (or `Surface: ui, api`) → lowercase token
 * list, or null when the brief carries no Surface line. Same contract as
 * `Spec:`/`Kind:`: the task-sequencer writes it at line start, the UI gate
 * greps it. Null does NOT stand the gate down — a run that changed frontend
 * component files is checked anyway; only an explicit Surface line WITHOUT
 * `ui` (e.g. `Surface: api`) does.
 */
export function parseSurfaceLine(text) {
  const m = /^Surface:\s*(.+)$/m.exec(String(text || ''));
  if (!m) return null;
  const items = m[1].split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  return items.length ? items : null;
}

const SCAN_SKIP = new Set(['node_modules', 'dist', 'build', 'coverage']);

/**
 * Only a *.test.* / *.spec.* file proves anything. Docs quote the marker
 * (the tdd skill, the specs cookbook, this repo's own README) and git grep
 * sees them all — without this filter, shipped prose would pass the gate.
 */
function isTestPath(path) {
  const parts = String(path).split('/');
  if (parts.some((p) => SCAN_SKIP.has(p))) return false;
  return /\.(test|spec)\./.test(parts.at(-1) || '');
}

/**
 * Recursive *.test.* / *.spec.* listing — the coverage-gate fallback when git
 * grep cannot answer, and the deterministic test-file census the regression
 * floor (modules/floor.mjs) counts.
 */
export function listTestFiles(dir, acc = [], depth = 0) {
  if (depth > 8) return acc;
  let entries = [];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const e of entries) {
    if (e.name.startsWith('.') || SCAN_SKIP.has(e.name)) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) listTestFiles(p, acc, depth + 1);
    else if (/\.(test|spec)\./.test(e.name)) acc.push(p);
  }
  return acc;
}

/**
 * Traceability gate (C2/C3): every id the brief promises (`Spec: NNNN (…)`)
 * must appear in some test file's `spec:NNNN covers:…` marker. git grep sees
 * the whole tree (untracked test files included); without git, a recursive
 * scan answers instead. BOTH paths count only *.test.* / *.spec.* files —
 * a marker quoted in documentation is not coverage.
 */
export function checkSpecCoverage({ specId, ids, repoRoot = process.cwd() }) {
  const report = gateReport();
  const markerRe = new RegExp(`spec:${specId}\\s+covers:([A-Za-z0-9_,-]+)`);
  const covered = new Map(); // id → first "file:line" that covers it
  let markers = 0;
  const record = (where, text) => {
    const m = markerRe.exec(text);
    if (!m) return;
    markers += 1;
    for (const id of m[1].split(',').map((s) => s.trim()).filter(Boolean)) {
      if (!covered.has(id)) covered.set(id, where);
    }
  };

  let grepLines = null;
  try {
    grepLines = execFileSync('git', ['grep', '-n', '--untracked', '-e', `spec:${specId}`], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).split('\n').filter(Boolean);
  } catch {
    grepLines = null; // no git, not a repo, or zero hits → scan test files by hand
  }
  if (grepLines) {
    for (const line of grepLines) {
      const m = /^([^:]+):(\d+):(.*)$/.exec(line);
      if (m && isTestPath(m[1])) record(`${m[1]}:${m[2]}`, m[3]);
    }
  } else {
    for (const file of listTestFiles(repoRoot)) {
      let text = '';
      try {
        text = readFileSync(file, 'utf8');
      } catch {
        continue;
      }
      const rows = text.split('\n');
      for (let i = 0; i < rows.length; i++) {
        if (rows[i].includes(`spec:${specId}`)) record(`${relative(repoRoot, file)}:${i + 1}`, rows[i]);
      }
    }
  }

  if (!markers) {
    report.check(`spec:${specId}`, false, `no test file carries a "spec:${specId} covers:…" marker`);
  }
  for (const id of ids || []) {
    const at = covered.get(id);
    report.check(id, Boolean(at), at ? `covered by ${at}` : 'in no covers: list — write (or mark) the test that proves it');
  }
  return report;
}

/**
 * Does the markdown carry a mermaid diagram? True only for a fence OPENED at
 * line start with ```mermaid. Fences are tracked the same way
 * `parseChecklistItems` tracks them (which delimiter char opened the block, and
 * CRLF-safe splitting): a ```mermaid line INSIDE an already-open ~~~ or ````
 * block is content — specs quote this very rule — and must not count. An
 * indented ```mermaid is not at line start, so it opens a fence without
 * counting as a diagram.
 * Twin of `specHasDiagram` in `fia-templates/scripts/plan-docs.mjs` (that one
 * only detects, this one gates): the two must agree.
 */
export function specHasDiagram(md) {
  let fence = null;
  for (const line of String(md || '').split(/\r?\n/)) {
    const f = /^(\s*)(`{3,}|~{3,})\s*(.*)$/.exec(line);
    if (!f) continue;
    const ch = f[2][0];
    if (fence) {
      if (ch === fence) fence = null;
      continue;
    }
    fence = ch;
    if (!f[1] && ch === '`' && /^mermaid\b/i.test(f[3].trim())) return true;
  }
  return false;
}

/**
 * Spec diagram gate: a spec a student has to read must SHOW the flow, not only
 * describe it. The spec is located by its 4-digit id (the slug is whatever the
 * author chose, so the directory is listed instead of guessed). Read-only and
 * total: a missing directory, a missing spec or an unreadable file all become
 * one failing check with the fix in the note — never a throw.
 */
export function checkSpecDiagram({ specId, aiDocsDir = 'ai-docs', repoRoot = process.cwd() }) {
  const report = gateReport();
  const id = String(specId ?? '').trim();
  const base = isAbsolute(aiDocsDir) ? aiDocsDir : join(repoRoot, aiDocsDir);
  const specsDir = join(base, 'specs');
  const pattern = `${aiDocsDir}/specs/${id}-<slug>.md`;
  let names = [];
  try {
    names = readdirSync(specsDir).filter((n) => n.startsWith(`${id}-`) && n.endsWith('.md'));
  } catch {
    names = []; // no specs/ directory at all → same failure as an absent spec
  }
  names.sort();
  if (!names.length) {
    return report.check(
      `spec:${id}`,
      false,
      `spec file not found — expected ${pattern} (the id is the 4-digit prefix, the rest of the name is a slug)`,
    );
  }
  const name = names[0];
  const item = `${aiDocsDir}/specs/${name}`.replaceAll('\\', '/');
  let md = null;
  try {
    md = readFileSync(join(specsDir, name), 'utf8');
  } catch {
    md = null; // unreadable — reported below, never thrown
  }
  if (md == null) return report.check(item, false, 'spec file cannot be read — check the file permissions');
  const has = specHasDiagram(md);
  return report.check(
    item,
    has,
    has
      ? 'carries a ```mermaid diagram'
      : 'no ```mermaid block — add a mermaid flow diagram to the spec\'s "## Flow" section (right after "## Scope") so a reader sees the flow at a glance',
  );
}

/**
 * Checkbox inventory of a brief — every `- [ ]` / `- [x]` bullet outside
 * fenced code blocks, tagged with its nearest heading. Objectives, Acceptance
 * Criteria and Quality Checklist all count: the brief announces completion
 * through its boxes, so an unchecked one is an unfinished claim. Fences are
 * skipped because briefs quote test skeletons (and sometimes this very
 * template) in code blocks.
 */
export function parseChecklistItems(text) {
  const items = [];
  let section = '';
  // The delimiter char that opened the current fence (` or ~) — a ``` line
  // inside a ~~~ block is content, it neither opens nor closes anything.
  let fence = null;
  // \r?\n: a CRLF brief (Windows editor, core.autocrlf) must parse the same —
  // a stray \r used to make every box invisible, silently disabling the gate.
  for (const line of String(text || '').split(/\r?\n/)) {
    const f = /^\s*(`{3,}|~{3,})/.exec(line);
    if (f) {
      const ch = f[1][0];
      if (!fence) fence = ch;
      else if (ch === fence) fence = null;
      continue;
    }
    if (fence) continue;
    const heading = /^#{1,6}\s+(.*)$/.exec(line);
    if (heading) {
      section = heading[1].trim();
      continue;
    }
    // GFM task items: -, * or + bullets, and ordered `1.` / `1)` lists.
    const item = /^\s*(?:[-*+]|\d+[.)])\s+\[([ xX])\]\s+(.*)$/.exec(line);
    if (item) items.push({ section, checked: item[1] !== ' ', text: item[2].trim() });
  }
  return items;
}

/**
 * The one sanctioned annotation, at the very END of the item's text:
 * `— N/A` or `— N/A (<reason>)`. Anchoring matters twice over: a hyphen only
 * counts when whitespace-separated (`non-N/A rows` is content, not a claim),
 * and only a TRAILING match is an annotation (an N/A mid-sentence never is) —
 * an unanchored strip would collapse distinct boxes that share a prefix into
 * one identity. `*`/`_`/backtick decoration around N/A is tolerated (models
 * love bolding it); capture 1 = the decorated N/A, capture 2 = `(reason)`.
 */
const NA_ANNOTATION = /(?:\s[—–-]+|[—–])\s*([*_`]*N\/A\b[*_`]*)\s*(\([^)]*\))?\s*$/i;

/**
 * A checklist item's IDENTITY: section + text with the one sanctioned
 * annotation (`— N/A (<reason>)`) stripped. Ticking a box and appending that
 * annotation are the only edits reconciliation allows, so they must not
 * change what box this is — everything else (rewording, moving to another
 * section) does, and reads as a replaced box.
 */
export function checklistItemKey(item) {
  const text = String(item.text || '')
    .replace(NA_ANNOTATION, '')
    .trim();
  // NUL separator: with a printable one, text shifted between the section
  // heading and the item ("A B" + "C" vs "A" + "B C") would collide.
  return `${item.section || ''}\u0000${text}`;
}

/**
 * Boxes of `before` that no longer exist in `after` (by identity, multiset —
 * two same-text boxes need two survivors). This is what makes the count guard
 * honest: a checklist that swapped a hard box for a trivial ticked one keeps
 * its length but did not reconcile anything.
 */
export function checklistDrift(before, after) {
  const counts = new Map();
  for (const item of after || []) {
    const key = checklistItemKey(item);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  const removed = [];
  for (const item of before || []) {
    const key = checklistItemKey(item);
    const left = counts.get(key) || 0;
    if (left > 0) counts.set(key, left - 1);
    else removed.push(`${item.section ? `${item.section} › ` : ''}${item.text}`.slice(0, 160));
  }
  return removed;
}

/**
 * Acceptance-checklist gate (C8): a run may not close while the brief still
 * has unchecked boxes — the builder ticks what it VERIFIED (or annotates
 * N/A); the gate only refuses, it never ticks a box itself. Reads the file
 * from DISK, not the prompt snapshot: the ticks happen during the run.
 * Returns null when the path is missing/unreadable or carries no checkboxes
 * (proportionality: not every prompt is a brief with a checklist).
 * The report carries `.items` (the parsed boxes) so the checklist gate can
 * compare identities between its two passes.
 */
export function checkAcceptanceChecklist(briefPath) {
  let text = null;
  try {
    text = readFileSync(briefPath, 'utf8');
  } catch {
    return null;
  }
  const items = parseChecklistItems(text);
  if (!items.length) return null;
  const report = gateReport();
  for (const item of items) {
    const label = `${item.section ? `${item.section} › ` : ''}${item.text}`.slice(0, 160);
    report.check(label, item.checked, item.checked ? 'ticked' : 'unchecked — verify it and tick, annotate N/A, or resolve it');
    // An N/A tick is a claim, and a claim needs its evidence: the reason. A
    // bare `— N/A` is exactly the rubber stamp the reconciliation prompt
    // forbids, so code refuses it instead of trusting the prompt was obeyed.
    // Only the ANNOTATION shape counts (NA_ANNOTATION, trailing) — an item
    // whose own text mentions N/A ("Show N/A for missing values", "non-N/A
    // rows") is content, not a claim, and is never flagged.
    const na = item.checked ? NA_ANNOTATION.exec(item.text) : null;
    if (na && !(na[2] && /\(\s*[^)\s]/.test(na[2]))) {
      report.check(label, false, 'ticked as N/A without a reason — annotate `— N/A (<reason>)`');
    }
  }
  report.items = items;
  return report;
}

export function verdictConsistent(envelope) {
  const report = gateReport();
  const approved = Boolean(envelope.approved);
  const blocking = envelope.blocking || [];
  const unmet = (envelope.findings || []).filter((f) => !f.met).map((f) => f.requirement);
  report.check(
    'approved vs blocking',
    !(approved && blocking.length),
    approved && blocking.length ? `${blocking.length} blocking while approved=true` : 'ok',
  );
  report.check(
    'approved vs findings',
    !(approved && unmet.length),
    approved && unmet.length ? `${unmet.length} unmet while approved=true` : 'ok',
  );
  report.check(
    'rejection names a problem',
    approved || blocking.length > 0 || unmet.length > 0,
    approved || blocking.length || unmet.length ? 'verdict supported' : 'approved=false with no reason',
  );
  return report;
}

/**
 * fda_bug's ONE-WAY gate on --resume. The reproduction is proven RED once —
 * before any fix — and its proof (the saved red_check result) is bound to the
 * reproduction it proved. Once the fix is on disk the reproduction PASSES, so
 * re-validating would close the run as "bug not reproduced": a dead end that
 * spends a recovery for zero tokens. The proof is replayable when the
 * reproduction itself was replayed (red_test reused from disk) — regardless
 * of whether `build` saved a result: a builder round that reported
 * `status=fail` after applying the fix, and a verdict `--redo build`, both
 * leave no build.json, and both used to dead-end here. A red_test that
 * EXECUTED wrote a new reproduction; it must be validated, never replayed.
 *
 * `proof.proof_of` is the key of the red_test result the proof belongs to
 * (utils.savedPhaseKey); a proof without one was written by an older runtime
 * and is accepted on a replayed reproduction (there was only ever one).
 * Returns the proof to replay, or null when the gate must run.
 */
export function replayableRedProof({ redReplayed = false, proof = null, redKey = null } = {}) {
  if (!redReplayed) return null;
  if (!proof || proof.red?.valid !== true) return null;
  if (proof.proof_of !== undefined && proof.proof_of !== null && proof.proof_of !== redKey) return null;
  return proof;
}
