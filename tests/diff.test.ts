import { describe, expect, test } from 'claude-code/testing';

import { diffTexts } from '../hooks/diff';

describe('diffTexts', () => {
  test('a changed line is one hunk with a - and a +', async () => {
    const before = 'a\nb\nc\nd\ne\n';
    const after = 'a\nb\nC\nd\ne\n';
    const diff = diffTexts(before, after);
    expect(diff.added).toBe(1);
    expect(diff.removed).toBe(1);
    expect(diff.hunks).toEqual(['@@ -1,5 +1,5 @@', ' a', ' b', '-c', '+C', ' d', ' e']);
    expect(diff.firstLine).toBe(3);
  });

  test('a new file is all additions from line 0', async () => {
    const diff = diffTexts('', 'x\ny\n');
    expect(diff.hunks).toEqual(['@@ -0,0 +1,2 @@', '+x', '+y']);
    expect(diff.firstLine).toBe(1);
  });

  test('far-apart changes become two hunks', async () => {
    const lines = Array.from({ length: 30 }, (_, i) => `line ${i}`);
    const changed = [...lines];
    changed[2] = 'first';
    changed[25] = 'second';
    const diff = diffTexts(lines.join('\n'), changed.join('\n'));
    expect(diff.hunks.filter((l) => l.startsWith('@@'))).toEqual([
      '@@ -1,6 +1,6 @@',
      '@@ -23,7 +23,7 @@',
    ]);
  });

  test('CRLF against LF is no change; a real edit beside it is one line', async () => {
    const diff = diffTexts('﻿a\r\nb\r\nc\r\n', 'a\nb\nc\nd\n');
    expect(diff.added).toBe(1);
    expect(diff.removed).toBe(0);
    expect(diff.hunks).toEqual(['@@ -1,3 +1,4 @@', ' a', ' b', ' c', '+d']);
  });

  test('insertions and deletions in the middle are found, not a full replace', async () => {
    const diff = diffTexts('a\nb\nc\nd\n', 'a\nx\nc\nd\ny\n');
    expect(diff.added).toBe(2);
    expect(diff.removed).toBe(1);
  });
});
