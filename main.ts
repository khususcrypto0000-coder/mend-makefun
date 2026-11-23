// mend: one patch tool for every AI edit format.
//
// Reads a patch in one of four formats (unified diff, SEARCH/REPLACE blocks,
// V4A, or JSON edits), finds the lines each edit names even when the model
// drifted their whitespace or indentation, and changes every file or none.
// The contract is SPEC.md. Node 22, standard library only.
//
// In a trial the grader runs `node main.ts` with MAKEFUN_ENV_URL set, and
// this file hands over to runner.ts (the last lines below).

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'] as const;

/** A patch the reader cannot read: exit 2 with this one line. */
class ParseError extends Error {
  readonly line: string;
  constructor(line: string) {
    super(line);
    this.line = line;
  }
}

/** One edit that failed: exit 1 with `error: <code> <path>`. */
class EditError extends Error {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    super(`${code} ${path}`);
    this.code = code;
    this.path = path;
  }
}

const isBlank = (s: string): boolean => s.trim() === '';

/** A patch's lines: split at \n, one trailing \r removed, no empty piece after a final \n. */
function splitPatch(text: string): string[] {
  if (text === '') return [];
  const parts = text.split('\n');
  if (text.endsWith('\n')) parts.pop();
  return parts.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

/** A path is safe when it is not empty, does not start with /, holds no \, and no segment is empty, . or ... */
function isSafePath(p: string): boolean {
  if (p === '' || p.startsWith('/') || p.includes('\\')) return false;
  return p.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..');
}

/** Byte order of UTF-8 paths, for the output rows. */
function pathCmp(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

/** A text file as lines, its line break, and whether it ends with one. */
interface Doc {
  lines: string[];
  br: '\r\n' | '\n';
  finalBreak: boolean;
}

function readDoc(text: string): Doc {
  if (text === '') return { lines: [], br: '\n', finalBreak: false };
  const nl = text.indexOf('\n');
  const br: '\r\n' | '\n' = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const finalBreak = text.endsWith(br);
  if (finalBreak) parts.pop();
  return { lines: parts, br, finalBreak };
}

function writeDoc(d: Doc): string {
  if (d.lines.length === 0) return '';
  return d.lines.join(d.br) + (d.finalBreak ? d.br : '');
}

/** The tree as the edits leave it. `now` holds what changed (null: deleted). */
class Tree {
  private readonly disk = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  moves: Array<[string, string]> = [];

  original(p: string): string | null {
    if (!this.disk.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.disk.set(p, v);
    }
    return this.disk.get(p) as string | null;
  }

  get(p: string): string | null {
    return this.now.has(p) ? (this.now.get(p) as string | null) : this.original(p);
  }

  set(p: string, v: string | null): void {
    this.now.set(p, v);
  }

  snapshot(): { now: Map<string, string | null>; moves: Array<[string, string]> } {
    return { now: new Map(this.now), moves: this.moves.slice() };
  }

  restore(s: { now: Map<string, string | null>; moves: Array<[string, string]> }): void {
    this.now.clear();
    for (const [k, v] of s.now) this.now.set(k, v);
    this.moves = s.moves.slice();
  }
}

type Edit = (tree: Tree) => void;

/** Matching tiers: 0 exact, 1 trailing whitespace ignored, 2 both ends ignored. */
function normLine(line: string, tier: number): string {
  if (tier === 0) return line;
  if (tier === 1) return line.replace(/[ \t]+$/, '');
  return line.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

function leadingWs(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
}

/** Positions where old occurs in lines at one tier, at or after `from`. */
function occurrencesAt(lines: string[], old: string[], tier: number, from: number): number[] {
  const found: number[] = [];
  if (old.length === 0) return found;
  const want = old.map((l) => normLine(l, tier));
  for (let i = from; i + old.length <= lines.length; i += 1) {
    let ok = true;
    for (let j = 0; j < old.length; j += 1) {
      if (normLine(lines[i + j] as string, tier) !== want[j]) {
        ok = false;
        break;
      }
    }
    if (ok) found.push(i);
  }
  return found;
}

/** The first tier at which old occurs at or after `from`, with its positions. */
function firstTier(lines: string[], old: string[], strict: boolean, from: number): { tier: number; at: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const at = occurrencesAt(lines, old, t, from);
    if (at.length > 0) return { tier: t, at };
  }
  return null;
}

/** One line of the replacement: a context line (written as the file's own line) or a new line. */
interface NewLine {
  text: string;
  ctx: boolean;
  oIdx: number; // index into the old lines, when ctx
}

/** Build the replacement lines for a match at `pos` with `tier`. */
function replacement(fileLines: string[], pos: number, oldFirst: string | null, news: NewLine[], tier: number): string[] {
  const out: string[] = [];
  for (const item of news) {
    if (item.ctx) {
      out.push(fileLines[pos + item.oIdx] as string);
      continue;
    }
    let t = item.text;
    if (tier === 2 && oldFirst !== null) {
      const p = leadingWs(oldFirst);
      const f = leadingWs(fileLines[pos] as string);
      if (t !== '' && t.trim() !== '' && t.startsWith(p)) t = f + t.slice(p.length);
    }
    out.push(t);
  }
  return out;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(value: unknown): Edit | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const obj = value as Record<string, unknown>;
  if (typeof obj.path !== 'string') return null;
  const path = obj.path as string;
  if (obj.command === 'create' && typeof obj.file_text === 'string') {
    const text = obj.file_text as string;
    return (tree) => {
      if (!isSafePath(path)) throw new EditError('unsafe', path);
      if (tree.get(path) !== null) throw new EditError('exists', path);
      tree.set(path, text);
    };
  }
  if (
    obj.command === 'str_replace' &&
    typeof obj.old_str === 'string' &&
    (obj.old_str as string) !== '' &&
    (obj.new_str === undefined || typeof obj.new_str === 'string')
  ) {
    const oldStr = obj.old_str as string;
    const newStr = (obj.new_str as string | undefined) ?? '';
    return (tree) => {
      if (!isSafePath(path)) throw new EditError('unsafe', path);
      const before = tree.get(path);
      if (before === null) throw new EditError('missing', path);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const toLf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const text = toLf(before);
      const old = toLf(oldStr);
      let count = 0;
      for (let k = text.indexOf(old); k >= 0; k = text.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new EditError('no-match', path);
      if (count > 1) throw new EditError('ambiguous', path);
      const at = text.indexOf(old);
      const out = text.slice(0, at) + toLf(newStr) + text.slice(at + old.length);
      tree.set(path, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (
    obj.command === 'insert' &&
    typeof obj.insert_line === 'number' &&
    Number.isInteger(obj.insert_line) &&
    typeof obj.new_str === 'string'
  ) {
    const atLine = obj.insert_line as number;
    const added = splitPatch(obj.new_str as string);
    return (tree) => {
      if (!isSafePath(path)) throw new EditError('unsafe', path);
      const before = tree.get(path);
      if (before === null) throw new EditError('missing', path);
      const doc = readDoc(before);
      if (atLine < 0 || atLine > doc.lines.length) throw new EditError('no-match', path);
      doc.lines.splice(atLine, 0, ...added);
      tree.set(path, writeDoc(doc));
    };
  }
  return null;
}

/** The JSON edits of a patch: one array, or one edit object a line. */
function parseJson(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) throw new ParseError('error: parse 1');
  const edits: Edit[] = [];
  if ((lines[first] as string).trimStart().startsWith('[')) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new ParseError(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(parsed)) throw new ParseError(`error: parse ${first + 1}`);
    for (const item of parsed) {
      const e = jsonEdit(item);
      if (e === null) throw new ParseError(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((line, i) => {
    if (isBlank(line)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(line));
    } catch {
      e = null;
    }
    if (e === null) throw new ParseError(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

/** One unified hunk: its old lines, its replacement lines, and its `\` flags. */
interface Hunk {
  a: number;
  oldList: string[];
  newList: NewLine[];
  plusLines: string[];
  noEolCtxPlus: boolean; // a `\` line follows the hunk's last context or `+` line
  noEolPlus: boolean; // a `\` line follows the hunk's last `+` line
}

interface BodyItem {
  kind: 'ctx' | 'old' | 'new' | 'bs';
  text: string;
}

/** Parse one hunk body starting at `start`; returns the hunk and the next line index. */
function parseHunk(lines: string[], start: number, a: number): { hunk: Hunk; next: number } {
  const items: BodyItem[] = [];
  let j = start;
  while (j < lines.length) {
    const l = lines[j] as string;
    if (l.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
    if (l === '') items.push({ kind: 'ctx', text: '' });
    else if (l[0] === ' ') items.push({ kind: 'ctx', text: l.slice(1) });
    else if (l[0] === '-') items.push({ kind: 'old', text: l.slice(1) });
    else if (l[0] === '+') items.push({ kind: 'new', text: l.slice(1) });
    else if (l[0] === '\\') items.push({ kind: 'bs', text: l.slice(1) });
    else break;
    j += 1;
  }
  while (items.length > 0) {
    const last = items[items.length - 1] as BodyItem;
    if (last.kind === 'ctx' && last.text === '') items.pop();
    else break;
  }
  const oldList: string[] = [];
  const newList: NewLine[] = [];
  const plusLines: string[] = [];
  for (const it of items) {
    if (it.kind === 'ctx') {
      oldList.push(it.text);
      newList.push({ text: it.text, ctx: true, oIdx: oldList.length - 1 });
    } else if (it.kind === 'old') {
      oldList.push(it.text);
    } else if (it.kind === 'new') {
      newList.push({ text: it.text, ctx: false, oIdx: -1 });
      plusLines.push(it.text);
    }
  }
  const lastOf = (kinds: Array<BodyItem['kind']>): number => {
    for (let k = items.length - 1; k >= 0; k -= 1) {
      if (kinds.includes((items[k] as BodyItem).kind)) return k;
    }
    return -1;
  };
  const lastCtxPlus = lastOf(['ctx', 'new']);
  const noEolCtxPlus = lastCtxPlus >= 0 && (items[lastCtxPlus + 1] as BodyItem | undefined)?.kind === 'bs';
  const lastPlus = lastOf(['new']);
  const noEolPlus = lastPlus >= 0 && (items[lastPlus + 1] as BodyItem | undefined)?.kind === 'bs';
  return { hunk: { a, oldList, newList, plusLines, noEolCtxPlus, noEolPlus }, next: j };
}

/** A unified section while it is read: its header facts and its hunks. */
interface Sect {
  diffOld: string | null;
  diffNew: string | null;
  dashOld: string | null | undefined;
  dashNew: string | null | undefined;
  renameFrom: string | null;
  renameTo: string | null;
  newFile: boolean;
  deletedFile: boolean;
  hunks: Hunk[];
}

function newSect(): Sect {
  return {
    diffOld: null,
    diffNew: null,
    dashOld: undefined,
    dashNew: undefined,
    renameFrom: null,
    renameTo: null,
    newFile: false,
    deletedFile: false,
    hunks: [],
  };
}

/** The path of a `--- ` or `+++ ` header line, `/dev/null` as null. */
function headerPath(line: string): string | null {
  let p = line.slice(4);
  const tab = p.indexOf('\t');
  if (tab >= 0) p = p.slice(0, tab);
  p = p.trim();
  if (p === '/dev/null') return null;
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  return p;
}

/** Apply one section's hunks to a document, in order. */
function applyHunks(doc: Doc, hunks: Hunk[], strict: boolean, path: string): void {
  let d = 0;
  for (const h of hunks) {
    const o = h.oldList;
    if (o.length > 0) {
      const found = firstTier(doc.lines, o, strict, 0);
      if (found === null) throw new EditError('no-match', path);
      const target = h.a - 1 + d;
      let best = found.at[0] as number;
      for (const pos of found.at) {
        if (Math.abs(pos - target) < Math.abs(best - target)) best = pos;
      }
      const news = replacement(doc.lines, best, o[0] as string, h.newList, found.tier);
      const touchesEnd = best + o.length === doc.lines.length;
      doc.lines.splice(best, o.length, ...news);
      if (touchesEnd) doc.finalBreak = !h.noEolCtxPlus;
      d += h.newList.length - o.length;
    } else {
      const idx = Math.min(Math.max(h.a + d, 0), doc.lines.length);
      const atEnd = idx === doc.lines.length;
      const news = replacement(doc.lines, idx, null, h.newList, 0);
      doc.lines.splice(idx, 0, ...news);
      if (atEnd) doc.finalBreak = !h.noEolCtxPlus;
      d += h.newList.length;
    }
  }
}

/** One unified section as an edit. */
function sectionEdit(s: Sect, strict: boolean): Edit {
  const oldPath = s.dashOld !== undefined ? s.dashOld : (s.renameFrom ?? s.diffOld);
  const newPath = s.dashNew !== undefined ? s.dashNew : (s.renameTo ?? s.diffNew);
  return (tree) => {
    for (const p of [oldPath, newPath]) {
      if (p !== null && !isSafePath(p)) throw new EditError('unsafe', p);
    }
    if (oldPath === null || s.newFile) {
      if (newPath === null) throw new EditError('missing', oldPath ?? '');
      if (tree.get(newPath) !== null) throw new EditError('exists', newPath);
      let plus: string[] = [];
      let noEol = false;
      for (const h of s.hunks) {
        plus = plus.concat(h.plusLines);
        if (h.plusLines.length > 0) noEol = h.noEolPlus;
      }
      tree.set(newPath, plus.length === 0 ? '' : plus.join('\n') + (noEol ? '' : '\n'));
      return;
    }
    if (newPath === null || s.deletedFile) {
      if (tree.get(oldPath) === null) throw new EditError('missing', oldPath);
      tree.set(oldPath, null);
      return;
    }
    if (oldPath !== newPath) {
      const before = tree.get(oldPath);
      if (before === null) throw new EditError('missing', oldPath);
      if (tree.get(newPath) !== null) throw new EditError('exists', newPath);
      const doc = readDoc(before);
      applyHunks(doc, s.hunks, strict, oldPath);
      tree.set(newPath, writeDoc(doc));
      tree.set(oldPath, null);
      tree.moves.push([oldPath, newPath]);
      return;
    }
    const before = tree.get(oldPath);
    if (before === null) throw new EditError('missing', oldPath);
    const doc = readDoc(before);
    applyHunks(doc, s.hunks, strict, oldPath);
    tree.set(oldPath, writeDoc(doc));
  };
}

/** Read a unified diff into its sections' edits. */
function parseUnified(lines: string[], strict: boolean): Edit[] {
  const sections: Sect[] = [];
  let cur: Sect | null = null;
  let inHeader = false;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] as string;
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(\S+) b\/(\S+)\s*$/.exec(line);
      if (m === null) throw new ParseError(`error: parse ${i + 1}`);
      cur = newSect();
      cur.diffOld = m[1] as string;
      cur.diffNew = m[2] as string;
      sections.push(cur);
      inHeader = true;
      i += 1;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (cur !== null && inHeader && cur.dashOld === undefined) {
        cur.dashOld = headerPath(line);
        cur.dashNew = headerPath(lines[i + 1] as string);
      } else {
        cur = newSect();
        cur.dashOld = headerPath(line);
        cur.dashNew = headerPath(lines[i + 1] as string);
        sections.push(cur);
        inHeader = true;
      }
      i += 2;
      continue;
    }
    if (line.startsWith('--- ')) {
      if (cur !== null && inHeader) throw new ParseError(`error: parse ${i + 2}`);
      i += 1;
      continue;
    }
    if (line.startsWith('@@')) {
      if (cur === null) throw new ParseError(`error: parse ${i + 1}`);
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (m === null) throw new ParseError(`error: parse ${i + 1}`);
      const parsed = parseHunk(lines, i + 1, Number(m[1]));
      cur.hunks.push(parsed.hunk);
      inHeader = false;
      i = parsed.next;
      continue;
    }
    if (cur !== null && inHeader) {
      if (line.startsWith('rename from ')) cur.renameFrom = line.slice(12).trim();
      else if (line.startsWith('rename to ')) cur.renameTo = line.slice(10).trim();
      else if (line.startsWith('new file mode')) cur.newFile = true;
      else if (line.startsWith('deleted file mode')) cur.deletedFile = true;
      i += 1;
      continue;
    }
    i += 1;
  }
  if (sections.length === 0) throw new ParseError('error: parse 1');
  return sections.map((s) => sectionEdit(s, strict));
}

/** One SEARCH/REPLACE block as an edit. */
function searchReplaceEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!isSafePath(path)) throw new EditError('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new EditError('exists', path);
      tree.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const before = tree.get(path);
    if (before === null) throw new EditError('missing', path);
    const doc = readDoc(before);
    const found = firstTier(doc.lines, oldLines, strict, 0);
    if (found === null) throw new EditError('no-match', path);
    if (found.at.length > 1) throw new EditError('ambiguous', path);
    const pos = found.at[0] as number;
    const news: NewLine[] = newLines.map((t) => ({ text: t, ctx: false, oIdx: -1 }));
    const rep = replacement(doc.lines, pos, oldLines[0] as string, news, found.tier);
    doc.lines.splice(pos, oldLines.length, ...rep);
    tree.set(path, writeDoc(doc));
  };
}

/** Read SEARCH/REPLACE blocks into edits. */
function parseSearchReplace(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevReplace = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if ((lines[i] as string).trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const s = i;
    let eq = -1;
    for (let k = s + 1; k < lines.length; k += 1) {
      if ((lines[k] as string).trimEnd() === '<<<<<<< SEARCH') break;
      if ((lines[k] as string).trimEnd() === '=======') {
        eq = k;
        break;
      }
    }
    if (eq < 0) throw new ParseError(`error: parse ${s + 1}`);
    let rep = -1;
    for (let k = eq + 1; k < lines.length; k += 1) {
      if ((lines[k] as string).trimEnd() === '<<<<<<< SEARCH') break;
      if ((lines[k] as string).trimEnd() === '>>>>>>> REPLACE') {
        rep = k;
        break;
      }
    }
    if (rep < 0) throw new ParseError(`error: parse ${s + 1}`);
    let path: string | null = null;
    for (let k = s - 1; k > prevReplace; k -= 1) {
      const t = (lines[k] as string).trim();
      if (t === '' || t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new ParseError(`error: parse ${s + 1}`);
      path = prevPath;
    }
    edits.push(searchReplaceEdit(path, lines.slice(s + 1, eq), lines.slice(eq + 1, rep), strict));
    prevPath = path;
    prevReplace = rep;
    i = rep + 1;
  }
  if (edits.length === 0) throw new ParseError('error: parse 1');
  return edits;
}

/** One V4A chunk: its anchor, its end-of-file mark, and its body lines. */
interface V4aChunk {
  anchor: string | null;
  eof: boolean;
  items: BodyItem[];
}

/** A V4A chunk's old lines and replacement lines, from its body items. */
function chunkLines(items: BodyItem[]): { oldList: string[]; newList: NewLine[] } {
  const oldList: string[] = [];
  const newList: NewLine[] = [];
  for (const it of items) {
    if (it.kind === 'ctx') {
      oldList.push(it.text);
      newList.push({ text: it.text, ctx: true, oIdx: oldList.length - 1 });
    } else if (it.kind === 'old') {
      oldList.push(it.text);
    } else if (it.kind === 'new') {
      newList.push({ text: it.text, ctx: false, oIdx: -1 });
    }
  }
  return { oldList, newList };
}

/** Apply one V4A chunk; returns the cursor after the lines it wrote. */
function applyV4aChunk(doc: Doc, chunk: V4aChunk, strict: boolean, cursor: number, path: string): number {
  if (chunk.anchor !== null) {
    let anchorAt = -1;
    for (const tier of strict ? [0] : [0, 1, 2]) {
      const at = occurrencesAt(doc.lines, [chunk.anchor], tier, cursor);
      if (at.length > 0) {
        anchorAt = at[0] as number;
        break;
      }
    }
    if (anchorAt < 0) throw new EditError('no-match', path);
    cursor = anchorAt + 1;
  }
  const { oldList, newList } = chunkLines(chunk.items);
  if (oldList.length > 0) {
    const found = firstTier(doc.lines, oldList, strict, cursor);
    if (found === null) throw new EditError('no-match', path);
    let pos: number | null = null;
    for (const p of found.at) {
      if (!chunk.eof || p + oldList.length === doc.lines.length) {
        pos = p;
        break;
      }
    }
    if (pos === null) throw new EditError('no-match', path);
    const news = replacement(doc.lines, pos, oldList[0] as string, newList, found.tier);
    doc.lines.splice(pos, oldList.length, ...news);
    return pos + news.length;
  }
  const idx = chunk.eof ? doc.lines.length : cursor;
  const news = replacement(doc.lines, idx, null, newList, 0);
  doc.lines.splice(idx, 0, ...news);
  return idx + news.length;
}

/** One V4A Update File section as an edit. */
function v4aUpdateEdit(path: string, moveTo: string | null, chunks: V4aChunk[], strict: boolean): Edit {
  return (tree) => {
    if (!isSafePath(path)) throw new EditError('unsafe', path);
    if (moveTo !== null && !isSafePath(moveTo)) throw new EditError('unsafe', moveTo);
    const before = tree.get(path);
    if (before === null) throw new EditError('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new EditError('exists', moveTo);
    const doc = readDoc(before);
    let cursor = 0;
    for (const ch of chunks) cursor = applyV4aChunk(doc, ch, strict, cursor, path);
    const out = writeDoc(doc);
    if (moveTo !== null) {
      tree.set(moveTo, out);
      tree.set(path, null);
      tree.moves.push([path, moveTo]);
    } else {
      tree.set(path, out);
    }
  };
}

const isV4aSectionStart = (l: string): boolean =>
  l.startsWith('*** Add File:') || l.startsWith('*** Delete File:') || l.startsWith('*** Update File:');

/** Read a V4A patch into its sections' edits. */
function parseV4a(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) throw new ParseError('error: parse 1');
  if ((lines[first] as string).trim() !== '*** Begin Patch') throw new ParseError(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k -= 1) {
    if (!isBlank(lines[k] as string)) {
      last = k;
      break;
    }
  }
  if ((lines[last] as string).trim() !== '*** End Patch') throw new ParseError(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i] as string;
    if (isBlank(line)) {
      i += 1;
      continue;
    }
    if (line.startsWith('*** Add File:')) {
      const path = line.slice('*** Add File:'.length).trim();
      i += 1;
      const fileLines: string[] = [];
      while (i < last && !isV4aSectionStart(lines[i] as string)) {
        const l = lines[i] as string;
        if (l === '') fileLines.push('');
        else if (l.startsWith('+')) fileLines.push(l.slice(1));
        else throw new ParseError(`error: parse ${i + 1}`);
        i += 1;
      }
      while (fileLines.length > 0 && fileLines[fileLines.length - 1] === '') fileLines.pop();
      edits.push(((p: string, ls: string[]): Edit => {
        return (tree) => {
          if (!isSafePath(p)) throw new EditError('unsafe', p);
          if (tree.get(p) !== null) throw new EditError('exists', p);
          tree.set(p, ls.length === 0 ? '' : ls.join('\n') + '\n');
        };
      })(path, fileLines));
      continue;
    }
    if (line.startsWith('*** Delete File:')) {
      const path = line.slice('*** Delete File:'.length).trim();
      i += 1;
      while (i < last && isBlank(lines[i] as string)) i += 1;
      if (i < last && !isV4aSectionStart(lines[i] as string)) throw new ParseError(`error: parse ${i + 1}`);
      edits.push(((p: string): Edit => {
        return (tree) => {
          if (!isSafePath(p)) throw new EditError('unsafe', p);
          if (tree.get(p) === null) throw new EditError('missing', p);
          tree.set(p, null);
        };
      })(path));
      continue;
    }
    if (line.startsWith('*** Update File:')) {
      const path = line.slice('*** Update File:'.length).trim();
      const updateLine = i + 1;
      i += 1;
      let moveTo: string | null = null;
      if (i < last && (lines[i] as string).startsWith('*** Move to:')) {
        moveTo = (lines[i] as string).slice('*** Move to:'.length).trim();
        i += 1;
      }
      const chunks: V4aChunk[] = [];
      let cur: V4aChunk | null = null;
      let firstChunk = true;
      while (i < last && !isV4aSectionStart(lines[i] as string)) {
        const l = lines[i] as string;
        if (l.startsWith('@@')) {
          if (cur !== null) chunks.push(cur);
          cur = { anchor: l.slice(2).trim(), eof: false, items: [] };
          firstChunk = false;
          i += 1;
          continue;
        }
        if (l === '*** End of File') {
          if (cur === null) throw new ParseError(`error: parse ${i + 1}`);
          cur.eof = true;
          chunks.push(cur);
          cur = null;
          firstChunk = false;
          i += 1;
          continue;
        }
        if (l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+') {
          if (cur === null) {
            if (!firstChunk) {
              if (l !== '') throw new ParseError(`error: parse ${i + 1}`);
              i += 1;
              continue;
            }
            cur = { anchor: null, eof: false, items: [] };
            firstChunk = false;
          }
          if (l === '') cur.items.push({ kind: 'ctx', text: '' });
          else if (l[0] === ' ') cur.items.push({ kind: 'ctx', text: l.slice(1) });
          else if (l[0] === '-') cur.items.push({ kind: 'old', text: l.slice(1) });
          else cur.items.push({ kind: 'new', text: l.slice(1) });
          i += 1;
          continue;
        }
        throw new ParseError(`error: parse ${i + 1}`);
      }
      if (cur !== null) {
        while (cur.items.length > 0) {
          const tail = cur.items[cur.items.length - 1] as BodyItem;
          if (tail.kind === 'ctx' && tail.text === '') cur.items.pop();
          else break;
        }
        if (cur.items.length > 0 || cur.anchor !== null || cur.eof) chunks.push(cur);
      }
      if (chunks.length === 0 && moveTo === null) throw new ParseError(`error: parse ${updateLine}`);
      edits.push(v4aUpdateEdit(path, moveTo, chunks, strict));
      continue;
    }
    throw new ParseError(`error: parse ${i + 1}`);
  }
  if (edits.length === 0) throw new ParseError('error: parse 1');
  return edits;
}

/** Detect the patch format (SPEC.md section 4), or null when none fits. */
function detectFormat(lines: string[]): string | null {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) return null;
  if ((lines[first] as string).trim() === '*** Begin Patch') return 'v4a';
  const c = (lines[first] as string).trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (
    lines.some(
      (l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')),
    )
  ) {
    return 'unified';
  }
  return null;
}

/** Run the CLI on its arguments; returns the exit code and the stdout lines. */
function runCli(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') {
      ended = true;
      continue;
    }
    if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=')) {
        const v = a.slice(9);
        if (format !== null || !(FORMATS as readonly string[]).includes(v)) return { code: 2, out: ['error: usage'] };
        format = v;
      } else if (a === '--check') {
        if (check) return { code: 2, out: ['error: usage'] };
        check = true;
      } else if (a === '--strict') {
        if (strict) return { code: 2, out: ['error: usage'] };
        strict = true;
      } else {
        return { code: 2, out: ['error: usage'] };
      }
      continue;
    }
    pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const patchArg = pos.length === 0 || pos[0] === '-' ? null : (pos[0] as string);
  let text: string;
  try {
    text = readFileSync(patchArg ?? 0, 'utf8');
  } catch {
    if (patchArg !== null) return { code: 2, out: ['error: no-patch'] };
    text = '';
  }
  const lines = splitPatch(text);
  const kind: string | null = format === null || format === 'auto' ? detectFormat(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = parseJson(text, lines);
    else if (kind === 'unified') edits = parseUnified(lines, strict);
    else if (kind === 'search-replace') edits = parseSearchReplace(lines, strict);
    else edits = parseV4a(lines, strict);
    if (edits.length === 0) throw new ParseError('error: parse 1');
  } catch (e) {
    if (e instanceof ParseError) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: EditError[] = [];
  for (const edit of edits) {
    const snap = tree.snapshot();
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof EditError)) throw e;
      tree.restore(snap);
      fails.push(e);
    }
  }
  if (fails.length > 0) {
    return {
      code: 1,
      out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`],
    };
  }
  interface Row {
    key: string;
    line: string;
  }
  const rows: Row[] = [];
  const movedAway = new Set<string>();
  const movedTo = new Set<string>();
  for (const [oldP, newP] of tree.moves) {
    if (tree.original(oldP) !== null && tree.get(oldP) === null && tree.original(newP) === null && tree.get(newP) !== null) {
      rows.push({ key: newP, line: `R ${oldP} -> ${newP}` });
      movedAway.add(oldP);
      movedTo.add(newP);
    }
  }
  for (const p of [...tree.now.keys()].sort(pathCmp)) {
    if (movedAway.has(p) || movedTo.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p) as string | null;
    if (was === now) continue;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => pathCmp(a.key, b.key));
  if (!check) {
    for (const p of [...tree.now.keys()].sort(pathCmp)) {
      const now = tree.now.get(p) as string | null;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...rows.map((r) => r.line), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}

const envUrl = process.env.MAKEFUN_ENV_URL;
if (envUrl !== undefined && envUrl !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(envUrl);
} else {
  const result = runCli(process.argv.slice(2));
  writeSync(1, result.out.map((l) => `${l}\n`).join(''));
  process.exitCode = result.code;
}
