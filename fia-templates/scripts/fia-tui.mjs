#!/usr/bin/env node
/**
 * FIA TUI — terminal dashboard for the project: tasks, specs, milestones,
 * agents and FDA runs in one screen, refreshing while an FDA works.
 * Decision record: tui-plan.md in the impactus internal-docs repo.
 *
 * Read-only by design: it renders what the runner and the commands wrote and
 * never writes back — so it is always safe to leave open during a run (the
 * FDA lock only guards writers). Editing (roster, inbox…) stays in the web
 * viewer and the slash commands.
 *
 * Data comes from fia-tui-data.mjs (SQLite over imp/data/fia.db + the
 * plan-docs.mjs parsers over ai-docs/). The refresh loop is two cheap checks
 * per tick: `PRAGMA data_version` on one long-lived connection for the trace,
 * chokidar with a debounce for the markdown — only a changed watermark pays
 * for a re-read, and both back off when the keyboard goes idle.
 *
 * Usage (from the project root — `npm run tui` or `imp tui`):
 *   node imp/scripts/fia-tui.mjs [--db imp/data/fia.db] [--ai-docs ai-docs]
 *                                [--config imp/fia.config.yaml] [--once] [--no-alt]
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import React from 'react';
import { render, Box, Text, useApp, useInput, useWindowSize } from 'ink';
import chokidar from 'chokidar';
import { fmtDur, fmtAge, fmtTime, fmtTokens, fmtCost, durSec } from '../modules/format.mjs';
import { outcomeLabel } from '../modules/outcome.mjs';
import * as data from './fia-tui-data.mjs';
import { renderMarkdown } from './fia-tui-md.mjs';

const h = React.createElement;
const { useEffect, useMemo, useRef, useState } = React;

const TABS = ['Home', 'Work', 'Runs', 'Plan', 'Agents', 'Pi'];

function truncateCells(s, n) {
  if (n <= 0) return '';
  if (s.length <= n) return s;
  return n === 1 ? '…' : `${s.slice(0, n - 1)}…`;
}

/**
 * One function for what the header DRAWS and what the mouse HITS.
 * Ink's wrap:truncate on the title+tabs Text used to clip Agents/Pi under
 * the FDA badge while hit-testing still assumed the full untruncated row —
 * clicks landed on the wrong tab (or on none). Tabs never yield; the
 * project name and then the status shrink instead.
 */
export function computeHeaderLayout({ cols, projectName = '', status = 'idle', padX = 1 } = {}) {
  const inner = Math.max(0, (Number(cols) || 0) - padX * 2);
  const tabLabels = TABS.map((name, i) => ` ${i + 1} ${name} `);
  const tabsW = tabLabels.reduce((n, l) => n + l.length, 0);

  const pack = (brand, name, stat) => {
    const namePart = brand && name ? ` — ${name}` : name || '';
    const left = `${brand}${namePart}`;
    const spacer = left ? '   ' : '';
    const gap = stat ? 1 : 0;
    return { brand, namePart, left, spacer, stat, width: left.length + spacer.length + tabsW + gap + stat.length };
  };

  let brand = 'impactus';
  let name = String(projectName);
  let stat = String(status || 'idle');
  let p = pack(brand, name, stat);
  while (p.width > inner && name.length) {
    name = truncateCells(name, name.length - 1);
    p = pack(brand, name, stat);
  }
  if (p.width > inner) {
    brand = '';
    p = pack(brand, name, stat);
  }
  while (p.width > inner && name.length) {
    name = truncateCells(name, name.length - 1);
    p = pack(brand, name, stat);
  }
  while (p.width > inner && stat.length) {
    stat = truncateCells(stat, stat.length - 1);
    p = pack(brand, name, stat);
  }

  const title = `${p.left}${p.spacer}`;
  let x = padX + title.length;
  const tabs = tabLabels.map((label, i) => {
    const r = { i, name: TABS[i], label, x0: x, x1: x + label.length };
    x += label.length;
    return r;
  });
  return { brand: p.brand, namePart: p.namePart, spacer: p.spacer, title, tabs, status: p.stat, padX };
}

/** Tab index under a header click, or -1. y is 0-based screen row. */
export function hitHeaderTab(layout, x, y) {
  if (y !== 0 || !layout?.tabs) return -1;
  return layout.tabs.findIndex((t) => x >= t.x0 && x < t.x1);
}

/**
 * How `v` launches the web viewer: absolute --db/--ai-docs and the project
 * cwd, so a leftover process on :4600 from a moved folder cannot steal the
 * tab and show "No runs yet" while this TUI still has the live FDA.
 */
export function viewerLaunchSpec(opts, tab = 0) {
  const script = join(dirname(fileURLToPath(import.meta.url)), 'fia-viewer.mjs');
  const view =
    tab === 3 ? ['--view', 'plan'] : tab === 4 ? ['--view', 'agents'] : tab === 5 ? ['--view', 'pi'] : [];
  const root = resolve(opts.root || process.cwd());
  const defaults = data.defaultPaths();
  return {
    args: [
      script,
      '--detach',
      '--db',
      resolve(root, opts.dbPath || defaults.dbPath),
      '--ai-docs',
      resolve(root, opts.aiDocsDir || defaults.aiDocsDir),
      ...view,
    ],
    cwd: root,
  };
}

// One glyph+color per status, shared by every tab — same palette family as
// the web viewer (cyan = active, green = done, red = broken).
const STATUS = {
  done: { glyph: '✓', color: 'green' },
  success: { glyph: '✓', color: 'green' },
  completed: { glyph: '✓', color: 'green' },
  'in-progress': { glyph: '●', color: 'cyan' },
  in_progress: { glyph: '●', color: 'cyan' },
  running: { glyph: '●', color: 'cyan' },
  pending: { glyph: '○', color: 'gray' },
  not_started: { glyph: '○', color: 'gray' },
  draft: { glyph: '○', color: 'gray' },
  defined: { glyph: '◆', color: 'yellow' },
  blocked: { glyph: '■', color: 'red' },
  deferred: { glyph: '·', color: 'gray' },
  fail: { glyph: '✗', color: 'red' },
  failed: { glyph: '✗', color: 'red' },
  error: { glyph: '✗', color: 'red' },
  skipped: { glyph: '»', color: 'gray' },
};
const st = (s) => STATUS[s] || { glyph: '?', color: 'gray' };

const trunc = (s, w) => {
  s = String(s == null ? '' : s);
  return s.length > w ? s.slice(0, Math.max(0, w - 1)) + '…' : s;
};
const pad = (s, w) => trunc(s, w).padEnd(w);
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

/** Selection kept inside a fixed-height window (simple list virtualization). */
function windowed(items, sel, height) {
  if (items.length <= height) return { start: 0, slice: items };
  const start = clamp(sel - Math.floor(height / 2), 0, items.length - height);
  return { start, slice: items.slice(start, start + height) };
}

function Bar({ done, total, width = 14, color = 'green' }) {
  const w = Math.max(4, width);
  const f = total > 0 ? clamp(Math.round((done / total) * w), 0, w) : 0;
  return h(
    Text,
    null,
    h(Text, { color }, '█'.repeat(f)),
    h(Text, { color: 'gray', dimColor: true }, '░'.repeat(w - f)),
  );
}

function Card({ title, width = 24, children }) {
  return h(
    Box,
    {
      flexDirection: 'column',
      borderStyle: 'round',
      borderColor: 'gray',
      width,
      paddingX: 1,
      marginRight: 1,
      marginBottom: 0,
    },
    h(Text, { color: 'cyan', bold: true, wrap: 'truncate' }, title),
    ...(Array.isArray(children) ? children : [children]),
  );
}

// NOTE: children must come from props — React calls function components with a
// second argument, so a rest parameter here would shadow the real children.
const Line = ({ children, ...rest }) => h(Text, { wrap: 'truncate', ...rest }, children);

// ── Home ─────────────────────────────────────────────────────────────────────

function ContextGauge({ agentSessions }) {
  const rows = (agentSessions || []).filter((a) => a.context_window > 0);
  if (!rows.length) return null;
  const top = rows.reduce((a, b) =>
    b.context_tokens / b.context_window > a.context_tokens / a.context_window ? b : a,
  );
  const pct = Math.round((top.context_tokens / top.context_window) * 100);
  return h(
    Text,
    { wrap: 'truncate' },
    h(Text, { color: 'gray' }, 'context '),
    h(Bar, { done: pct, total: 100, width: 10, color: pct > 85 ? 'red' : pct > 60 ? 'yellow' : 'green' }),
    h(Text, null, ` ${pct}% `),
    h(Text, { color: 'gray' }, `(${top.agent} · ${fmtTokens(top.context_tokens)})`),
  );
}

// Exported (like DocView/TestsPane below) so tests can mount the run surfaces
// through React at a chosen width — a --once smoke frame is always 80 columns
// and never carries a selection.
export function RunPanel({ run, now }) {
  const s = run.session;
  const ph = data.currentPhase(run.phases);
  const live = s.status === 'running' && !s.stale;
  const head = live ? '● live run' : s.status === 'running' ? '◌ stale run' : 'last run';
  const phaseBits = [];
  for (const p of run.phases) {
    const g = st(p.status);
    phaseBits.push(
      h(Text, { key: p.phase_id, color: g.color }, `${g.glyph} ${p.name}`),
      h(Text, { key: p.phase_id + '_d', color: 'gray' }, ` ${fmtDur(durSec(p.started_at, p.ended_at, now))}  `),
    );
  }
  return h(
    Box,
    { flexDirection: 'column', borderStyle: 'round', borderColor: live ? 'cyan' : 'gray', paddingX: 1 },
    h(
      Line,
      null,
      h(Text, { color: live ? 'cyan' : 'gray', bold: true }, `${head}: `),
      h(Text, { bold: true }, s.fda_id),
      h(Text, { color: 'gray' }, `  ${s.fda_name || ''} · ${st(s.status).glyph} ${s.status}`),
      // The run's NAMED terminal outcome, on the first card a student sees.
      // Older runs (and databases no new Tracer has opened) carry none — the
      // bare status above stays the fallback.
      s.outcome ? h(Text, { color: 'gray' }, ` (${outcomeLabel(s.outcome)})`) : null,
      h(
        Text,
        { color: 'gray' },
        ` · ${fmtDur(durSec(s.started_at, s.ended_at, now))} · ${fmtTokens(s.total_tokens)} tok`,
      ),
    ),
    s.request ? h(Line, { color: 'gray' }, `“${trunc(s.request, 90)}”`) : null,
    ph && live
      ? h(
          Line,
          null,
          h(Text, { color: 'cyan' }, `phase: ${ph.name}`),
          h(Text, { color: 'gray' }, ` (${ph.owner}) ${fmtDur(durSec(ph.started_at, null, now))}`),
        )
      : null,
    h(Box, { flexWrap: 'wrap' }, ...phaseBits),
    live ? h(ContextGauge, { agentSessions: run.agentSessions }) : null,
  );
}

// Exported for tests — live interactive Pi command strip (mirrors RunPanel).
export function PiCommandPanel({ cmd, now, width }) {
  if (!cmd) return null;
  const live = cmd.status === 'running' || !cmd.ended_at;
  const elapsed = fmtDur(durSec(cmd.started_at, cmd.ended_at, now));
  const tokIn = cmd.tokens_in || 0;
  const tokOut = cmd.tokens_out || 0;
  const totalTok = tokIn + tokOut;
  const phases = cmd.phases || [];
  const donePhases = phases.filter((p) => p.ended_at);
  const phaseBits = [];
  for (const p of donePhases.slice(-6)) {
    phaseBits.push(
      h(Text, { key: p.id, color: 'green' }, `✓ ${trunc(p.label, 18)}`),
      h(Text, { key: `${p.id}_d`, color: 'gray' }, ` ${fmtDur(durSec(p.started_at, p.ended_at, now))}  `),
    );
  }
  return h(
    Box,
    { flexDirection: 'column', borderStyle: 'round', borderColor: live ? 'magenta' : 'gray', paddingX: 1 },
    h(
      Line,
      null,
      h(Text, { color: live ? 'magenta' : 'gray', bold: true }, live ? '● live command: ' : 'last command: '),
      h(Text, { bold: true }, `/${cmd.command}`),
      h(Text, { color: 'gray' }, ` · ${elapsed}`),
      h(
        Text,
        { color: 'gray' },
        ` · in ${fmtTokens(tokIn)} / out ${fmtTokens(tokOut)} (${fmtTokens(totalTok)} tok) · ${fmtCost(cmd.cost)}`,
      ),
    ),
    cmd.current_activity && live
      ? h(Line, { color: 'magenta' }, `activity: ${trunc(cmd.current_activity, Math.max(20, width - 14))}`)
      : null,
    phases.length ? h(Box, { flexWrap: 'wrap' }, ...phaseBits) : null,
    cmd.docs_written?.length
      ? h(Line, { color: 'gray' }, `docs: ${cmd.docs_written.slice(-3).join(', ')}${cmd.docs_written.length > 3 ? '…' : ''}`)
      : null,
  );
}

function HomeTab({ plan, sessions, totals, currentRun, liveCommand, dbMissing, now, width, dbPath, aiDocs }) {
  const o = plan.overview;
  const tc = o.counts?.tasks || {};
  const sc = o.specs?.counts || {};
  const active = (o.milestones?.milestones || []).find((m) => m.status !== 'done') || null;
  const cardW = clamp(Math.floor(width / 5) - 1, 20, 30);
  const cards = [
    h(
      Card,
      { key: 'tasks', title: 'Tasks', width: cardW },
      h(Line, null, h(Text, { bold: true }, `${tc.done || 0}/${tc.total || 0}`), h(Text, { color: 'gray' }, ' done')),
      h(
        Line,
        { color: 'gray' },
        o.next
          ? `next: ${o.next.num} ${trunc(o.next.title || '', cardW - 12)}`
          : tc.inProgress
            ? `${tc.inProgress} in progress`
            : tc.total
              ? 'frontier clear'
              : 'no tasks yet',
      ),
    ),
    h(
      Card,
      { key: 'specs', title: 'Specs', width: cardW },
      h(Line, null, h(Text, { bold: true }, `${sc.done || 0}/${sc.total || 0}`), h(Text, { color: 'gray' }, ' done')),
      h(Line, { color: 'gray' }, `${sc.inProgress || 0} in progress · ${sc.draft || 0} draft`),
    ),
    h(
      Card,
      { key: 'mile', title: 'Milestone', width: cardW },
      active
        ? h(
            Line,
            null,
            h(Text, { bold: true }, `${active.id} `),
            h(Text, { color: 'gray', wrap: 'truncate' }, trunc(active.name || '', cardW - 8)),
          )
        : h(Line, { color: 'gray' }, o.milestones?.available ? 'all done' : 'none yet'),
      active
        ? h(
            Line,
            null,
            h(Bar, { done: active.progress.done, total: active.progress.total, width: cardW - 10 }),
            h(Text, { color: 'gray' }, ` ${active.progress.done}/${active.progress.total}`),
          )
        : null,
    ),
    h(
      Card,
      { key: 'inbox', title: 'Inbox', width: cardW },
      h(
        Line,
        null,
        h(Text, { bold: true }, String(o.counts?.inboxOpen || 0)),
        h(Text, { color: 'gray' }, ' open ideas'),
      ),
      h(Line, { color: 'gray' }, (o.counts?.inboxOpen || 0) > 3 ? 'piling up — /quick them' : ' '),
    ),
    h(
      Card,
      { key: 'dev', title: 'All runs', width: cardW },
      h(
        Line,
        null,
        h(Text, { bold: true }, totals ? fmtDur(totals.seconds) : '—'),
        h(Text, { color: 'gray' }, ' dev time'),
      ),
      h(
        Line,
        { color: 'gray' },
        totals ? `${totals.sessions} runs · ${fmtTokens(totals.tokens)} tok · ${fmtCost(totals.cost)}` : 'no runs yet',
      ),
    ),
  ];
  return h(
    Box,
    { flexDirection: 'column', paddingX: 1 },
    o.available
      ? null
      : h(
          Line,
          { color: 'yellow' },
          `No ${aiDocs || 'ai-docs'}/ here yet — run /map (or /absorb) to create the plan.`,
        ),
    h(Box, { flexWrap: 'wrap' }, ...cards),
    liveCommand ? h(PiCommandPanel, { cmd: liveCommand, now, width }) : null,
    currentRun
      ? h(RunPanel, { run: currentRun, now })
      : dbMissing
        ? h(
            Line,
            { color: 'gray' },
            `No trace db yet (${dbPath || 'imp/data/fia.db'}) — the Runs tab fills up after the first /task, /quick or /goal.`,
          )
        : sessions.length
          ? h(RunPanel, { run: { session: sessions[0], phases: [], agentSessions: [] }, now })
          : null,
  );
}

// ── Work (tasks + specs) ─────────────────────────────────────────────────────

function TaskDetail({ t, height }) {
  const lines = [
    h(
      Line,
      { key: 'st' },
      h(Text, { color: 'gray' }, 'Status: '),
      h(Text, { color: st(t.status).color }, t.status),
      t.statusMismatch ? h(Text, { color: 'yellow' }, `  ⚠ index says "${t.indexStatus}"`) : null,
    ),
    h(
      Line,
      { key: 'meta', color: 'gray' },
      `Priority: ${t.priority || '—'} · Complexity: ${t.complexity || '—'} · Milestone: ${t.milestone || '—'}`,
    ),
    t.blockedBy?.length ? h(Line, { key: 'blk', color: 'gray' }, `Blocked by: ${t.blockedBy.join(', ')}`) : null,
    t.blocks?.length ? h(Line, { key: 'blks', color: 'gray' }, `Blocks: ${t.blocks.join(', ')}`) : null,
    t.delivers
      ? h(Line, { key: 'del' }, h(Text, { color: 'gray' }, 'Delivers: '), trunc(t.delivers.replace(/\s+/g, ' '), 500))
      : null,
  ];
  const room = Math.max(3, height - lines.filter(Boolean).length - 2);
  if (t.criteria?.length) {
    lines.push(
      h(
        Line,
        { key: 'ch', color: 'cyan', bold: true },
        `Acceptance criteria (${t.criteria.filter((c) => c.done).length}/${t.criteria.length})`,
      ),
    );
    for (const [i, c] of t.criteria.slice(0, room).entries()) {
      lines.push(
        h(
          Line,
          { key: `c${i}` },
          h(Text, { color: c.done ? 'green' : 'gray' }, c.done ? '☑ ' : '☐ '),
          trunc(c.text, 200),
        ),
      );
    }
    if (t.criteria.length > room)
      lines.push(h(Line, { key: 'more', color: 'gray' }, `… ${t.criteria.length - room} more`));
  }
  return h(Box, { flexDirection: 'column' }, ...lines.filter(Boolean));
}

function SpecDetail({ s, trace }) {
  const traceRows = trace?.available
    ? trace.rows
        .slice(0, 8)
        .map((r, i) =>
          h(
            Line,
            { key: `t${i}` },
            h(Text, { color: r.covered ? 'green' : 'red' }, r.covered ? '✓ ' : '✗ '),
            h(Text, null, `${r.requirement} ← ${r.scenario} → `),
            r.covered
              ? h(Text, { color: 'gray' }, trunc(r.test, 60))
              : h(Text, { color: 'red', bold: true }, 'NO TEST'),
          ),
        )
    : [];
  return h(
    Box,
    { flexDirection: 'column' },
    h(Line, null, h(Text, { color: 'gray' }, 'Status: '), h(Text, { color: st(s.status).color }, s.status)),
    h(Line, { color: 'gray' }, `Created: ${s.created || '—'} · Updated: ${s.updated || '—'}`),
    h(Line, { color: 'gray' }, `Tasks: ${s.tasks?.length ? s.tasks.join(', ') : '—'}`),
    trace?.available
      ? h(
          Line,
          { color: 'cyan', bold: true },
          `Traceability (${trace.covered}/${trace.total} covered)`,
          trace.covered < trace.total ? h(Text, { color: 'red', bold: true }, '  ⚠ uncovered requirements') : null,
        )
      : h(Line, { color: 'gray' }, 'Traceability: no table yet'),
    ...traceRows,
    s.gateLog?.length
      ? h(Line, { color: 'cyan', bold: true }, 'Gate log')
      : h(Line, { color: 'gray' }, 'Gate log: empty'),
    ...(s.gateLog || [])
      .slice(0, 6)
      .map((l, i) =>
        h(Line, { key: i, color: /passed/i.test(l) ? 'green' : /fail/i.test(l) ? 'red' : 'gray' }, trunc(l, 200)),
      ),
    h(Line, { color: 'gray' }, ' '),
    h(Line, { color: 'gray' }, '⏎ read the full spec'),
  );
}

function WorkTab({ items, sel, height, width, trace }) {
  const listW = clamp(Math.floor(width * 0.42), 30, 60);
  const rowW = listW - 4;
  const { start, slice } = windowed(items, sel, height - 2);
  const rows = slice.map((it, i) => {
    const idx = start + i;
    if (it.hdr) return h(Line, { key: `h${idx}`, color: 'cyan', bold: true }, it.hdr);
    const chosen = idx === sel;
    const item = it.task || it.spec;
    const g = st(item.status);
    const label = it.task ? `${item.num}  ${item.title}` : `${item.id}  ${item.title}`;
    return h(
      Line,
      { key: `r${idx}`, inverse: chosen },
      h(Text, { color: g.color }, `${g.glyph} `),
      pad(label, rowW - 2),
    );
  });
  const cur = items[sel];
  return h(
    Box,
    { flexDirection: 'row' },
    h(
      Box,
      { flexDirection: 'column', width: listW, borderStyle: 'round', borderColor: 'gray', paddingX: 1, height },
      ...rows,
    ),
    h(
      Box,
      { flexDirection: 'column', flexGrow: 1, borderStyle: 'round', borderColor: 'gray', paddingX: 1, height },
      cur?.task ? h(Line, { bold: true }, trunc(`Task ${cur.task.num} — ${cur.task.title}`, width - listW - 4)) : null,
      cur?.spec ? h(Line, { bold: true }, trunc(`Spec ${cur.spec.id} — ${cur.spec.title}`, width - listW - 4)) : null,
      cur?.task
        ? h(TaskDetail, { t: cur.task, height: height - 3 })
        : cur?.spec
          ? h(SpecDetail, { s: cur.spec, trace })
          : h(Line, { color: 'gray' }, 'Nothing here yet — /map creates tasks, /spec creates specs.'),
    ),
  );
}

// ── Runs ─────────────────────────────────────────────────────────────────────

export function RunsList({ sessions, sel, height, width, dbMissing, dbPath }) {
  if (dbMissing) {
    return h(
      Box,
      { flexDirection: 'column', paddingX: 1 },
      h(Line, { color: 'yellow' }, `No trace db at ${dbPath}.`),
      h(Line, { color: 'gray' }, 'Runs appear after the first FDA (/task, /quick, /bug or /goal).'),
    );
  }
  // STATUS carries the run's NAMED outcome when the trace has one, so this list
  // — the screen used to pick which run to open — separates `attempt cap
  // reached` from `blocked by a gate` instead of printing "fail" for both.
  // Labels reach 23 chars, so the column only spends terminal width that is
  // already surplus: below ~98 columns it stays 9 and REQUEST keeps every char.
  const cols = { id: 16, status: clamp(width - 88, 9, 23), age: 7, dur: 8, tok: 8, cost: 7 };
  const reqW = Math.max(16, width - Object.values(cols).reduce((a, b) => a + b, 0) - 8);
  const { start, slice } = windowed(sessions, sel, height - 3);
  return h(
    Box,
    { flexDirection: 'column', borderStyle: 'round', borderColor: 'gray', paddingX: 1, height },
    h(
      Line,
      { color: 'gray', bold: true },
      pad('RUN', cols.id) +
        pad('STATUS', cols.status) +
        pad('AGE', cols.age) +
        pad('DUR', cols.dur) +
        pad('TOKENS', cols.tok) +
        pad('COST', cols.cost) +
        'REQUEST',
    ),
    ...slice.map((s, i) => {
      const idx = start + i;
      const g = s.status === 'running' && s.stale ? { glyph: '◌', color: 'yellow' } : st(s.status);
      return h(
        Line,
        { key: s.fda_id, inverse: idx === sel },
        h(Text, { color: g.color }, `${g.glyph} `),
        pad(s.fda_id, cols.id - 2) +
          pad(s.outcome ? outcomeLabel(s.outcome) : s.status, cols.status) +
          pad(fmtAge(s.started_at), cols.age) +
          pad(fmtDur(durSec(s.started_at, s.ended_at || s.last_activity)), cols.dur) +
          pad(fmtTokens(s.total_tokens), cols.tok) +
          pad(fmtCost(s.total_cost), cols.cost) +
          trunc(s.request || '', reqW),
      );
    }),
    sessions.length ? null : h(Line, { color: 'gray' }, 'No runs recorded yet.'),
  );
}

export function RunDetail({ detail, now, height, width }) {
  const s = detail.session;
  const tokensByPhase = new Map((detail.phaseTokens || []).map((r) => [r.phase_id, r.tokens]));
  const failedGates = (detail.gates || []).filter((g) => !g.passed).length;
  const phaseRows = (detail.phases || []).map((p) => {
    const g = st(p.status);
    return h(
      Line,
      { key: p.phase_id },
      h(Text, { color: g.color }, `${g.glyph} `),
      pad(p.name, 16) +
        pad(`(${p.owner})`, 14) +
        pad(fmtDur(durSec(p.started_at, p.ended_at, now)), 9) +
        pad(fmtTokens(tokensByPhase.get(p.phase_id) || 0), 8),
      p.attempt > 0 ? h(Text, { color: 'yellow' }, ` try ${p.attempt + 1}`) : null,
      p.error ? h(Text, { color: 'red' }, ` ${trunc(p.error.replace(/\s+/g, ' '), Math.max(10, width - 60))}`) : null,
    );
  });
  // Window BOTH lists to the frame: on overflow Yoga silently drops
  // non-contiguous rows (no clipping, no scroll), so a long /goal run would
  // render an arbitrary sample of phases with nothing marked as missing.
  // Engine switches (run-start fallback or mid-run relay) — the student must
  // see WHICH engine actually did the work without opening the trace db.
  const relays = (detail.engineEvents || [])
    .filter((e) => (e.type === 'engine_fallback' || e.type === 'engine_relay') && e.payload?.from && e.payload?.to)
    .slice(-3);
  // The runner's own sentence for WHY the run stopped costs one more row.
  const whyRow = s.outcome_reason ? 1 : 0;
  const phaseRoom = Math.max(3, height - 8 - relays.length - whyRow);
  const hiddenPhases = Math.max(0, phaseRows.length - phaseRoom);
  const shownPhases = hiddenPhases ? phaseRows.slice(-phaseRoom) : phaseRows;
  const evRoom = Math.max(0, height - shownPhases.length - relays.length - whyRow - 6 - (hiddenPhases ? 1 : 0));
  // slice(-0) is slice(0) — it would return the WHOLE buffer, so guard zero.
  const events = evRoom > 0 ? (detail.events || []).slice(-evRoom) : [];
  return h(
    Box,
    { flexDirection: 'column', borderStyle: 'round', borderColor: 'gray', paddingX: 1, height },
    h(
      Line,
      null,
      h(Text, { bold: true }, s.fda_id),
      h(Text, { color: 'gray' }, `  ${s.fda_name || ''} · `),
      h(Text, { color: st(s.status).color }, s.status),
      // The run's NAMED terminal outcome, when the trace carries one. Older runs
      // (and databases the migration has not opened yet) have none — the bare
      // status above stays the fallback.
      s.outcome ? h(Text, { color: 'gray' }, ` (${outcomeLabel(s.outcome)})`) : null,
      h(
        Text,
        { color: 'gray' },
        ` · ${fmtDur(durSec(s.started_at, s.ended_at, now))} · ${fmtTokens(s.total_tokens)} tok · ${fmtCost(s.total_cost)}${failedGates ? ' · ' : ''}`,
      ),
      failedGates ? h(Text, { color: 'red' }, `${failedGates} gate fail${failedGates > 1 ? 's' : ''}`) : null,
    ),
    s.request ? h(Line, { color: 'gray' }, `“${trunc(s.request, width - 6)}”`) : null,
    // WHY it stopped, in the runner's own words. The label above is only the
    // category ("attempt cap reached"); without the sentence ("suite failed
    // after 3 fix attempt(s)") the student is back to reading the trace db.
    s.outcome_reason ? h(Line, { color: 'gray' }, `↳ ${trunc(s.outcome_reason, width - 8)}`) : null,
    ...relays.map((e, i) =>
      h(
        Line,
        { key: `relay${i}`, color: 'yellow' },
        trunc(
          `⚠ ${e.name}: ${e.payload?.from?.coding_agent} (${e.payload?.from?.model}) → ` +
            `${e.payload?.to?.coding_agent} (${e.payload?.to?.model})` +
            // Run-start fallbacks carry `reason` (no kind unless runtime-armed);
            // mid-run relays carry `kind` — show whichever explains the switch.
            `${e.payload?.kind || e.payload?.reason ? ` — ${e.payload.kind || e.payload.reason}` : ''}` +
            `${e.type === 'engine_relay' ? ' (mid-run)' : ''}`,
          width - 6,
        ),
      ),
    ),
    hiddenPhases ? h(Line, { color: 'gray' }, `… ${hiddenPhases} earlier phase${hiddenPhases > 1 ? 's' : ''}`) : null,
    ...shownPhases,
    h(ContextGauge, { agentSessions: detail.agentSessions }),
    events.length ? h(Line, { color: 'cyan', bold: true }, 'Events') : null,
    ...events.map((e) =>
      h(
        Line,
        { key: e.rid, color: 'gray' },
        `${fmtTime(e.started_at)}  ${trunc(e.name || e.type, width - 24)}`,
        e.ended_at ? ` (${fmtDur(durSec(e.started_at, e.ended_at))})` : '',
        e.tokens ? ` · ${fmtTokens(e.tokens)} tok` : '',
      ),
    ),
  );
}

// ── Plan ─────────────────────────────────────────────────────────────────────

function PlanTab({ plan, width }) {
  const o = plan.overview;
  const miles = o.milestones?.milestones || [];
  const wfSteps = o.workflow?.steps || [];
  const wfDone = wfSteps.filter((s) => s.status === 'done' || s.status === 'completed').length;
  const scr = o.counts?.screens || {};
  const comp = o.counts?.components || {};
  return h(
    Box,
    { flexDirection: 'column', paddingX: 1 },
    h(Line, { color: 'cyan', bold: true }, 'Milestones'),
    miles.length
      ? null
      : h(
          Line,
          { color: 'gray' },
          o.milestones?.available ? 'None recognized in milestones.md.' : 'No milestones.md yet — /map creates it.',
        ),
    ...miles.map((m) =>
      h(
        Line,
        { key: m.id },
        h(Text, { color: st(m.status).color }, `${st(m.status).glyph} `),
        pad(`${m.id} ${m.name || ''}`, Math.min(34, width - 30)),
        h(Bar, { done: m.progress.done, total: m.progress.total, width: 16 }),
        h(Text, { color: 'gray' }, ` ${m.progress.done}/${m.progress.total} · ${m.status}`),
      ),
    ),
    h(Box, { height: 1 }),
    h(Line, { color: 'cyan', bold: true }, 'Screens & design system'),
    h(
      Line,
      { color: 'gray' },
      `Screens: ${scr.implemented || 0}/${scr.total || 0} implemented · ${scr.partial || 0} partial · ${scr.todo || 0} todo`,
    ),
    h(Line, { color: 'gray' }, `Components in the registry: ${comp.total ?? comp.components ?? 0}`),
    h(Box, { height: 1 }),
    h(Line, { color: 'cyan', bold: true }, 'Workflow'),
    h(
      Line,
      { color: 'gray' },
      wfSteps.length
        ? `${o.workflow.status || 'pending'} · ${wfDone}/${wfSteps.length} steps done`
        : 'No workflow_progress in map.yaml yet.',
    ),
    ...wfSteps
      .slice(0, 10)
      .map((s2) =>
        h(
          Line,
          { key: s2.key },
          h(Text, { color: st(s2.status).color }, `${st(s2.status).glyph} `),
          h(Text, { color: 'gray' }, trunc(s2.name, width - 8)),
        ),
      ),
  );
}

// ── Agents ───────────────────────────────────────────────────────────────────

function AgentsTab({ roster, usage, engines, width }) {
  const purposeW = Math.max(14, width - 74);
  const d = roster.defaults;
  return h(
    Box,
    { flexDirection: 'column', paddingX: 1 },
    h(
      Line,
      { color: 'gray' },
      'Engines: ',
      engines
        ? [
            h(
              Text,
              { key: 'c', color: engines.claude_code?.installed ? 'green' : 'red' },
              `claude ${engines.claude_code?.installed ? '✓' : '✗'}`,
            ),
            h(Text, { key: 's1', color: 'gray' }, ' · '),
            h(
              Text,
              { key: 'p', color: engines.pi?.installed ? 'green' : 'red' },
              `pi ${engines.pi?.installed ? '✓' : '✗'}`,
            ),
            h(Text, { key: 's2', color: 'gray' }, ' · '),
            h(
              Text,
              { key: 'u', color: engines.cursor?.installed ? 'green' : 'red' },
              `cursor ${engines.cursor?.installed ? '✓' : '✗'}`,
            ),
            h(Text, { key: 's3', color: 'gray' }, ' · '),
            h(
              Text,
              { key: 'g', color: engines.grok?.installed && engines.grok?.logged ? 'green' : engines.grok?.installed ? 'yellow' : 'red' },
              `grok ${engines.grok?.installed ? (engines.grok?.logged ? '✓' : '✓ (login)') : '✗'}`,
            ),
          ]
        : 'checking…',
    ),
    h(
      Line,
      null,
      h(Text, { color: 'gray' }, 'Default LLM: '),
      h(Text, { color: 'cyan', bold: true }, d ? `${d.coding_agent || '—'} · ${d.model || '—'}` : '—'),
      h(Text, { color: 'gray' }, '   (dim engine/model below = inherited from this default)'),
    ),
    h(Box, { height: 1 }),
    h(
      Line,
      { color: 'gray', bold: true },
      pad('AGENT', 16) + pad('ENGINE', 13) + pad('MODEL', 26) + pad('EFFORT', 9) + pad('FB', 4) + 'PURPOSE',
    ),
    ...(roster.agents || []).map((a) =>
      h(
        Line,
        { key: a.name },
        h(Text, { color: 'cyan' }, pad(a.name, 16)),
        h(Text, { dimColor: !a.explicit?.coding_agent }, pad(a.coding_agent, 13)),
        h(Text, { dimColor: !a.explicit?.model }, pad(a.model, 26)),
        pad(a.effort || a.thinking || '—', 9) +
          pad(a.fallbacks.length ? String(a.fallbacks.length) : '—', 4) +
          trunc(a.purpose, purposeW),
      ),
    ),
    roster.agents?.length
      ? null
      : h(Line, { color: 'gray' }, 'No roster found (imp/fia.config.yaml) — is FIA installed here?'),
    h(Box, { height: 1 }),
    h(Line, { color: 'cyan', bold: true }, 'LLM usage — every run, attributed at spend time'),
    usage?.rows?.length
      ? h(
          Line,
          { color: 'gray', bold: true },
          pad('ENGINE', 13) + pad('MODEL', 30) + pad('RUNS', 6) + pad('TOKENS', 10) + pad('COST', 9) + 'LAST USED',
        )
      : h(Line, { color: 'gray' }, 'No usage recorded yet — totals appear after the first FDA run.'),
    ...(usage?.rows || [])
      .slice(0, 10)
      .map((r, i) =>
        h(
          Line,
          { key: `u${i}` },
          pad(r.coding_agent, 13) + pad(r.model, 30) + pad(String(r.runs), 6),
          h(Text, { bold: true }, pad(fmtTokens(r.tokens), 10)),
          pad(fmtCost(r.cost), 9) + (r.last_used ? `${fmtAge(r.last_used)} ago` : '—'),
        ),
      ),
    usage?.unattributed > 0
      ? h(
          Line,
          { color: 'gray' },
          `+ ${fmtTokens(usage.unattributed)} tok recorded before model stamping (kept, not re-attributed)`,
        )
      : null,
    h(Box, { height: 1 }),
    h(Line, { color: 'gray' }, 'Read-only — edit engines/models with npm run agents (web editor, refuses mid-run).'),
  );
}

// ── Pi (interactive commands + docs checklist) ───────────────────────────────

function PiTab({ telemetry, docs, sel, section, now, width, height }) {
  const live = telemetry?.live;
  const history = telemetry?.history || [];
  const totals = telemetry?.totals;
  const sections = ['live', 'history', 'docs'];
  const sec = sections[section] || 'live';

  if (sec === 'live') {
    return h(
      Box,
      { flexDirection: 'column', paddingX: 1, height },
      h(Line, { color: 'magenta', bold: true }, 'Live interactive command'),
      live
        ? h(PiCommandPanel, { cmd: live, now, width: width - 4 })
        : h(Line, { color: 'gray' }, 'No command running — start one in Pi (e.g. /map, /stack, /idea).'),
      h(Box, { height: 1 }),
      h(Line, { color: 'cyan', bold: true }, 'Session totals (finished commands)'),
      totals
        ? h(
            Line,
            { color: 'gray' },
            `${totals.commands} commands · ${fmtDur(totals.seconds)} · in ${fmtTokens(totals.tokens_in)} / out ${fmtTokens(totals.tokens_out)} · ${fmtCost(totals.cost)}`,
          )
        : h(Line, { color: 'gray' }, 'No finished commands recorded yet — telemetry starts with the next /command.'),
      h(Box, { height: 1 }),
      h(Line, { color: 'gray' }, 'Tab → cycle Live / History / Docs · telemetry is written by the Pi extension while you work.'),
    );
  }

  if (sec === 'history') {
    const cols = { cmd: 10, when: 8, dur: 8, in: 7, out: 7, cost: 7 };
    const listH = height - 5;
    const { start, slice } = windowed(history, sel, listH);
    return h(
      Box,
      { flexDirection: 'column', paddingX: 1, height },
      h(Line, { color: 'cyan', bold: true }, 'Command history'),
      history.length
        ? null
        : h(Line, { color: 'gray' }, 'Nothing recorded yet — run /map or /stack in Pi while this project has imp/data/.'),
      h(
        Line,
        { color: 'gray', bold: true },
        pad('CMD', cols.cmd) + pad('WHEN', cols.when) + pad('DUR', cols.dur) + pad('IN', cols.in) + pad('OUT', cols.out) + pad('COST', cols.cost) + 'DOCS',
      ),
      ...slice.map((r, i) => {
        const idx = start + i;
        const chosen = idx === sel;
        return h(
          Line,
          { key: r.id, inverse: chosen },
          pad(`/${r.command}`, cols.cmd) +
            pad(fmtAge(r.started_at), cols.when) +
            pad(fmtDur(durSec(r.started_at, r.ended_at, now)), cols.dur) +
            pad(fmtTokens(r.tokens_in), cols.in) +
            pad(fmtTokens(r.tokens_out), cols.out) +
            pad(fmtCost(r.cost), cols.cost) +
            trunc((r.docs_written || []).join(', ') || '—', Math.max(12, width - 52)),
        );
      }),
      chosenDetail(history[clamp(sel, 0, Math.max(0, history.length - 1))], now, width),
    );
  }

  const core = (docs || []).filter((d) => !d.optional);
  const optional = (docs || []).filter((d) => d.optional);
  const missingCore = core.filter((d) => !d.exists);
  const listH = height - 6;
  const allDocs = [...core, ...optional];
  const { start, slice } = windowed(allDocs, sel, listH);
  return h(
    Box,
    { flexDirection: 'column', paddingX: 1, height },
    h(Line, { color: 'cyan', bold: true }, 'Project documentation'),
    missingCore.length
      ? h(Line, { color: 'yellow' }, `Missing core docs: ${missingCore.map((d) => d.command).join(', ')}`)
      : h(Line, { color: 'green' }, 'All core planning docs present.'),
    h(
      Line,
      { color: 'gray', bold: true },
      pad('STATUS', 8) + pad('DOC', 28) + pad('COMMAND', 10) + 'PATH',
    ),
    ...slice.map((d, i) => {
      const idx = start + i;
      const chosen = idx === sel;
      return h(
        Line,
        { key: d.id, inverse: chosen, color: d.exists ? undefined : d.optional ? 'gray' : 'yellow' },
        pad(d.exists ? '✓' : '✗', 8) +
          pad(trunc(d.label, 26), 28) +
          pad(d.command, 10) +
          trunc(d.path, Math.max(16, width - 50)),
      );
    }),
    h(Line, { color: 'gray' }, allDocs[sel] ? `Run ${allDocs[sel].command} to create missing docs.` : '↑↓ select a row'),
  );
}

function chosenDetail(row, now, width) {
  if (!row) return null;
  const phaseLines = (row.phases || [])
    .slice(0, 6)
    .map((p, i) =>
      h(
        Line,
        { key: i, color: 'gray' },
        `  ${p.ended_at ? '✓' : '●'} ${trunc(p.label, 40)} · ${fmtDur(durSec(p.started_at, p.ended_at, now))} · in ${fmtTokens(p.tokens_in)} out ${fmtTokens(p.tokens_out)}`,
      ),
    );
  return h(
    Box,
    { flexDirection: 'column', marginTop: 1 },
    h(Line, { color: 'gray' }, row.args ? `args: ${trunc(row.args, width - 8)}` : null),
    phaseLines.length ? h(Line, { color: 'cyan', bold: true }, 'Phases') : null,
    ...phaseLines,
  );
}

// ── Markdown doc viewer (Enter on a task/spec) ───────────────────────────────
// Exported (with TestsPane) so tests can mount them through React — overlay
// components only appear on a keypress, which --once smoke frames never send.

export function DocView({ doc, height }) {
  const viewH = Math.max(3, height - 3);
  const maxScroll = Math.max(0, doc.lines.length - viewH);
  const scroll = clamp(doc.scroll, 0, maxScroll);
  return h(
    Box,
    { flexDirection: 'column', borderStyle: 'round', borderColor: 'cyan', paddingX: 1, height },
    h(
      Line,
      null,
      h(Text, { color: 'cyan', bold: true }, doc.title),
      h(Text, { color: 'gray' }, `  ${doc.path}`),
      h(
        Text,
        { color: 'gray' },
        `  ·  ${scroll + 1}–${Math.min(doc.lines.length, scroll + viewH)}/${doc.lines.length}`,
      ),
    ),
    ...doc.lines.slice(scroll, scroll + viewH).map((l, i) => h(Line, { key: scroll + i }, l || ' ')),
    h(Line, { color: 'gray' }, '↑↓/j/k scroll · PgUp/PgDn page · g/G top/bottom · Esc close'),
  );
}

// ── Tests pane (`t` streams the project's test suite) ────────────────────────

export function TestsPane({ tests, height, width }) {
  const head = tests.running
    ? h(Text, { color: 'cyan' }, '● running…')
    : tests.code === 0
      ? h(Text, { color: 'green' }, '✓ passed')
      : tests.code == null
        ? h(Text, { color: 'gray' }, 'idle')
        : h(Text, { color: 'red' }, `✗ exit ${tests.code}`);
  const viewH = Math.max(3, height - 3);
  return h(
    Box,
    { flexDirection: 'column', borderStyle: 'round', borderColor: 'cyan', paddingX: 1, height },
    h(Line, null, h(Text, { color: 'cyan', bold: true }, 'Tests  '), head),
    ...tests.lines
      .slice(-viewH)
      .map((l, i) =>
        h(Line, { key: i, color: /fail|✗|not ok/i.test(l) ? 'red' : undefined }, trunc(l, width - 4) || ' '),
      ),
    h(Line, { color: 'gray' }, tests.running ? 'Esc stop + close · output tails live' : 'Esc close · t run again'),
  );
}

// ── App ──────────────────────────────────────────────────────────────────────

function App({ opts }) {
  const { exit } = useApp();
  // Ink 7: re-renders on terminal resize by itself (no manual listener).
  const win = useWindowSize();
  const size = { cols: win.columns || 80, rows: win.rows || 30 };
  const [tab, setTab] = useState(opts.tab || 0);
  const [now, setNow] = useState(Date.now());
  const [plan, setPlan] = useState(() => data.loadPlan(opts.aiDocsDir, opts.root));
  const [roster, setRoster] = useState(() => data.loadRoster(opts.configPath));
  const [sessions, setSessions] = useState([]);
  const [totals, setTotals] = useState(null);
  const [usage, setUsage] = useState(null);
  const [currentRun, setCurrentRun] = useState(null);
  const [lock, setLock] = useState(null);
  const [engines, setEngines] = useState(null);
  const [dbMissing, setDbMissing] = useState(true);
  const [workSel, setWorkSel] = useState(1);
  const [runSel, setRunSel] = useState(0);
  const [detail, setDetail] = useState(null);
  const [doc, setDoc] = useState(null); // markdown viewer: {title, path, lines, scroll}
  const [tests, setTests] = useState(null); // tests pane: {running, lines, code}
  const [telemetry, setTelemetry] = useState(() => data.readCommandTelemetry(opts.root, opts.telemetryDir));
  const [docsChecklist, setDocsChecklist] = useState(() => data.loadDocsStatus(opts.root));
  const [piSel, setPiSel] = useState(0);
  const [piSection, setPiSection] = useState(0); // 0 live, 1 history, 2 docs

  const dbRef = useRef(null);
  const dvRef = useRef(null);
  const cursorRef = useRef(0);
  const lastKeyRef = useRef(Date.now());
  const tickRef = useRef(0);
  const testsProcRef = useRef(null);
  const testsBufRef = useRef([]);
  const layoutRef = useRef({}); // screen coordinates for mouse hit-testing
  const api = useRef({});

  const workItems = useMemo(() => {
    const items = [{ hdr: 'TASKS' }];
    for (const t of plan.tasks?.tasks || []) items.push({ task: t });
    items.push({ hdr: 'SPECS' });
    for (const s of plan.overview?.specs?.specs || []) items.push({ spec: s });
    return items;
  }, [plan]);

  // Traceability of the selected spec, re-read when the selection or plan moves.
  const trace = useMemo(() => {
    const cur = workItems[workSel];
    return cur?.spec?.file ? data.specTraceability(opts.aiDocsDir, cur.spec.file) : null;
  }, [workItems, workSel]);

  // A section header is never a selection — snap to the first real item
  // (matters when a project has specs but no tasks yet, or after a reload).
  useEffect(() => {
    if (workItems[workSel] && !workItems[workSel].hdr) return;
    const i = workItems.findIndex((it) => !it.hdr);
    if (i > 0 && i !== workSel) setWorkSel(i);
  }, [workItems, workSel]);

  const refreshPlan = () => {
    setPlan(data.loadPlan(opts.aiDocsDir, opts.root));
    setDocsChecklist(data.loadDocsStatus(opts.root));
  };

  const refreshTelemetry = () => setTelemetry(data.readCommandTelemetry(opts.root, opts.telemetryDir));

  const refreshDetail = (db, id, fresh = false) => {
    const d = data.sessionDetail(db, id);
    if (!d) return setDetail(null);
    if (fresh) cursorRef.current = 0;
    const tail = data.tailEvents(db, id, cursorRef.current);
    cursorRef.current = tail.last;
    setDetail((prev) => ({
      ...d,
      events: [...(fresh || !prev ? [] : prev.events), ...tail.events].slice(-60),
    }));
  };

  const refreshDb = (force = false) => {
    let db = dbRef.current;
    if (!db) {
      db = data.openDb(opts.dbPath);
      if (!db) return setDbMissing(true);
      dbRef.current = db;
      setDbMissing(false);
      force = true;
    }
    let dv = null;
    try {
      dv = data.dataVersion(db);
    } catch {
      return; // db vanished mid-run — keep the last good frame
    }
    if (!force && dv === dvRef.current) return;
    dvRef.current = dv;
    const list = data.listSessions(db, 60);
    setSessions(list);
    setTotals(data.devTotals(db));
    setUsage(data.modelUsage(db));
    const running = list.find((s) => s.status === 'running' && !s.stale);
    setCurrentRun(running ? data.sessionDetail(db, running.fda_id) : null);
    if (detail?.session) refreshDetail(db, detail.session.fda_id);
  };

  const refreshAll = () => {
    setLock(data.activeFdaLock(opts.root));
    refreshPlan();
    setRoster(data.loadRoster(opts.configPath));
    refreshTelemetry();
    refreshDb(true);
  };

  /** Open the selected task/spec as rendered markdown, full-screen. */
  const openDoc = (title, relPath) => {
    const d = data.readDoc(opts.aiDocsDir, relPath);
    if (!d?.exists) return;
    setDoc({ title, path: relPath, lines: renderMarkdown(d.text, Math.min(size.cols - 6, 100)), scroll: 0 });
  };

  const killTests = () => {
    const child = testsProcRef.current;
    if (!child) return;
    testsProcRef.current = null;
    try {
      if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGTERM');
      else child.kill('SIGTERM');
    } catch {
      /* already gone */
    }
  };

  /** `t`: stream the project's `npm test` into the Tests pane. */
  const startTests = () => {
    // Mid-run, a suite that writes anything ungitignored (snapshots, fixtures,
    // a lockfile touch) would land inside the FDA's permission window and be
    // rolled back as an unauthorized agent write — same rule as the hooks.
    if (lock) {
      return setTests({
        running: false,
        lines: [`An FDA run is active${lock.fda_id ? ` (${lock.fda_id})` : ''} — tests are disabled until it finishes (the run has its own test phase).`],
        code: null,
      });
    }
    if (testsProcRef.current) return setTests({ running: true, lines: [...testsBufRef.current], code: null });
    let hasScript = false;
    try {
      hasScript = Boolean(JSON.parse(readFileSync(join(opts.root, 'package.json'), 'utf8')).scripts?.test);
    } catch {
      /* no package.json here */
    }
    if (!hasScript) {
      return setTests({ running: false, lines: ['No "test" script in package.json — nothing to run.'], code: null });
    }
    testsBufRef.current = ['$ npm test', ''];
    const child = spawn('npm', ['test'], {
      cwd: opts.root,
      env: { ...process.env, CI: '1', FORCE_COLOR: '0' },
      shell: process.platform === 'win32',
      detached: process.platform !== 'win32', // own process group → Esc kills the whole suite
    });
    testsProcRef.current = child;
    const push = (chunk) => {
      // eslint-disable-next-line no-control-regex -- stripping ANSI so test output can't corrupt the layout
      const clean = String(chunk).replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
      testsBufRef.current.push(...clean.split('\n'));
      if (testsBufRef.current.length > 800) testsBufRef.current = testsBufRef.current.slice(-600);
    };
    child.stdout?.on('data', push);
    child.stderr?.on('data', push);
    child.on('error', (err) => {
      testsProcRef.current = null;
      setTests({ running: false, lines: [...testsBufRef.current, String(err?.message || err)], code: 1 });
    });
    child.on('exit', (code) => {
      if (testsProcRef.current === child) testsProcRef.current = null;
      setTests((t) => t && { running: false, lines: [...testsBufRef.current], code: code ?? 1 });
    });
    setTests({ running: true, lines: [...testsBufRef.current], code: null });
  };

  const moveSel = (dir) => {
    if (doc) {
      setDoc((d) => d && { ...d, scroll: Math.min(Math.max(0, d.scroll + dir), d.lines.length) });
      return;
    }
    if (tab === 1) {
      let i = workSel;
      do i += dir;
      while (i > 0 && i < workItems.length && workItems[i].hdr);
      if (i > 0 && i < workItems.length && !workItems[i].hdr) setWorkSel(i);
    } else if (tab === 2 && sessions.length && !detail) {
      setRunSel((s) => clamp(s + dir, 0, sessions.length - 1));
    } else if (tab === 5) {
      const sec = piSection;
      if (sec === 1) {
        const n = (telemetry?.history || []).length;
        if (n) setPiSel((s) => clamp(s + dir, 0, n - 1));
      } else if (sec === 2) {
        const n = (docsChecklist || []).length;
        if (n) setPiSel((s) => clamp(s + dir, 0, n - 1));
      }
    }
  };

  /** SGR mouse events (decoded in the stdin effect): clicks and wheel. */
  const onMouse = (b, x, y) => {
    lastKeyRef.current = Date.now();
    if (b === 64 || b === 65) return moveSel(b === 64 ? -2 : 2); // wheel
    if ((b & 3) !== 0) return; // left button only
    const L = layoutRef.current;
    if (y === 0) {
      const i = hitHeaderTab(L.header, x, y);
      if (i >= 0) {
        setDoc(null);
        if (tests && !tests.running) setTests(null);
        setDetail(null);
        setTab(i);
      }
      return;
    }
    if (doc || tests) return;
    if (tab === 1 && L.workList && x < L.workList.width && y >= L.workList.top) {
      const idx = L.workList.start + (y - L.workList.top);
      if (idx > 0 && idx < workItems.length && !workItems[idx].hdr) setWorkSel(idx);
      return;
    }
    if (tab === 2 && !detail && L.runsList && y >= L.runsList.top) {
      const idx = L.runsList.start + (y - L.runsList.top);
      if (idx >= 0 && idx < sessions.length) {
        if (idx === runSel && dbRef.current) {
          cursorRef.current = 0;
          refreshDetail(dbRef.current, sessions[idx].fda_id, true);
        } else setRunSel(idx);
      }
    }
  };
  api.current = { refreshDb, refreshPlan, refreshTelemetry, refreshAll, onMouse, killTests };

  // Refresh loop: 1s ticks, backing off to ~5s after 60s without a keypress.
  useEffect(() => {
    refreshAll();
    const timer = setInterval(() => {
      tickRef.current += 1;
      const idle = Date.now() - lastKeyRef.current > 60_000;
      if (idle && tickRef.current % 5 !== 0) return;
      setNow(Date.now());
      setLock(data.activeFdaLock(opts.root));
      api.current.refreshDb();
      api.current.refreshTelemetry?.();
      // Tests pane tails live: flush the stream buffer once per tick.
      if (testsProcRef.current) setTests((t) => t && { ...t, lines: [...testsBufRef.current] });
    }, 1000);
    let watcher = null;
    let deb = null;
    // --once renders a single frame and leaves — a watcher would never fire
    // AND trips a libuv fs-event assert on Windows short paths (RUNNER~1
    // temp dirs), so smoke frames skip it entirely.
    if (!opts.once && existsSync(opts.aiDocsDir)) {
      watcher = chokidar.watch(opts.aiDocsDir, { ignoreInitial: true, ignored: (p) => p.includes('node_modules') });
      watcher.on('all', () => {
        clearTimeout(deb);
        deb = setTimeout(() => api.current.refreshPlan(), 250);
      });
    }
    let telWatcher = null;
    let telDeb = null;
    const telDir = join(opts.root, opts.telemetryDir);
    if (!opts.once && existsSync(telDir)) {
      telWatcher = chokidar.watch(telDir, { ignoreInitial: true });
      telWatcher.on('all', () => {
        clearTimeout(telDeb);
        telDeb = setTimeout(() => api.current.refreshTelemetry?.(), 150);
      });
    }
    return () => {
      clearInterval(timer);
      clearTimeout(deb);
      clearTimeout(telDeb);
      watcher?.close();
      telWatcher?.close();
      dbRef.current?.close();
      api.current.killTests?.(); // a quit must not leave npm test running
    };
  }, []);

  // Smoke/CI mode: render one settled frame, then leave.
  useEffect(() => {
    if (!opts.once) return;
    const t = setTimeout(() => exit(), 900);
    return () => clearTimeout(t);
  }, []);

  // Mouse: enable SGR reporting and decode press/wheel events ourselves — Ink
  // has no mouse support and this is ~20 lines instead of a frozen dependency.
  useEffect(() => {
    if (!process.stdin.isTTY || !process.stdout.isTTY) return;
    process.stdout.write('\x1b[?1000h\x1b[?1006h');
    const onData = (buf) => {
      const s = String(buf);
      // eslint-disable-next-line no-control-regex -- SGR mouse sequences are ESC-prefixed by definition
      const re = /\x1b\[<(\d+);(\d+);(\d+)M/g; // press/wheel ("m" releases are ignored)
      let m;
      while ((m = re.exec(s))) api.current.onMouse(Number(m[1]), Number(m[2]) - 1, Number(m[3]) - 1);
    };
    process.stdin.on('data', onData);
    return () => {
      process.stdin.off('data', onData);
      process.stdout.write('\x1b[?1000l\x1b[?1006l');
    };
  }, []);

  // Engine probing spawns CLIs — only when the Agents tab is first opened.
  useEffect(() => {
    if (tab !== 4 || engines) return;
    const t = setTimeout(async () => {
      try {
        const { checkEngines } = await import('../modules/engines.mjs');
        setEngines(checkEngines());
      } catch {
        setEngines({});
      }
    }, 10);
    return () => clearTimeout(t);
  }, [tab]);

  const openViewer = () => {
    const spec = viewerLaunchSpec(opts, tab);
    spawn(process.execPath, spec.args, { stdio: 'ignore', detached: true, cwd: spec.cwd }).unref();
  };

  const interactive = Boolean(process.stdin.isTTY); // --once in CI has no raw mode
  useInput(
    (input, key) => {
      lastKeyRef.current = Date.now();
      if (input === 'q') return exit();

      // Markdown viewer swallows everything except quit/scroll/close.
      if (doc) {
        const page = Math.max(3, size.rows - 6);
        if (key.escape) return setDoc(null);
        if (key.upArrow || input === 'k') return moveSel(-1);
        if (key.downArrow || input === 'j') return moveSel(1);
        // Keep the STORED scroll bounded by the doc length (the render clamps
        // tighter, to the viewport) — an unbounded value would leave PgUp/k
        // subtracting from the quadrillions after a G, reading as dead keys.
        if (key.pageUp) return setDoc((d) => d && { ...d, scroll: Math.max(0, d.scroll - page) });
        if (key.pageDown) return setDoc((d) => d && { ...d, scroll: Math.min(d.scroll + page, d.lines.length) });
        if (input === 'g') return setDoc((d) => d && { ...d, scroll: 0 });
        if (input === 'G') return setDoc((d) => d && { ...d, scroll: d.lines.length });
        return;
      }
      // Tests pane: Esc stops a live run and closes; `t` re-runs when idle.
      if (tests) {
        if (key.escape) {
          killTests();
          return setTests(null);
        }
        if (input === 't' && !tests.running) return startTests();
        return;
      }

      if (/^[1-6]$/.test(input)) return setTab(Number(input) - 1);
      if (key.tab && tab === 5) return setPiSection((s) => (s + (key.shift ? 2 : 1)) % 3);
      if (key.tab) return setTab((t) => (t + (key.shift ? TABS.length - 1 : 1)) % TABS.length);
      if (input === 'r') return api.current.refreshAll();
      if (input === 'v') return openViewer();
      if (input === 't') return startTests();
      if (key.escape) return setDetail(null);
      const dir = key.upArrow || input === 'k' ? -1 : key.downArrow || input === 'j' ? 1 : 0;
      if (dir) return moveSel(dir);
      if (key.return && tab === 1) {
        const cur = workItems[workSel];
        const rel = cur?.task?.file || cur?.spec?.file;
        if (rel)
          openDoc(
            cur.task ? `Task ${cur.task.num} — ${cur.task.title}` : `Spec ${cur.spec.id} — ${cur.spec.title}`,
            rel,
          );
        return;
      }
      if (key.return && tab === 2 && sessions[runSel] && dbRef.current) {
        cursorRef.current = 0;
        refreshDetail(dbRef.current, sessions[runSel].fda_id, true);
      }
    },
    { isActive: interactive },
  );

  const cols = size.cols;
  const bodyH = Math.max(8, size.rows - 3);
  const projectName = plan.overview?.project?.name || basename(opts.root);
  const running =
    Boolean(lock) || sessions.some((s) => s.status === 'running' && !s.stale) || Boolean(telemetry?.live);

  const runningLabel = running
    ? telemetry?.live
      ? `● /${telemetry.live.command} running · FDA ${lock?.fda_id ? `(${lock.fda_id})` : 'idle'}`
      : `● FDA running${lock?.fda_id ? ` (${lock.fda_id})` : ''} — read-only`
    : 'idle';
  const header = computeHeaderLayout({ cols, projectName, status: runningLabel });

  // Screen coordinates for mouse hit-testing — same numbers the header draws.
  {
    layoutRef.current.header = header;
    layoutRef.current.tabs = header.tabs;
    const workSelC = clamp(workSel, 1, Math.max(1, workItems.length - 1));
    layoutRef.current.workList = {
      top: 2, // header row + list border
      width: clamp(Math.floor(cols * 0.42), 30, 60),
      start: windowed(workItems, workSelC, bodyH - 2).start,
    };
    layoutRef.current.runsList = {
      top: 3, // header row + border + column header
      start: windowed(sessions, runSel, bodyH - 3).start,
    };
  }

  const body = doc
    ? h(DocView, { doc, height: bodyH, width: cols })
    : tests
      ? h(TestsPane, { tests, height: bodyH, width: cols })
      : tab === 0
        ? h(HomeTab, {
            plan,
            sessions,
            totals,
            currentRun,
            liveCommand: telemetry?.live,
            dbMissing,
            now,
            width: cols,
            dbPath: opts.dbPath,
            aiDocs: opts.aiDocsDir,
          })
        : tab === 1
          ? h(WorkTab, {
              items: workItems,
              sel: clamp(workSel, 1, Math.max(1, workItems.length - 1)),
              height: bodyH,
              width: cols,
              trace,
            })
          : tab === 2
            ? detail
              ? h(RunDetail, { detail, now, height: bodyH, width: cols })
              : h(RunsList, { sessions, sel: runSel, height: bodyH, width: cols, dbMissing, dbPath: opts.dbPath })
            : tab === 3
              ? h(PlanTab, { plan, width: cols })
              : tab === 4
                ? h(AgentsTab, { roster, usage, engines, width: cols })
                : h(PiTab, {
                    telemetry,
                    docs: docsChecklist,
                    sel: piSel,
                    section: piSection,
                    now,
                    width: cols,
                    height: bodyH,
                  });

  return h(
    Box,
    { flexDirection: 'column', width: cols, height: size.rows },
    h(
      Box,
      { width: cols, paddingX: 1 },
      header.brand ? h(Text, { color: 'cyan', bold: true }, header.brand) : null,
      header.namePart ? h(Text, { color: 'gray' }, header.namePart) : null,
      header.spacer ? h(Text, {}, header.spacer) : null,
      ...header.tabs.map((t) =>
        h(Text, { key: t.name, inverse: t.i === tab, color: t.i === tab ? 'cyan' : 'gray' }, t.label),
      ),
      h(Box, { flexGrow: 1 }),
      h(Text, { color: running ? 'red' : 'gray' }, header.status),
    ),
    h(Box, { flexGrow: 1, flexDirection: 'column' }, body),
    h(
      Box,
      { paddingX: 1 },
      h(
        Line,
        { color: 'gray' },
        '1-6 tabs · ↑↓/j/k move · Tab cycle (Pi: Live/History/Docs) · ⏎ open · Esc back · t tests · r refresh · v web viewer · q quit · mouse: click tabs/rows',
      ),
    ),
  );
}

// ── CLI entry ────────────────────────────────────────────────────────────────

const USAGE = `FIA TUI — terminal dashboard for tasks, specs, milestones and FDA runs.

Usage: node imp/scripts/fia-tui.mjs [options]     (or: npm run tui · imp tui)

Options:
  --db <path>       trace db          (default imp/data/fia.db, env FIA_DB)
  --ai-docs <dir>   plan documents    (default ai-docs, env FIA_AI_DOCS)
  --config <path>   agent roster      (default imp/fia.config.yaml, env FIA_CONFIG)
  --tab <1-6>       start on this tab (Home, Work, Runs, Plan, Agents, Pi)
  --once            render one frame and exit (CI/smoke)
  --no-alt          do not switch to the alternate screen
  --help            this text

Keys:  1-6 tabs · Tab cycle · ↑↓/j/k move · Enter open (run timeline, or the
       task/spec rendered as markdown) · Esc back · t run the test suite in a
       pane · r refresh · v open the web viewer · q quit
       Pi tab: Tab cycles Live / History / Docs
Mouse: click a tab to switch (same as 1-6, no Enter) · click a list row ·
       click a selected run to open it · wheel scrolls`;

// realpath both sides: Node realpaths the ESM entry for import.meta.url, so a
// symlinked invocation path would otherwise make the CLI a silent no-op.
const isMain = (() => {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(entry)).href;
  } catch {
    return import.meta.url === pathToFileURL(resolve(entry)).href;
  }
})();
if (isMain) {
  const args = process.argv.slice(2);
  const flag = (name) => {
    const i = args.indexOf(name);
    return i === -1 ? null : args[i + 1];
  };
  if (args.includes('--help') || args.includes('-h')) {
    console.log(USAGE);
    process.exit(0);
  }
  const defaults = data.defaultPaths();
  const opts = {
    root: process.cwd(),
    dbPath: flag('--db') || defaults.dbPath,
    aiDocsDir: flag('--ai-docs') || defaults.aiDocsDir,
    configPath: flag('--config') || defaults.configPath,
    telemetryDir: defaults.telemetryDir,
    once: args.includes('--once'),
    tab: clamp((Number(flag('--tab')) || 1) - 1, 0, TABS.length - 1),
  };
  if (!process.stdout.isTTY && !opts.once) {
    console.error('The FIA TUI needs an interactive terminal.');
    console.error(
      'Machine-readable instead: npm run fda:sessions · node imp/scripts/fia-query.mjs sessions --json · npm run fda:status',
    );
    process.exit(1);
  }
  // Ink 7 handles the alternate screen itself (scrollback survives quitting);
  // mouse reporting is ours, so the exit hook resets it — a crash must never
  // leave the terminal swallowing clicks.
  const useAlt = process.stdout.isTTY && !args.includes('--no-alt');
  const mouseOff = '\x1b[?1000l\x1b[?1006l';
  if (process.stdout.isTTY) process.on('exit', () => process.stdout.write(mouseOff));
  const app = render(h(App, { opts }), {
    exitOnCtrlC: true,
    alternateScreen: useAlt,
    incrementalRendering: true,
  });
  await app.waitUntilExit();
  if (process.stdout.isTTY) process.stdout.write(mouseOff);
}
