// Line diff with no git and no Node: Myers' O(ND) algorithm over lines,
// rendered as unified-diff hunks that VS Code's diff grammar colours.

export type Op = { t: ' ' | '-' | '+'; line: string };

export type FileDiff = {
  hunks: string[];
  added: number;
  removed: number;
  // The line in the new text where the first change is, 1-based.
  firstLine: number;
};

// Past this many edits a pair of files is shown as a full replace: the
// trace Myers keeps grows with the square of the edit count.
const MAX_EDITS = 4000;

// CRLF and a leading BOM are not compared: a file whose line endings an
// edit normalised would otherwise show every line as removed and re-added.
export const splitLines = (text: string): string[] => {
  const body = text.replace(/^﻿/, '');
  if (body === '') return [];
  const lines = body.split('\n').map((line) => line.replace(/\r$/, ''));
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
};

const myers = (a: readonly string[], b: readonly string[]): Op[] | null => {
  const n = a.length;
  const m = b.length;
  const max = n + m;
  const off = max + 1;
  const v = new Int32Array(2 * max + 3);
  const trace: Int32Array[] = [];
  let found = -1;

  outer: for (let d = 0; d <= max; d++) {
    if (d > MAX_EDITS) return null;
    // v before this round, for k in [-d-1, d+1]: index k + d + 1
    trace.push(v.slice(off - d - 1, off + d + 2));
    for (let k = -d; k <= d; k += 2) {
      let x =
        k === -d || (k !== d && v[off + k - 1]! < v[off + k + 1]!)
          ? v[off + k + 1]!
          : v[off + k - 1]! + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[off + k] = x;
      if (x >= n && y >= m) {
        found = d;
        break outer;
      }
    }
  }

  const ops: Op[] = [];
  let x = n;
  let y = m;
  for (let d = found; d > 0; d--) {
    const vd = trace[d]!;
    const at = (k: number) => vd[k + d + 1]!;
    const k = x - y;
    const prevK = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1;
    const prevX = at(prevK);
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      ops.push({ t: ' ', line: a[--x]! });
      y--;
    }
    if (x === prevX) ops.push({ t: '+', line: b[--y]! });
    else ops.push({ t: '-', line: a[--x]! });
  }
  while (x > 0 && y > 0) {
    ops.push({ t: ' ', line: a[--x]! });
    y--;
  }
  return ops.reverse();
};

export const diffLines = (a: readonly string[], b: readonly string[]): Op[] => {
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (
    tail < a.length - head &&
    tail < b.length - head &&
    a[a.length - 1 - tail] === b[b.length - 1 - tail]
  ) {
    tail++;
  }

  const midA = a.slice(head, a.length - tail);
  const midB = b.slice(head, b.length - tail);
  const mid = myers(midA, midB) ?? [
    ...midA.map((line): Op => ({ t: '-', line })),
    ...midB.map((line): Op => ({ t: '+', line })),
  ];

  return [
    ...a.slice(0, head).map((line): Op => ({ t: ' ', line })),
    ...mid,
    ...a.slice(a.length - tail).map((line): Op => ({ t: ' ', line })),
  ];
};

const range = (start: number, length: number) => {
  if (length === 0) return `${start},0`;
  return length === 1 ? `${start + 1}` : `${start + 1},${length}`;
};

export const toHunks = (ops: readonly Op[], context = 3): string[] => {
  const n = ops.length;
  const oldAt = new Int32Array(n + 1);
  const newAt = new Int32Array(n + 1);
  for (let i = 0; i < n; i++) {
    const t = ops[i]!.t;
    oldAt[i + 1] = oldAt[i]! + (t === '+' ? 0 : 1);
    newAt[i + 1] = newAt[i]! + (t === '-' ? 0 : 1);
  }

  const out: string[] = [];
  let i = 0;
  while (i < n) {
    while (i < n && ops[i]!.t === ' ') i++;
    if (i >= n) break;

    const start = Math.max(0, i - context);
    let j = i;
    let end = n;
    for (;;) {
      while (j < n && ops[j]!.t !== ' ') j++;
      let k = j;
      while (k < n && ops[k]!.t === ' ') k++;
      if (k < n && k - j <= 2 * context) {
        j = k;
        continue;
      }
      end = Math.min(n, j + context);
      break;
    }

    const oldStart = oldAt[start]!;
    const newStart = newAt[start]!;
    out.push(
      `@@ -${range(oldStart, oldAt[end]! - oldStart)} +${range(newStart, newAt[end]! - newStart)} @@`
    );
    for (let p = start; p < end; p++) out.push(ops[p]!.t + ops[p]!.line);
    i = end;
  }
  return out;
};

export const diffTexts = (before: string, after: string): FileDiff => {
  const ops = diffLines(splitLines(before), splitLines(after));
  let added = 0;
  let removed = 0;
  for (const op of ops) {
    if (op.t === '+') added++;
    else if (op.t === '-') removed++;
  }
  // Every op before the first change is a kept line, so its index is the
  // count of new-text lines above the change.
  const firstChange = ops.findIndex((op) => op.t !== ' ');
  return { hunks: toHunks(ops), added, removed, firstLine: Math.max(1, firstChange + 1) };
};
