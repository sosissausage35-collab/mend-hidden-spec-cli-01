// main.ts is mend, the CLI SPEC.md specifies. The kit's starter did sections 1 to 4, 9 and 10 of SPEC.md: the
// command line, the output and exit codes, safe paths, format detection, JSON edits and the all-or-nothing write.
// This version adds the rest: matching lines at three tiers (section 5), unified diffs (section 6),
// SEARCH/REPLACE blocks (section 7) and V4A patches (section 8), plus move output (`R <old> -> <new>`).
// Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to
// runner.ts (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: { old: string; new: string }[] = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/* ------------------------------------------------------------------ */
/* Files as lines (SPEC.md section 3) and matching lines (section 5)  */
/* ------------------------------------------------------------------ */

interface FileParts {
  lines: string[];
  br: string;
  final: boolean;
}

/** Split a file's text at its own line break; the last empty piece after a final break is not a line. */
function splitFile(text: string): FileParts {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { lines: parts, br, final };
}

function joinFile(p: FileParts): string {
  if (p.lines.length === 0) return '';
  return p.lines.join(p.br) + (p.final ? p.br : '');
}

const stripTrail = (s: string): string => s.replace(/[ \t]+$/, '');
const stripLead = (s: string): string => s.replace(/^[ \t]+/, '');
const stripBoth = (s: string): string => stripLead(stripTrail(s));
const leadOf = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
};

/** Line equality at one tier: 0 exact, 1 trailing spaces/tabs ignored, 2 leading and trailing ignored. */
function lineEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return stripTrail(a) === stripTrail(b);
  return stripBoth(a) === stripBoth(b);
}

/** Every position at or after `from` where O matches the file's lines at this tier. */
function occurrencesAt(lines: string[], o: string[], tier: number, from: number): number[] {
  const out: number[] = [];
  if (o.length === 0) return out;
  for (let i = from; i + o.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < o.length; j++) {
      if (!lineEq(lines[i + j]!, o[j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier (0, then 1, then 2; only 0 when strict) at which O occurs at or after `from`. */
function firstTier(lines: string[], o: string[], strict: boolean, from = 0): { tier: number; pos: number[] } | null {
  const max = strict ? 0 : 2;
  for (let t = 0; t <= max; t++) {
    const pos = occurrencesAt(lines, o, t, from);
    if (pos.length > 0) return { tier: t, pos };
  }
  return null;
}

/** Does O match the file's lines at this one position and tier? */
function matchesAt(lines: string[], o: string[], at: number, tier: number): boolean {
  if (at < 0 || at + o.length > lines.length) return false;
  for (let j = 0; j < o.length; j++) {
    if (!lineEq(lines[at + j]!, o[j]!, tier)) return false;
  }
  return true;
}

/** One line of N: `text` to write, or `ctx`, the index into O of the context line it is. */
interface NLine {
  text: string;
  ctx: number;
}

/**
 * Build the replacement lines for a match at `at`. A context line is written as the file's own matched line;
 * at tier 2 every other non-blank line that starts with O's first line's indent has that indent replaced by
 * the file's first matched line's indent; at tiers 0 and 1 lines are written as they are.
 */
function buildNew(fileLines: string[], at: number, o: string[], n: NLine[], tier: number): string[] {
  const f = at < fileLines.length ? leadOf(fileLines[at]!) : '';
  const p = o.length > 0 ? leadOf(o[0]!) : '';
  const out: string[] = [];
  for (const e of n) {
    if (e.ctx >= 0) {
      out.push(fileLines[at + e.ctx]!);
      continue;
    }
    if (tier === 2 && e.text !== '' && e.text.trim() !== '' && e.text.startsWith(p)) {
      out.push(f + e.text.slice(p.length));
    } else {
      out.push(e.text);
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Unified diffs (SPEC.md section 6)                                  */
/* ------------------------------------------------------------------ */

type BodyKind = ' ' | '-' | '+' | '\\';
interface BodyLine {
  kind: BodyKind;
  text: string;
}
interface Hunk {
  a: number;
  body: BodyLine[];
  noEol: boolean;
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;

/** A line that opens a `diff --git` section header, well formed or not. */
function isDiffGit(line: string): boolean {
  return line === 'diff --git' || line.startsWith('diff --git ');
}

/** Parse a `diff --git a/<X> b/<Y>` line, or null when it is not of that form. */
function diffGitPaths(line: string): { old: string; new: string } | null {
  const parts = line.split(' ');
  if (parts.length !== 4 || parts[0] !== 'diff' || parts[1] !== '--git') return null;
  const a = parts[2]!;
  const b = parts[3]!;
  if (!a.startsWith('a/') || a.length < 3 || !b.startsWith('b/') || b.length < 3) return null;
  return { old: a.slice(2), new: b.slice(2) };
}

/** The path a `--- ` or `+++ ` line names, or null for `/dev/null`. */
function headerPath(line: string): string | null {
  const t = line.slice(4).split('\t')[0]!.trim();
  if (t === '/dev/null') return null;
  if (t.startsWith('a/') || t.startsWith('b/')) return t.slice(2);
  return t;
}

/** Collect a hunk body starting at `start`; returns the body and the index of the first line after it. */
function collectBody(lines: string[], start: number): { body: BodyLine[]; next: number } {
  const body: BodyLine[] = [];
  let i = start;
  while (i < lines.length) {
    const l = lines[i]!;
    if (isDiffGit(l)) break;
    if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
    if (l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+' || l[0] === '\\') {
      body.push({ kind: (l === '' ? ' ' : l[0]!) as BodyKind, text: l === '' ? '' : l.slice(1) });
      i++;
    } else {
      break;
    }
  }
  while (body.length > 0) {
    const last = body[body.length - 1]!;
    if (last.kind === ' ' && last.text === '') body.pop();
    else break;
  }
  return { body, next: i };
}

/** Whether a `\` line follows the hunk's last context or `+` line. */
function hunkNoEol(body: BodyLine[]): boolean {
  for (let j = body.length - 1; j >= 0; j--) {
    if (body[j]!.kind === ' ' || body[j]!.kind === '+') {
      return body[j + 1] !== undefined && body[j + 1]!.kind === '\\';
    }
  }
  return false;
}

/** A hunk's old lines O and new lines N (with context lines marked by their index into O). */
function hunkON(h: Hunk): { o: string[]; n: NLine[] } {
  const o: string[] = [];
  const n: NLine[] = [];
  for (const b of h.body) {
    if (b.kind === ' ') {
      o.push(b.text);
      n.push({ text: b.text, ctx: o.length - 1 });
    } else if (b.kind === '-') {
      o.push(b.text);
    } else if (b.kind === '+') {
      n.push({ text: b.text, ctx: -1 });
    }
  }
  return { o, n };
}

interface Section {
  oldPair: string | null | undefined;
  newPair: string | null | undefined;
  renameFrom: string | undefined;
  renameTo: string | undefined;
  diffOld: string | undefined;
  diffNew: string | undefined;
  create: boolean;
  del: boolean;
  hunks: Hunk[];
}

function firstDefined<T>(...vals: (T | undefined)[]): T {
  for (const v of vals) {
    if (v !== undefined) return v;
  }
  throw new Error('unreachable');
}

/** Apply one hunk to a file's parts; `d` is the drift of the hunks applied so far in this section. */
function applyHunk(parts: FileParts, h: Hunk, d: number, strict: boolean, path: string): { parts: FileParts; delta: number } {
  const { o, n } = hunkON(h);
  const lines = parts.lines;
  if (o.length === 0) {
    let idx = h.a + d;
    if (idx < 0) idx = 0;
    if (idx > lines.length) idx = lines.length;
    const atEnd = idx === lines.length;
    const nl = lines.slice(0, idx).concat(
      n.map((e) => e.text),
      lines.slice(idx),
    );
    return { parts: { lines: nl, br: parts.br, final: atEnd ? !h.noEol : parts.final }, delta: n.length };
  }
  const found = firstTier(lines, o, strict);
  if (found === null) throw new Fail('no-match', path);
  const target = h.a - 1 + d;
  let best = found.pos[0]!;
  for (const p of found.pos) {
    if (Math.abs(p - target) < Math.abs(best - target)) best = p;
  }
  const atEnd = best + o.length === lines.length;
  const rep = buildNew(lines, best, o, n, found.tier);
  const nl = lines.slice(0, best).concat(rep, lines.slice(best + o.length));
  return { parts: { lines: nl, br: parts.br, final: atEnd ? !h.noEol : parts.final }, delta: n.length - o.length };
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: Section[] = [];
  let sec: Section | null = null;
  let seenHunk = false;
  const startSection = (s: Section): void => {
    sections.push(s);
    sec = s;
    seenHunk = false;
  };
  const blankSection = (): Section => ({
    oldPair: undefined,
    newPair: undefined,
    renameFrom: undefined,
    renameTo: undefined,
    diffOld: undefined,
    diffNew: undefined,
    create: false,
    del: false,
    hunks: [],
  });

  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (isDiffGit(line)) {
      const p = diffGitPaths(line);
      if (p === null) throw new Exit2(`error: parse ${i + 1}`);
      const s = blankSection();
      s.diffOld = p.old;
      s.diffNew = p.new;
      startSection(s);
      i++;
      continue;
    }
    if (sec !== null && !seenHunk && line.startsWith('--- ')) {
      const next = lines[i + 1];
      if (next === undefined || !next.startsWith('+++ ')) throw new Exit2(`error: parse ${i + 2}`);
      sec.oldPair = headerPath(line);
      sec.newPair = headerPath(next);
      i += 2;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      const s = blankSection();
      s.oldPair = headerPath(line);
      s.newPair = headerPath(lines[i + 1]!);
      startSection(s);
      i += 2;
      continue;
    }
    if (line.startsWith('@@')) {
      if (sec === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = HUNK_RE.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      const { body, next } = collectBody(lines, i + 1);
      sec.hunks.push({ a: Number(m[1]), body, noEol: hunkNoEol(body) });
      seenHunk = true;
      i = next;
      continue;
    }
    if (sec !== null && !seenHunk) {
      if (line.startsWith('+++ ')) sec.newPair = headerPath(line);
      else if (line.startsWith('rename from ')) sec.renameFrom = line.slice('rename from '.length).trim();
      else if (line.startsWith('rename to ')) sec.renameTo = line.slice('rename to '.length).trim();
      else if (line.startsWith('new file mode')) sec.create = true;
      else if (line.startsWith('deleted file mode')) sec.del = true;
    }
    i++;
  }

  return sections.map((s) => {
    const oldP: string | null = firstDefined(s.oldPair, s.renameFrom, s.diffOld, null);
    const newP: string | null = firstDefined(s.newPair, s.renameTo, s.diffNew, null);
    const isCreate = oldP === null || s.create;
    const isDelete = !isCreate && (newP === null || s.del);
    if (isCreate) {
      const p = newP;
      const hunks = s.hunks;
      return (tree: Tree) => {
        if (p === null) throw new Fail('unsafe', '/dev/null');
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) !== null) throw new Fail('exists', p);
        const plus: string[] = [];
        let noEol = false;
        for (const h of hunks) {
          for (let j = 0; j < h.body.length; j++) {
            if (h.body[j]!.kind === '+') {
              plus.push(h.body[j]!.text);
              noEol = h.body[j + 1] !== undefined && h.body[j + 1]!.kind === '\\';
            }
          }
        }
        tree.now.set(p, plus.length === 0 ? '' : plus.join('\n') + (noEol ? '' : '\n'));
      };
    }
    if (isDelete) {
      const p = oldP;
      return (tree: Tree) => {
        if (p === null) throw new Fail('unsafe', '/dev/null');
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) === null) throw new Fail('missing', p);
        tree.now.set(p, null);
      };
    }
    const from = oldP!;
    const to = newP!;
    const hunks = s.hunks;
    const move = from !== to;
    return (tree: Tree) => {
      if (!safe(from)) throw new Fail('unsafe', from);
      if (move && !safe(to)) throw new Fail('unsafe', to);
      const before = tree.get(from);
      if (before === null) throw new Fail('missing', from);
      if (move && tree.get(to) !== null) throw new Fail('exists', to);
      let parts = splitFile(before);
      let d = 0;
      for (const h of hunks) {
        const r = applyHunk(parts, h, d, strict, from);
        parts = r.parts;
        d += r.delta;
      }
      const text = joinFile(parts);
      if (!move) {
        tree.now.set(from, text);
      } else {
        tree.now.set(from, null);
        tree.now.set(to, text);
        tree.moves.push({ old: from, new: to });
      }
    };
  });
}

/* ------------------------------------------------------------------ */
/* SEARCH/REPLACE blocks (SPEC.md section 7)                          */
/* ------------------------------------------------------------------ */

function srEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevPath: string | null = null;
  let searchFrom = 0;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const searchLine = i + 1;
    let path: string | null = null;
    for (let j = i - 1; j >= searchFrom; j--) {
      const t = lines[j]!.trim();
      if (t === '' || t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) path = prevPath;
    if (path === null) throw new Exit2(`error: parse ${searchLine}`);
    let sep = -1;
    let j = i + 1;
    while (j < lines.length) {
      const l = lines[j]!;
      if (l.trimEnd() === '<<<<<<< SEARCH') break;
      if (l.trimEnd() === '=======') {
        sep = j;
        break;
      }
      j++;
    }
    if (sep < 0) throw new Exit2(`error: parse ${searchLine}`);
    let rep = -1;
    let k = sep + 1;
    while (k < lines.length) {
      const l = lines[k]!;
      if (l.trimEnd() === '<<<<<<< SEARCH') break;
      if (l.trimEnd() === '>>>>>>> REPLACE') {
        rep = k;
        break;
      }
      k++;
    }
    if (rep < 0) throw new Exit2(`error: parse ${searchLine}`);
    const oldLines = lines.slice(i + 1, sep);
    const newLines = lines.slice(sep + 1, rep);
    edits.push(srEdit(path, oldLines, newLines, strict));
    prevPath = path;
    searchFrom = rep + 1;
    i = rep + 1;
  }
  return edits;
}

function srEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    const parts = splitFile(before);
    const found = firstTier(parts.lines, oldLines, strict);
    if (found === null) throw new Fail('no-match', path);
    if (found.pos.length > 1) throw new Fail('ambiguous', path);
    const at = found.pos[0]!;
    const n: NLine[] = newLines.map((t) => ({ text: t, ctx: -1 }));
    const rep = buildNew(parts.lines, at, oldLines, n, found.tier);
    const nl = parts.lines.slice(0, at).concat(rep, parts.lines.slice(at + oldLines.length));
    tree.now.set(path, joinFile({ lines: nl, br: parts.br, final: parts.final }));
  };
}

/* ------------------------------------------------------------------ */
/* V4A patches (SPEC.md section 8)                                    */
/* ------------------------------------------------------------------ */

interface Chunk {
  anchor: string | null;
  body: BodyLine[];
  eof: boolean;
}

function chunkON(ch: Chunk): { o: string[]; n: NLine[] } {
  const o: string[] = [];
  const n: NLine[] = [];
  for (const b of ch.body) {
    if (b.kind === ' ') {
      o.push(b.text);
      n.push({ text: b.text, ctx: o.length - 1 });
    } else if (b.kind === '-') {
      o.push(b.text);
    } else if (b.kind === '+') {
      n.push({ text: b.text, ctx: -1 });
    }
  }
  return { o, n };
}

/** First line at or after `from` equal to the anchor at the first tier where one is, or -1. */
function findAnchor(lines: string[], anchor: string, strict: boolean, from: number): number {
  const max = strict ? 0 : 2;
  for (let t = 0; t <= max; t++) {
    for (let j = from; j < lines.length; j++) {
      if (lineEq(lines[j]!, anchor, t)) return j;
    }
  }
  return -1;
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = lines.length - 1;
  while (last >= 0 && blank(lines[last]!)) last--;
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);

  const edits: Edit[] = [];
  const isSectionStart = (l: string): boolean =>
    l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (blank(line)) {
      i++;
      continue;
    }
    if (line.startsWith('*** Add File: ')) {
      const p = line.slice('*** Add File: '.length).trim();
      const raw: { text: string; no: number }[] = [];
      i++;
      while (i < last && !isSectionStart(lines[i]!)) {
        const l = lines[i]!;
        if (l.startsWith('***')) throw new Exit2(`error: parse ${i + 1}`);
        raw.push({ text: l, no: i + 1 });
        i++;
      }
      while (raw.length > 0 && blank(raw[raw.length - 1]!.text)) raw.pop();
      for (const r of raw) {
        if (r.text !== '' && !r.text.startsWith('+')) throw new Exit2(`error: parse ${r.no}`);
      }
      const fileLines = raw.map((r) => (r.text === '' ? '' : r.text.slice(1)));
      edits.push((tree: Tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
      });
      continue;
    }
    if (line.startsWith('*** Delete File: ')) {
      const p = line.slice('*** Delete File: '.length).trim();
      edits.push((tree: Tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) === null) throw new Fail('missing', p);
        tree.now.set(p, null);
      });
      i++;
      continue;
    }
    if (line.startsWith('*** Update File: ')) {
      const p = line.slice('*** Update File: '.length).trim();
      const updateLine = i + 1;
      i++;
      let moveTo: string | null = null;
      if (i < last && lines[i]!.startsWith('*** Move to: ')) {
        moveTo = lines[i]!.slice('*** Move to: '.length).trim();
        i++;
      }
      const chunks: Chunk[] = [];
      let cur: Chunk | null = null;
      const endChunk = (): void => {
        if (cur !== null) {
          chunks.push(cur);
          cur = null;
        }
      };
      while (i < last && !isSectionStart(lines[i]!)) {
        const l = lines[i]!;
        if (l.trim() === '*** End of File') {
          if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
          cur.eof = true;
          endChunk();
          i++;
          continue;
        }
        if (l.startsWith('@@')) {
          endChunk();
          const anchor = l.slice(2).trim();
          cur = { anchor: anchor === '' ? null : anchor, body: [], eof: false };
          i++;
          continue;
        }
        if (l.startsWith('***')) throw new Exit2(`error: parse ${i + 1}`);
        if (l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+') {
          if (cur === null) {
            if (chunks.length > 0) {
              if (blank(l)) {
                i++;
                continue;
              }
              throw new Exit2(`error: parse ${i + 1}`);
            }
            cur = { anchor: null, body: [], eof: false };
          }
          cur.body.push({ kind: (l === '' ? ' ' : l[0]!) as BodyKind, text: l === '' ? '' : l.slice(1) });
          i++;
          continue;
        }
        throw new Exit2(`error: parse ${i + 1}`);
      }
      endChunk();
      if (chunks.length > 0) {
        const lastChunk = chunks[chunks.length - 1]!;
        while (lastChunk.body.length > 0) {
          const b = lastChunk.body[lastChunk.body.length - 1]!;
          if (b.kind === ' ' && b.text === '') lastChunk.body.pop();
          else break;
        }
      }
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${updateLine}`);
      edits.push(v4aUpdateEdit(p, moveTo, chunks, strict));
      continue;
    }
    throw new Exit2(`error: parse ${i + 1}`);
  }
  return edits;
}

function v4aUpdateEdit(path: string, moveTo: string | null, chunks: Chunk[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    let parts = splitFile(before);
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== null) {
        const at = findAnchor(parts.lines, ch.anchor, strict, cursor);
        if (at < 0) throw new Fail('no-match', path);
        cursor = at + 1;
      }
      const { o, n } = chunkON(ch);
      if (o.length === 0) {
        const idx = ch.eof ? parts.lines.length : Math.min(cursor, parts.lines.length);
        const nl = parts.lines.slice(0, idx).concat(
          n.map((e) => e.text),
          parts.lines.slice(idx),
        );
        parts = { lines: nl, br: parts.br, final: parts.final };
        cursor = idx + n.length;
        continue;
      }
      let found: { tier: number; at: number } | null = null;
      if (ch.eof) {
        const at = parts.lines.length - o.length;
        if (at >= cursor) {
          const max = strict ? 0 : 2;
          for (let t = 0; t <= max; t++) {
            if (matchesAt(parts.lines, o, at, t)) {
              found = { tier: t, at };
              break;
            }
          }
        }
      } else {
        const f = firstTier(parts.lines, o, strict, cursor);
        if (f !== null) found = { tier: f.tier, at: f.pos[0]! };
      }
      if (found === null) throw new Fail('no-match', path);
      const rep = buildNew(parts.lines, found.at, o, n, found.tier);
      const nl = parts.lines.slice(0, found.at).concat(rep, parts.lines.slice(found.at + o.length));
      parts = { lines: nl, br: parts.br, final: parts.final };
      cursor = found.at + rep.length;
    }
    const text = joinFile(parts);
    if (moveTo === null) {
      tree.now.set(path, text);
    } else {
      tree.now.set(path, null);
      tree.now.set(moveTo, text);
      tree.moves.push({ old: path, new: moveTo });
    }
  };
}

/* ------------------------------------------------------------------ */
/* JSON edits (SPEC.md section 9, as the starter had them)            */
/* ------------------------------------------------------------------ */

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

/* ------------------------------------------------------------------ */
/* Command line, output and exit codes (sections 1, 2 and 10)         */
/* ------------------------------------------------------------------ */

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    edits =
      kind === 'json'
        ? jsonEdits(text, lines)
        : kind === 'unified'
          ? unifiedEdits(lines, strict)
          : kind === 'search-replace'
            ? srEdits(lines, strict)
            : v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  // A move that succeeded prints one `R <old> -> <new>` line, sorting by <new>, instead of the `D`+`A` pair,
  // when <old> existed before the patch and does not after it, and <new> did not exist before it and does after it.
  const moved: { old: string; new: string }[] = [];
  for (const m of tree.moves) {
    if (tree.original(m.old) !== null && tree.get(m.old) === null && tree.original(m.new) === null && tree.get(m.new) !== null) {
      moved.push(m);
    }
  }
  const newOfMove = new Map<string, string>();
  const oldOfMove = new Set<string>();
  for (const m of moved) {
    newOfMove.set(m.new, m.old);
    oldOfMove.add(m.old);
  }
  interface Row {
    key: string;
    text: string;
  }
  const rows: Row[] = [];
  for (const p of [...tree.now.keys()]) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    if (newOfMove.has(p)) continue;
    if (was !== null && now === null && oldOfMove.has(p)) continue;
    rows.push({ key: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  for (const m of moved) rows.push({ key: m.new, text: `R ${m.old} -> ${m.new}` });
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  if (!check) {
    for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  const out = rows.map((r) => r.text);
  return { code: 0, out: [...out, `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
