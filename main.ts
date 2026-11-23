// speed-home — a dependency-free, from-scratch implementation of the build described in
// makefun-site 1.0.0's README. It reads /input/cases.json (an array of {id, input}) and writes
// /output/answers.json (an array of output trees, path -> text) for every case in order.
//
// Everything here is written against the documented dialect: the front matter grammar, the
// Markdown subset, the template language, the slug rule and the report. The build is a function
// of its input alone.

import { closeSync, mkdirSync, openSync, readFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';

// ---------------------------------------------------------------- text rules

/** Escapes & < > " ' and nothing else. */
function escapeHtml(text: string): string {
  let out = '';
  let last = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    let rep: string;
    switch (c) {
      case 38: rep = '&amp;'; break;
      case 60: rep = '&lt;'; break;
      case 62: rep = '&gt;'; break;
      case 34: rep = '&quot;'; break;
      case 39: rep = '&#39;'; break;
      default: continue;
    }
    if (i > last) out += text.slice(last, i);
    out += rep;
    last = i + 1;
  }
  if (last === 0) return text;
  return last === text.length ? out : out + text.slice(last);
}

/** True when the text holds a character outside 7-bit ASCII (such text needs normalising). */
const NON_ASCII = /[^\x00-\x7F]/;

const slugMemo = new Map<string, string>();

/** A slug: NFKD, marks dropped, A-Z lowered, other runs to one "-", at most 64, untitled if empty. */
function slugify(text: string): string {
  const memo = slugMemo.get(text);
  if (memo !== undefined) return memo;
  const plain = NON_ASCII.test(text) ? text.normalize('NFKD').replace(/\p{M}/gu, '') : text;
  let out = '';
  let gap = false;
  for (const ch of plain) {
    const code = ch.codePointAt(0)!;
    let keep: string | null = null;
    if (code >= 65 && code <= 90) keep = String.fromCharCode(code + 32);
    else if ((code >= 97 && code <= 122) || (code >= 48 && code <= 57)) keep = ch;
    if (keep === null) {
      if (out.length > 0) gap = true;
      continue;
    }
    if (gap) { out += '-'; gap = false; }
    out += keep;
  }
  if (out.length > 64) out = out.slice(0, 64);
  if (out.endsWith('-')) out = out.replace(/-+$/, '');
  const result = out === '' ? 'untitled' : out;
  slugMemo.set(text, result);
  return result;
}

/** The first of slug, slug-2, slug-3 ... that `taken` does not hold, added to it. */
function uniqueSlug(slug: string, taken: Set<string>): string {
  let out = slug;
  if (taken.has(out)) {
    let n = 2;
    do { out = `${slug}-${n}`; n++; } while (taken.has(out));
  }
  taken.add(out);
  return out;
}

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const dateMemo = new Map<string, string>();

/** 2026-11-09 -> "9 November 2026", from the string alone. */
function longDate(date: string): string {
  const memo = dateMemo.get(date);
  if (memo !== undefined) return memo;
  const parts = date.split('-');
  const out = `${Number(parts[2])} ${MONTH_NAMES[Number(parts[1]) - 1]} ${parts[0]}`;
  dateMemo.set(date, out);
  return out;
}

/** Whether the code unit is whitespace in JavaScript's own sense. */
function isSpace(c: number): boolean {
  if (c === 32) return true;
  if (c >= 9 && c <= 13) return true;
  if (c < 0x80) return false;
  return c === 0xa0 || c === 0x1680 || (c >= 0x2000 && c <= 0x200a) || c === 0x2028 || c === 0x2029 || c === 0x202f || c === 0x205f || c === 0x3000 || c === 0xfeff;
}

/** 1 for a code unit that is not whitespace, 0 for one that is. */
const WORD_CHAR = new Uint8Array(0xa0);
for (let c = 0; c < 0xa0; c++) WORD_CHAR[c] = c === 32 || (c >= 9 && c <= 13) ? 0 : 1;

/** Runs of characters other than whitespace, over lines from `from` (a line boundary is whitespace). */
function countWords(lines: string[], from: number): number {
  let n = 0;
  let inWord = false;
  for (let k = from; k < lines.length; k++) {
    const s = lines[k];
    const len = s.length;
    for (let i = 0; i < len; i++) {
      const c = s.charCodeAt(i);
      if (c < 0xa0) {
        if (WORD_CHAR[c] === 1) {
          if (!inWord) { inWord = true; n++; }
        } else inWord = false;
      } else if (isSpace(c)) inWord = false;
      else if (!inWord) { inWord = true; n++; }
    }
    inWord = false;
  }
  return n;
}

// ---------------------------------------------------------------- front matter

type Data = Record<string, unknown>;
type Parsed = { data: Data; lines: string[]; bodyFrom: number } | { error: string };

const FM_LINE = /^([a-z_]+):(?: (.*))?$/;
const FM_BLANK = /^[ \t]*$/;
const FM_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const FM_NAME = /^[a-z0-9-]+$/;
const FM_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const FM_TAG = /^[^"[\]]+$/;
const FM_KEYS = new Set(['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary']);

function daysInMonth(year: number, month: number): number {
  if (month === 2) return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0 ? 29 : 28;
  return month === 4 || month === 6 || month === 9 || month === 11 ? 30 : 31;
}

/** A title or summary: quoted (only \" and \\ escape) or bare (never opening on " or [). */
function stringOf(raw: string): { value: string } | { error: string } {
  if (raw.charCodeAt(0) === 34) {
    if (raw.length < 2 || raw.charCodeAt(raw.length - 1) !== 34) return { error: 'a quoted string is not closed' };
    let out = '';
    const stop = raw.length - 1;
    for (let i = 1; i < stop; i++) {
      const c = raw.charCodeAt(i);
      if (c === 92) {
        const n = raw.charCodeAt(i + 1);
        if (i + 1 === stop || (n !== 34 && n !== 92)) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += raw.charAt(i + 1);
        i++;
      } else if (c === 34) {
        return { error: 'a quoted string holds a stray quote' };
      } else out += raw.charAt(i);
    }
    return { value: out };
  }
  if (raw.charCodeAt(0) === 91) return { error: 'a bare string opens on [' };
  return { value: raw };
}

/** One key's value, or the reason it is refused. */
function keyValue(key: string, raw: string): { value: unknown } | { error: string } {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringOf(raw);
      if ('error' in s) return { error: `key "${key}": ${s.error}` };
      return { value: s.value };
    }
    case 'date': {
      const m = FM_DATE.exec(raw);
      if (m === null) return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      const y = Number(m[1]);
      const mo = Number(m[2]);
      const d = Number(m[3]);
      if (y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysInMonth(y, mo)) return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      return { value: raw };
    }
    case 'tags': {
      if (raw.charCodeAt(0) !== 91 || raw.charCodeAt(raw.length - 1) !== 93) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const names = inner.split(',').map((t) => t.trim());
      for (const t of names) if (t === '' || !FM_TAG.test(t)) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
      return { value: names };
    }
    case 'draft':
      if (raw === 'true') return { value: true };
      if (raw === 'false') return { value: false };
      return { error: 'key "draft": true or false' };
    case 'layout':
      return FM_NAME.test(raw) ? { value: raw } : { error: 'key "layout": not a template name' };
    case 'slug':
      return FM_SLUG.test(raw) && raw.length <= 64 ? { value: raw } : { error: 'key "slug": not a slug' };
    default:
      return { error: `unknown key "${key}"` };
  }
}

/** A source's front matter and its body, or the first reason it is refused. */
function parseFrontMatter(text: string): Parsed {
  const lines = text.split('\n');
  if (lines[0] !== '---') return { error: 'no front matter' };
  let close = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === '---') { close = i; break; }
  }
  if (close === -1) return { error: 'the front matter is not closed' };
  const data: Data = {};
  for (let i = 1; i < close; i++) {
    const line = lines[i];
    if (FM_BLANK.test(line) || line.charCodeAt(0) === 35) continue;
    const m = FM_LINE.exec(line);
    if (m === null) return { error: `line ${i + 1} is not "key: value"` };
    const key = m[1];
    const raw = (m[2] === undefined ? '' : m[2]).replace(/[ \t]+$/, '');
    if (!FM_KEYS.has(key)) return { error: `unknown key "${key}"` };
    if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
    if (raw === '') return { error: `key "${key}" has no value` };
    const v = keyValue(key, raw);
    if ('error' in v) return { error: v.error };
    data[key] = v.value;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, lines, bodyFrom: close + 1 };
}

// ---------------------------------------------------------------- markdown

interface TocEntry { level: number; id: string; html: string }
type LinkFn = (target: string) => string;

const MD_BLANK = /^[ \t]*$/;
const MD_FENCE_OPEN = /^```([A-Za-z0-9_+-]*)[ \t]*$/;
const MD_HEADING = /^(#{1,6})[ \t]+(.*?)[ \t]*$/;
const MD_HR = /^(?:---|\*\*\*)[ \t]*$/;
const MD_BULLET = /^[-*] (.*)$/;
const MD_ORDERED = /^(\d{1,9})\. (.*)$/;
const MD_CONTINUED = /^ {2,}\S/;

/** Spaces and tabs at either end dropped. */
function trimLine(line: string): string {
  let a = 0;
  let b = line.length;
  while (a < b) {
    const c = line.charCodeAt(a);
    if (c !== 32 && c !== 9) break;
    a++;
  }
  while (b > a) {
    const c = line.charCodeAt(b - 1);
    if (c !== 32 && c !== 9) break;
    b--;
  }
  return a === 0 && b === line.length ? line : line.slice(a, b);
}

function isBlankLine(line: string): boolean {
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** ``` then spaces or tabs only. */
function isFenceClose(line: string): boolean {
  if (line.length < 3 || line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return false;
  for (let i = 3; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** A heading line's depth and text, or null (the text is never empty). */
function headingOf(line: string): { depth: number; text: string } | null {
  if (line.charCodeAt(0) !== 35) return null;
  const m = MD_HEADING.exec(line);
  if (m === null || m[2] === '') return null;
  return { depth: m[1].length, text: m[2] };
}

/** Whether the line ends a paragraph: blank, a fence, a heading or a thematic break. */
function endsParagraph(line: string): boolean {
  if (isBlankLine(line)) return true;
  const c = line.charCodeAt(0);
  if (c === 96 && line.length > 2 && line.charCodeAt(1) === 96 && line.charCodeAt(2) === 96 && MD_FENCE_OPEN.test(line)) return true;
  if (c === 35 && headingOf(line) !== null) return true;
  if ((c === 45 || c === 42) && MD_HR.test(line)) return true;
  return false;
}

/** The characters a backslash escapes. */
const ESCAPABLE = new Uint8Array(128);
for (const ch of '\\`*_[]()#+-.!>') ESCAPABLE[ch.charCodeAt(0)] = 1;

function isEscapable(c: number): boolean {
  return c < 128 && ESCAPABLE[c] === 1;
}

/** An escaped backslash pair's text: the character itself, HTML-escaped where it must be. */
const ESCAPED_CHAR: string[] = [];
for (let c = 0; c < 128; c++) ESCAPED_CHAR[c] = c === 62 ? '&gt;' : String.fromCharCode(c);

/** The first index from `from` where s holds "**" outside a backslash escape, or -1. */
function findStrongClose(s: string, from: number): number {
  const stop = s.length - 2;
  for (let j = from; j <= stop; j++) {
    const c = s.charCodeAt(j);
    if (c === 92) {
      if (j + 1 < s.length && isEscapable(s.charCodeAt(j + 1))) { j++; continue; }
      continue;
    }
    if (c === 42 && s.charCodeAt(j + 1) === 42) return j;
  }
  return -1;
}

/** The first single "*" from `from` (a run of two is stepped over) outside an escape, or -1. */
function findEmClose(s: string, from: number): number {
  for (let j = from; j < s.length; j++) {
    const c = s.charCodeAt(j);
    if (c === 92) {
      if (j + 1 < s.length && isEscapable(s.charCodeAt(j + 1))) { j++; continue; }
      continue;
    }
    if (c !== 42) continue;
    if (s.charCodeAt(j + 1) === 42) { j++; continue; }
    return j;
  }
  return -1;
}

/** The first index from `from` holding `]` outside a backslash escape, or -1. */
function findBracketClose(s: string, from: number): number {
  for (let j = from; j < s.length; j++) {
    const c = s.charCodeAt(j);
    if (c === 92) {
      if (j + 1 < s.length && isEscapable(s.charCodeAt(j + 1))) { j++; continue; }
      continue;
    }
    if (c === 93) return j;
  }
  return -1;
}

function hasWhitespace(s: string): boolean {
  for (let i = 0; i < s.length; i++) if (isSpace(s.charCodeAt(i))) return true;
  return false;
}

/** The HTML entities, by code unit; the inline scan stops at every one of them. */
const HTML_ENTITY: (string | undefined)[] = [];
HTML_ENTITY[38] = '&amp;';
HTML_ENTITY[60] = '&lt;';
HTML_ENTITY[62] = '&gt;';
HTML_ENTITY[34] = '&quot;';
HTML_ENTITY[39] = '&#39;';

/** Where an inline run of ordinary text ends: a marker, a backslash or a character HTML escapes. */
const INLINE_STOP = /[\\`*\[&<>"']/g;

/** `s` rendered inline; `link` resolves a link's target. */
function inline(s: string, link: LinkFn): string {
  const n = s.length;
  INLINE_STOP.lastIndex = 0;
  if (!INLINE_STOP.test(s)) return s;
  let out = '';
  let i = 0;
  while (i < n) {
    INLINE_STOP.lastIndex = i;
    const hit = INLINE_STOP.exec(s);
    const stop = hit === null ? n : hit.index;
    if (stop > i) out += s.slice(i, stop);
    if (hit === null) break;
    i = stop;
    const c = s.charCodeAt(i);
    if (c === 92) {
      if (i + 1 < n && isEscapable(s.charCodeAt(i + 1))) {
        out += ESCAPED_CHAR[s.charCodeAt(i + 1)];
        i += 2;
        continue;
      }
      out += '\\';
      i++;
      continue;
    }
    if (c === 96) {
      const j = s.indexOf('`', i + 1);
      if (j > i + 1) {
        out += `<code>${escapeHtml(s.slice(i + 1, j))}</code>`;
        i = j + 1;
      } else {
        out += '`';
        i++;
      }
      continue;
    }
    if (c === 42) {
      if (s.charCodeAt(i + 1) === 42) {
        const j = findStrongClose(s, i + 2);
        if (j > i + 2) {
          out += `<strong>${inline(s.slice(i + 2, j), link)}</strong>`;
          i = j + 2;
        } else {
          out += '**';
          i += 2;
        }
        continue;
      }
      const j = findEmClose(s, i + 1);
      if (j > i + 1) {
        out += `<em>${inline(s.slice(i + 1, j), link)}</em>`;
        i = j + 1;
      } else {
        out += '*';
        i++;
      }
      continue;
    }
    if (c === 91) {
      const k = findBracketClose(s, i + 1);
      const m = k !== -1 && s.charCodeAt(k + 1) === 40 ? s.indexOf(')', k + 2) : -1;
      if (m !== -1) {
        const target = s.slice(k + 2, m);
        if (target !== '' && !hasWhitespace(target)) {
          out += `<a href="${escapeHtml(link(target))}">${inline(s.slice(i + 1, k), link)}</a>`;
          i = m + 1;
          continue;
        }
      }
      out += '[';
      i++;
      continue;
    }
    out += HTML_ENTITY[c] as string;
    i++;
  }
  return out;
}

/** `lines` from `from` rendered: html, table of contents (levels 2 and 3) and the first paragraph's html. */
function renderMarkdown(lines: string[], from: number, link: LinkFn): { html: string; toc: TocEntry[]; excerpt: string; words: number } {
  const words = countWords(lines, from);
  const total = lines.length;
  const ids = new Set<string>();
  const toc: TocEntry[] = [];
  const blocks: string[] = [];
  let excerpt: string | null = null;
  let i = from;
  while (i < total) {
    const line = lines[i];
    if (isBlankLine(line)) { i++; continue; }
    const c0 = line.charCodeAt(0);
    if (c0 === 96 && line.length > 2 && line.charCodeAt(1) === 96 && line.charCodeAt(2) === 96) {
      const fence = MD_FENCE_OPEN.exec(line);
      if (fence !== null) {
        const lang = fence[1];
        const first = i + 1;
        i = first;
        while (i < total && !isFenceClose(lines[i])) i++;
        const code = i === first ? '' : `${escapeHtml(lines.slice(first, i).join('\n'))}\n`;
        i++;
        const cls = lang === '' ? '' : ` class="language-${escapeHtml(lang)}"`;
        blocks.push(`<pre><code${cls}>${code}</code></pre>`);
        continue;
      }
    }
    if (c0 === 35) {
      const heading = headingOf(line);
      if (heading !== null) {
        const id = uniqueSlug(slugify(heading.text), ids);
        const html = inline(heading.text, link);
        blocks.push(`<h${heading.depth} id="${id}">${html}</h${heading.depth}>`);
        if (heading.depth === 2 || heading.depth === 3) toc.push({ level: heading.depth, id, html });
        i++;
        continue;
      }
    }
    if ((c0 === 45 || c0 === 42) && MD_HR.test(line)) {
      blocks.push('<hr>');
      i++;
      continue;
    }
    if (c0 === 62) {
      const kept: string[] = [];
      while (i < total) {
        const q = lines[i];
        if (q.charCodeAt(0) !== 62) break;
        const rest = q.charCodeAt(1) === 32 ? q.slice(2) : q.slice(1);
        const trimmed = trimLine(rest);
        if (trimmed !== '') kept.push(trimmed);
        i++;
      }
      blocks.push(kept.length === 0 ? '<blockquote>\n</blockquote>' : `<blockquote>\n<p>${inline(kept.join('\n'), link)}</p>\n</blockquote>`);
      continue;
    }
    let bullet: RegExpExecArray | null = null;
    let ordered: RegExpExecArray | null = null;
    if (c0 === 45 || c0 === 42) bullet = MD_BULLET.exec(line);
    else if (c0 >= 48 && c0 <= 57) ordered = MD_ORDERED.exec(line);
    if (bullet !== null || ordered !== null) {
      const isOrdered = ordered !== null;
      const items: string[][] = [];
      while (i < total) {
        const cur = lines[i];
        const m = isOrdered ? MD_ORDERED.exec(cur) : MD_BULLET.exec(cur);
        if (m !== null) {
          items.push([trimLine(isOrdered ? m[2] : m[1])]);
          i++;
        } else if (MD_CONTINUED.test(cur)) {
          items[items.length - 1].push(trimLine(cur));
          i++;
        } else break;
      }
      let body = '';
      for (const parts of items) body += `<li>${inline(parts.join('\n'), link)}</li>\n`;
      const tag = isOrdered ? 'ol' : 'ul';
      const open = isOrdered && Number(ordered![1]) !== 1 ? `<ol start="${Number(ordered![1])}">` : `<${tag}>`;
      blocks.push(`${open}\n${body}</${tag}>`);
      continue;
    }
    const para: string[] = [trimLine(line)];
    i++;
    while (i < total && !endsParagraph(lines[i])) {
      para.push(trimLine(lines[i]));
      i++;
    }
    const html = inline(para.join('\n'), link);
    if (excerpt === null) excerpt = html;
    blocks.push(`<p>${html}</p>`);
  }
  return { html: blocks.length === 0 ? '' : blocks.join('\n') + '\n', toc, excerpt: excerpt === null ? '' : excerpt, words };
}

// ---------------------------------------------------------------- templates

const T_PATH = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const T_FOR = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const T_IF = /^if (not )?(\S+)$/;
const T_INCLUDE = /^include "([a-z0-9-]+)"$/;

const INCLUDE_DEPTH = 8;

/** A template that does not parse. */
class TemplateError extends Error {}

const KIND_TEXT = 0;
const KIND_VAR = 1;
const KIND_RAW = 2;
const KIND_IF = 3;
const KIND_FOR = 4;
const KIND_INCLUDE = 5;

/** One template node. Every field is always present, so every node shares one object shape. */
interface TNode {
  k: number;
  s: string;
  p: string[] | null;
  neg: boolean;
  then: TNode[] | null;
  els: TNode[] | null;
  name: string;
  body: TNode[] | null;
}

type Body = TNode[];

const mkText = (s: string): TNode => ({ k: KIND_TEXT, s, p: null, neg: false, then: null, els: null, name: '', body: null });
const mkPath = (k: number, p: string[], neg: boolean): TNode => ({ k, s: '', p, neg, then: null, els: null, name: '', body: null });
const mkInclude = (name: string): TNode => ({ k: KIND_INCLUDE, s: '', p: null, neg: false, then: null, els: null, name, body: null });

function pathOf(name: string, text: string): string[] {
  if (!T_PATH.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

/** True when src[a..b) holds spaces and tabs only. */
function onlySpaces(src: string, a: number, b: number): boolean {
  for (let i = a; i < b; i++) {
    const c = src.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** The template parsed into its tree of nodes, or a TemplateError. */
function parseTemplate(name: string, src: string): Body {
  const root: Body = [];
  const stack: { tag: string; body: Body; node?: TNode }[] = [{ tag: 'root', body: root }];
  let body = root;
  let text = '';
  let i = 0;
  const fail = (why: string): never => { throw new TemplateError(`template "${name}": ${why}`); };
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) { text += src.slice(i); break; }
    const next = src.charCodeAt(open + 1);
    if (next !== 123 && next !== 37) { text += src.slice(i, open + 1); i = open + 1; continue; }
    text += src.slice(i, open);
    if (next === 123) {
      const raw = src.charCodeAt(open + 2) === 123;
      const start = open + (raw ? 3 : 2);
      const close = src.indexOf(raw ? '}}}' : '}}', start);
      if (close === -1) fail(`a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') { body.push(mkText(text)); text = ''; }
      body.push(mkPath(raw ? KIND_RAW : KIND_VAR, pathOf(name, src.slice(start, close).trim()), false));
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) fail('a {% is not closed');
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = onlySpaces(src, lineStart, open) && onlySpaces(src, end, lineEnd);
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') { body.push(mkText(text)); text = ''; }
    const tag = src.slice(open + 2, close).trim();
    const top = stack[stack.length - 1];
    let m: RegExpExecArray | null = null;
    if ((m = T_FOR.exec(tag)) !== null) {
      const node = mkPath(KIND_FOR, pathOf(name, m[2]), false);
      node.name = m[1];
      node.body = [];
      body.push(node);
      stack.push({ tag: 'for', body: node.body, node });
      body = node.body;
    } else if ((m = T_IF.exec(tag)) !== null) {
      const node = mkPath(KIND_IF, pathOf(name, m[2]), m[1] !== undefined);
      node.then = [];
      body.push(node);
      stack.push({ tag: 'if', body: node.then, node });
      body = node.then;
    } else if (tag === 'else') {
      const openIf = top.node;
      if (top.tag !== 'if' || openIf === undefined || openIf.els !== null) fail('an else outside an if');
      const node = openIf as TNode;
      node.els = [];
      top.body = node.els;
      body = node.els;
    } else if (tag === 'endfor' || tag === 'endif') {
      if (top.tag !== (tag === 'endfor' ? 'for' : 'if')) fail(`an ${tag} with no open ${tag.slice(3)}`);
      stack.pop();
      body = stack[stack.length - 1].body;
    } else if ((m = T_INCLUDE.exec(tag)) !== null) {
      body.push(mkInclude(m[1]));
    } else {
      fail(`{% ${tag} %} is not a tag`);
    }
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') body.push(mkText(text));
  if (stack.length > 1) fail(`a ${stack[stack.length - 1].tag} is not closed`);
  return root;
}

interface Scope { vars: Record<string, unknown>; parent: Scope | null }

/** The value at path: the first name from the nearest scope holding it, then own properties. */
function lookup(scope: Scope | null, path: string[]): unknown {
  let s = scope;
  while (s !== null && !Object.hasOwn(s.vars, path[0])) s = s.parent;
  if (s === null) return undefined;
  let v = s.vars[path[0]];
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v as object, path[k])) return undefined;
    v = (v as Record<string, unknown>)[path[k]];
  }
  return v;
}

/** A value as text: a string, a number's digits, true/false, an array's items joined by ", ", else "". */
function textOf(v: unknown): string {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) {
    let out = '';
    for (let i = 0; i < v.length; i++) out += (i === 0 ? '' : ', ') + textOf(v[i]);
    return out;
  }
  return '';
}

function truthy(v: unknown): boolean {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

interface RenderCtx { templates: Map<string, Body> }

function renderNodes(nodes: Body, scope: Scope, ctx: RenderCtx, depth: number): string {
  let out = '';
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    const k = n.k;
    if (k === KIND_TEXT) {
      out += n.s;
    } else if (k === KIND_VAR) {
      out += escapeHtml(textOf(lookup(scope, n.p!)));
    } else if (k === KIND_RAW) {
      out += textOf(lookup(scope, n.p!));
    } else if (k === KIND_IF) {
      const branch = truthy(lookup(scope, n.p!)) !== n.neg ? n.then! : n.els;
      if (branch !== null) out += renderNodes(branch, scope, ctx, depth);
    } else if (k === KIND_FOR) {
      const xs = lookup(scope, n.p!);
      if (Array.isArray(xs)) {
        const len = xs.length;
        const inner = n.body!;
        for (let j = 0; j < len; j++) {
          const vars: Record<string, unknown> = {};
          vars[n.name] = xs[j];
          vars.loop = { index: j + 1, first: j === 0, last: j === len - 1, length: len };
          out += renderNodes(inner, { vars, parent: scope }, ctx, depth);
        }
      }
    } else if (k === KIND_INCLUDE) {
      const t = ctx.templates.get(n.name);
      if (t !== undefined && depth < INCLUDE_DEPTH) out += renderNodes(t, scope, ctx, depth + 1);
    }
  }
  return out;
}

// ---------------------------------------------------------------- the build

const NO_LINES: string[] = [];

const REPORT_FILE = 'build-report.txt';
const TOP_LEVEL_DIRS = ['posts', 'tags', 'page'];

const byCodeUnits = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

interface Source {
  path: string;
  text: string;
  data: Data;
  lines: string[];
  bodyFrom: number;
  post: boolean;
  layout: string;
  slug: string;
  outDir: string;
  url: string;
  html: string;
  toc: TocEntry[];
  excerpt: string;
  words: number;
  tagRefs: TagRecord[];
  newer?: Source | null;
  older?: Source | null;
}

interface TagRecord { name: string; slug: string; url: string; posts: Source[] }

interface Card {
  title: unknown;
  url: string;
  date: unknown;
  date_long: string;
  summary: unknown;
  excerpt: string;
  reading_minutes: number;
  tags: { name: string; slug: string; url: string }[];
}

interface Site { title: unknown; base_url: string; per_page: number; recent: number }

/** The directory part of a path ("a/b/c.md" -> "a/b", "c.md" -> ""). */
function dirOf(path: string): string {
  const at = path.lastIndexOf('/');
  return at === -1 ? '' : path.slice(0, at);
}

/** `rel` resolved from `dir`, or null when it climbs above the root. */
function resolvePath(dir: string, rel: string): string | null {
  if (rel.indexOf('/') === -1) {
    if (rel === '..') return dir === '' ? null : dirOf(dir);
    if (rel === '.') return dir;
    return dir === '' ? rel : `${dir}/${rel}`;
  }
  const parts = dir === '' ? [] : dir.split('/');
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

const SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/;

/** One site's output tree: path -> text. */
export function runCase(input: { site: Site; templates: Record<string, string>; files: { path: string; content: string }[] }): Record<string, string> {
  const report: string[] = [];
  const broken = new Set<string>();

  // templates
  const templates = new Map<string, Body>();
  for (const name of Object.keys(input.templates).sort(byCodeUnits)) {
    try {
      templates.set(name, parseTemplate(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push((err as Error).message);
    }
  }

  const base = input.site.base_url.replace(/\/+$/, '');

  // sources, sorted by path; a file that is not .md is static
  const files = input.files.slice().sort((x, y) => byCodeUnits(x.path, y.path));
  const sources: Source[] = [];
  const statics: { path: string; content: string }[] = [];
  for (const f of files) {
    if (f.path.endsWith('.md')) {
      const raw = f.content;
      sources.push({ path: f.path, text: raw.indexOf('\r') === -1 ? raw : raw.replace(/\r\n?/g, '\n') } as Source);
    } else statics.push({ path: f.path, content: f.content });
  }

  // front matter, the generator's own directories, dates and layouts, then drafts
  const kept: Source[] = [];
  for (const s of sources) {
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) { report.push(`refused ${s.path}: ${fm.error}`); continue; }
    s.data = fm.data;
    s.lines = fm.lines;
    s.bodyFrom = fm.bodyFrom;
    s.text = '';
    s.post = s.path.startsWith('posts/');
    let own: string | undefined;
    for (const d of TOP_LEVEL_DIRS) {
      if (d !== 'posts' && s.path.startsWith(`${d}/`)) { own = d; break; }
    }
    if (own !== undefined) { report.push(`refused ${s.path}: ${own}/ is the generator's own`); continue; }
    if (s.post && !Object.hasOwn(s.data, 'date')) { report.push(`refused ${s.path}: a post needs a date`); continue; }
    const layout = (s.data.layout ?? (s.post ? 'post' : 'page')) as string;
    if (!templates.has(layout)) { report.push(`refused ${s.path}: layout "${layout}" is no template that parses`); continue; }
    s.layout = layout;
    if (s.data.draft === true) { report.push(`draft ${s.path}`); continue; }
    kept.push(s);
  }

  // permalinks: each page's directory and unique slug, in source order
  const taken = new Map<string, Set<string>>();
  const takenIn = (dir: string): Set<string> => {
    let set = taken.get(dir);
    if (set === undefined) {
      set = new Set(dir === '' ? TOP_LEVEL_DIRS : []);
      taken.set(dir, set);
    }
    return set;
  };
  const bySource = new Map<string, Source>();
  for (const s of kept) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    const slug = uniqueSlug((s.data.slug ?? slugify(String(s.data.title))) as string, takenIn(dir));
    s.slug = slug;
    s.outDir = dir === '' ? slug : `${dir}/${slug}`;
    s.url = `${base}/${s.outDir}/`;
    bySource.set(s.path, s);
  }

  // markdown, each link resolved to the page or static file it names
  const staticPaths = new Set<string>();
  for (const f of statics) staticPaths.add(f.path);
  for (const s of kept) {
    const dir = dirOf(s.path);
    const link = (target: string): string => {
      if (SCHEME.test(target) || target.charCodeAt(0) === 47 || target.charCodeAt(0) === 35) return target;
      const hash = target.indexOf('#');
      const rel = hash === -1 ? target : target.slice(0, hash);
      const frag = hash === -1 ? '' : target.slice(hash);
      const path = rel === '' ? null : resolvePath(dir, rel);
      if (path !== null) {
        const to = bySource.get(path);
        if (to !== undefined) return `${to.url}${frag}`;
        if (staticPaths.has(path)) return `${base}/${path}${frag}`;
      }
      broken.add(`broken-link ${s.path} -> ${target}`);
      return target;
    };
    const md = renderMarkdown(s.lines, s.bodyFrom, link);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
    s.words = md.words;
    s.lines = NO_LINES;
  }

  // the collection: newest first, equal dates by slug
  const posts = kept.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(String(y.data.date), String(x.data.date)) || byCodeUnits(x.slug, y.slug));
  for (let k = 0; k < posts.length; k++) {
    posts[k].newer = k === 0 ? null : posts[k - 1];
    posts[k].older = k === posts.length - 1 ? null : posts[k + 1];
  }

  // tags
  const bySlug = new Map<string, TagRecord>();
  const ownTags = (s: Source): string[] => {
    const names = (s.data.tags ?? []) as string[];
    const seen = new Set<string>();
    const out: string[] = [];
    for (const name of names) {
      const slug = slugify(name);
      if (seen.has(slug)) continue;
      seen.add(slug);
      out.push(name);
    }
    return out;
  };
  for (const p of posts) {
    const refs: TagRecord[] = [];
    for (const name of ownTags(p)) {
      const slug = slugify(name);
      let tag = bySlug.get(slug);
      if (tag === undefined) {
        tag = { name, slug, url: `${base}/tags/${slug}/`, posts: [] };
        bySlug.set(slug, tag);
      }
      tag.posts.push(p);
      refs.push(tag);
    }
    p.tagRefs = refs;
  }
  for (const s of kept) {
    if (s.post) continue;
    s.tagRefs = ownTags(s).map((name) => {
      const slug = slugify(name);
      return bySlug.get(slug) ?? { name, slug, url: '', posts: [] };
    });
  }
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  // cards and pages as templates read them
  const cards = new Map<Source, Card>();
  const cardOf = (s: Source): Card => ({
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(String(s.data.date)),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: Math.max(1, Math.ceil(s.words / 200)),
    tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
  });
  for (const p of posts) cards.set(p, cardOf(p));
  const card = (p: Source): Card => cards.get(p)!;

  const output: Record<string, string> = {};
  const ctx: RenderCtx = { templates };
  const siteView: Site = { title: input.site.title, base_url: base };
  const siteTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent as number).map(card);
  const render = (name: string, vars: Record<string, unknown>): string | null => {
    const nodes = templates.get(name);
    if (nodes === undefined) return null;
    return renderNodes(nodes, { vars: { site: siteView, tags: siteTags, recent, ...vars }, parent: null }, ctx, 0);
  };

  for (const s of kept) {
    const cardData = s.post ? cards.get(s)! : cardOf(s);
    const page = {
      ...cardData,
      slug: s.slug,
      content: s.html,
      toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })),
      newer: s.newer === undefined || s.newer === null ? null : { title: s.newer.data.title, url: s.newer.url, date: s.newer.data.date ?? '', date_long: s.newer.data.date === undefined ? '' : longDate(String(s.newer.data.date)) },
      older: s.older === undefined || s.older === null ? null : { title: s.older.data.title, url: s.older.url, date: s.older.data.date ?? '', date_long: s.older.data.date === undefined ? '' : longDate(String(s.older.data.date)) },
      is_post: s.post,
    };
    output[`${s.outDir}/index.html`] = render(s.layout, { page }) as string;
  }

  const per = input.site.per_page as number;
  const pageCount = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k: number): string => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  for (let k = 1; k <= pageCount; k++) {
    const html = render('index', {
      posts: posts.slice((k - 1) * per, k * per).map(card),
      pager: { number: k, total: pageCount, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pageCount ? '' : indexUrl(k + 1) },
    });
    if (html !== null) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of tags) {
    const html = render('tag', { tag: { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map(card) } });
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (const f of statics) {
    if (Object.hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  // the report
  const lines = [...report, ...broken].sort(byCodeUnits);
  let pages = 0;
  for (const s of kept) if (!s.post) pages++;
  lines.push(`built ${pages} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output[REPORT_FILE] = `${lines.join('\n')}\n`;
  return output;
}

// ---------------------------------------------------------------- the driver

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

interface Case { id: string; input: Parameters<typeof runCase>[0] }

const cases = JSON.parse(readFileSync(join(INPUT_DIR, 'cases.json'), 'utf8')) as Case[];
mkdirSync(OUTPUT_DIR, { recursive: true });
// Each answer is written and let go as soon as it is made, so the trees of the earlier cases do
// not sit in the heap while the later ones are built.
const answerFile = openSync(join(OUTPUT_DIR, 'answers.json'), 'w');
writeSync(answerFile, '[');
for (let i = 0; i < cases.length; i++) {
  const text = JSON.stringify(runCase(cases[i].input));
  writeSync(answerFile, i === 0 ? text : `,${text}`);
}
writeSync(answerFile, ']');
closeSync(answerFile);
