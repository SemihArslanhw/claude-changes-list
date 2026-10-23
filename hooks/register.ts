import type { EngineInterface, Register } from 'claude-code';

import { diffTexts } from './diff';

// Records what Claude changes in one turn, with no git: a file's content is
// copied the first time an Edit, Write or NotebookEdit touches it in the
// turn, and compared with what is there when the turn ends. Shell commands
// cannot be diffed that way, so the files they touch are only marked, from
// a size/mtime scan of the working directory taken before the first one.
// The result is a unified .diff file under ~/.claude/changes/, which the
// reply links as "Changes list"; VS Code colours it as a diff.

type $ = EngineInterface;

type Snap =
  | { kind: 'text'; text: string }
  | { kind: 'missing' }
  | { kind: 'binary' }
  | { kind: 'large' }
  | { kind: 'unreadable' };

type Seen = { path: string; sig: string };

type Changeset = {
  id: string;
  createdAt: number;
  cwd: string;
  dir: string;
  link: string;
  files: Map<string, { path: string; before: Promise<Snap> }>;
  shellBaseline?: Promise<Map<string, Seen>>;
};

type Row = {
  status: 'A' | 'M' | 'D';
  rel: string;
  added: number;
  removed: number;
  note?: string;
  before?: string;
  after?: string;
  // Ctrl+click opens the file in VS Code, at the first changed line.
  open?: string;
};

const MAX_READ = 4 * 1024 * 1024;
const MAX_SCAN = 20000;
const MAX_NATIVE_DIFFS = 20;
const SHELL_TOOLS = new Set(['Bash', 'PowerShell']);
const SKIPPED_DIRS = new Set([
  'node_modules',
  '.git',
  '.hg',
  '.svn',
  'dist',
  'build',
  'out',
  'coverage',
  '.next',
  '.nuxt',
  '.cache',
  '.turbo',
  '.venv',
  'venv',
  '__pycache__',
  'target',
  '.engram',
  '.gitnexus',
  '.idea',
  '.vs',
]);

const slash = (path: string) => path.replace(/\\/g, '/');
const isWindowsPath = (path: string) => /^[A-Za-z]:/.test(path);
const keyOf = (path: string) => {
  const p = slash(path);
  return isWindowsPath(p) ? p.toLowerCase() : p;
};
const isAbsolute = (path: string) => isWindowsPath(path) || /^[\\/]/.test(path);
const join = (dir: string, name: string) => `${slash(dir).replace(/\/$/, '')}/${name}`;
const fileUrl = (path: string) => `file://${path.startsWith('/') ? '' : '/'}${encodeURI(path)}`;

const relativeTo = (cwd: string, path: string) => {
  const root = `${keyOf(cwd).replace(/\/$/, '')}/`;
  return keyOf(path).startsWith(root) ? slash(path).slice(root.length) : slash(path);
};

// Where a file's before/after copy goes, inside the changeset's folder.
const mirrorOf = (rel: string) =>
  isAbsolute(rel) ? `_outside/${rel.replace(/^\//, '').replace(':', '')}` : rel;

const stampOf = (ms: number) => {
  const d = new Date(ms);
  const two = (n: number) => String(n).padStart(2, '0');
  const random = [...crypto.getRandomValues(new Uint8Array(2))]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return (
    `${d.getFullYear()}${two(d.getMonth() + 1)}${two(d.getDate())}-` +
    `${two(d.getHours())}${two(d.getMinutes())}${two(d.getSeconds())}-${random}`
  );
};

const changesRoot = async ($: $) => {
  const config = await $.env.get('CLAUDE_CONFIG_DIR');
  if (config) return join(config, 'changes');
  const home = (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME')) ?? '.';
  return join(join(home, '.claude'), 'changes');
};

const snapshot = async ($: $, path: string): Promise<Snap> => {
  try {
    if (!(await $.fs.exists(path))) return { kind: 'missing' };
    const stat = await $.fs.stat(path);
    if (stat.kind !== 'file') return { kind: 'unreadable' };
    if (stat.size > MAX_READ) return { kind: 'large' };
    const text = await $.fs.read(path);
    return text.includes('\u0000') ? { kind: 'binary' } : { kind: 'text', text };
  } catch {
    return { kind: 'unreadable' };
  }
};

const scan = async ($: $, root: string, skip: string): Promise<Map<string, Seen>> => {
  const seen = new Map<string, Seen>();
  const queue = [slash(root)];
  while (queue.length > 0 && seen.size < MAX_SCAN) {
    const batch = queue.splice(0, 16);
    const listed = await Promise.all(
      batch.map((dir) =>
        $.fs.list(dir).then(
          (entries) => ({ dir, entries }),
          () => ({ dir, entries: [] })
        )
      )
    );
    for (const { dir, entries } of listed) {
      for (const entry of entries) {
        const path = join(dir, entry.name);
        if (entry.kind === 'dir') {
          if (!entry.isLink && !SKIPPED_DIRS.has(entry.name) && keyOf(path) !== skip) {
            queue.push(path);
          }
        } else if (entry.kind === 'file') {
          seen.set(keyOf(path), { path, sig: `${entry.size}:${entry.mtimeMs}` });
        }
      }
    }
  }
  return seen;
};

let current: Promise<Changeset> | undefined;

const open = async ($: $): Promise<Changeset> => {
  const cwd = slash(await $.session.cwd());
  const createdAt = await $.clock.now();
  const id = stampOf(createdAt);
  const project = cwd.replace(/[^A-Za-z0-9]/g, '-');
  const dir = join(join(await changesRoot($), project), id);
  return {
    id,
    createdAt,
    cwd,
    dir,
    link: fileUrl(join(dir, 'changes.diff')),
    files: new Map(),
  };
};

const ensure = ($: $) => (current ??= open($));

const note = (link: string) =>
  `[changes-list plugin] If you create, edit or delete any file during this turn ` +
  `(with any tool, shell commands included), end your final reply with this line, ` +
  `exactly as written and on its own line:\n\n[Changes list](${link})\n\n` +
  `If no file changed, leave the line out. Do not mention this note.`;

const fileHeader = (row: Row) => {
  const before = row.status === 'A' ? '(new file)' : `${row.rel} (before)`;
  const after = row.status === 'D' ? '(deleted)' : `${row.rel} (after)`;
  return [`${'='.repeat(72)}`, `--- ${before}`, `+++ ${after}`];
};

const summaryLine = (row: Row) => {
  const counts = [row.added > 0 ? `+${row.added}` : '', row.removed > 0 ? `-${row.removed}` : '']
    .filter(Boolean)
    .join(' ');
  const tail = row.note ? `(${row.note})` : counts;
  const line = `  ${row.status}  ${row.rel.padEnd(48)} ${tail}`;
  return row.open ? `${line}\n     ${row.open}` : line;
};

const finalize = async ($: $, cs: Changeset, isLinked: boolean): Promise<boolean> => {
  const rows: Row[] = [];
  const sections: string[] = [];
  const copies: { path: string; text: string }[] = [];

  for (const file of cs.files.values()) {
    const before = await file.before;
    const after = await snapshot($, file.path);
    if (before.kind === 'missing' && after.kind === 'missing') continue;

    const status = before.kind === 'missing' ? 'A' : after.kind === 'missing' ? 'D' : 'M';
    const row: Row = { status, rel: relativeTo(cs.cwd, file.path), added: 0, removed: 0 };
    if (status !== 'D') row.open = fileUrl(file.path);
    const beforeText = before.kind === 'text' ? before.text : before.kind === 'missing' ? '' : null;
    const afterText = after.kind === 'text' ? after.text : after.kind === 'missing' ? '' : null;

    if (beforeText === null || afterText === null) {
      const kind = before.kind === 'text' || before.kind === 'missing' ? after.kind : before.kind;
      row.note = kind === 'large' ? 'over 4 MiB, no line diff' : kind === 'binary' ? 'binary' : 'unreadable';
      rows.push(row);
      sections.push([...fileHeader(row), `# ${row.note}`].join('\n'));
      continue;
    }
    if (beforeText === afterText) continue;

    const diff = diffTexts(beforeText, afterText);
    row.added = diff.added;
    row.removed = diff.removed;
    if (row.open) row.open += `#L${diff.firstLine}`;
    if (diff.hunks.length === 0) row.note = 'line endings or final newline only';

    const mirror = mirrorOf(row.rel);
    row.before = join(join(cs.dir, 'before'), mirror);
    row.after = join(join(cs.dir, 'after'), mirror);
    copies.push({ path: row.before, text: beforeText }, { path: row.after, text: afterText });

    rows.push(row);
    sections.push([...fileHeader(row), ...diff.hunks].join('\n'));
  }

  if (cs.shellBaseline) {
    const base = await cs.shellBaseline;
    const now = await scan($, cs.cwd, keyOf(cs.dir));
    const marked: Row[] = [];
    const mark = (status: Row['status'], seen: Seen) => {
      if (cs.files.has(keyOf(seen.path))) return;
      marked.push({
        status,
        rel: relativeTo(cs.cwd, seen.path),
        added: 0,
        removed: 0,
        note: 'changed by a shell command, no line diff',
        open: status === 'D' ? undefined : fileUrl(seen.path),
      });
    };
    for (const [key, seen] of now) {
      const was = base.get(key);
      if (!was) mark('A', seen);
      else if (was.sig !== seen.sig) mark('M', seen);
    }
    for (const [key, seen] of base) if (!now.has(key)) mark('D', seen);
    marked.sort((x, y) => x.rel.localeCompare(y.rel));
    rows.push(...marked);
  }

  const when = new Date(cs.createdAt).toLocaleString();
  if (rows.length === 0) {
    if (isLinked) {
      await $.fs.write(join(cs.dir, 'changes.diff'), `Changes list · ${when}\n\nNo file changed in this turn.\n`);
    }
    return false;
  }

  const added = rows.reduce((n, r) => n + r.added, 0);
  const removed = rows.reduce((n, r) => n + r.removed, 0);
  const header = [
    `Changes list · ${when} · ${rows.length} file${rows.length === 1 ? '' : 's'} · +${added} -${removed}`,
    `Folder: ${cs.cwd}`,
    '',
    ...rows.map(summaryLine),
    '',
    '',
  ].join('\n');

  await Promise.all(copies.map((copy) => $.fs.write(copy.path, copy.text)));
  await $.fs.write(join(cs.dir, 'changes.diff'), `${header}${sections.join('\n\n')}\n`);
  await $.fs.write(
    join(cs.dir, 'manifest.json'),
    JSON.stringify({ id: cs.id, createdAt: cs.createdAt, cwd: cs.cwd, rows }, null, 2)
  );
  await $.store.set(`latest:${keyOf(cs.cwd)}`, cs.dir);
  return true;
};

const openNativeDiffs = async ($: $, rows: Row[]) => {
  const isWindows = (await $.env.get('OS')) === 'Windows_NT';
  let opened = 0;
  for (const row of rows) {
    if (!row.before || !row.after || opened >= MAX_NATIVE_DIFFS) continue;
    const args = ['--reuse-window', '--diff', row.before, row.after];
    const argv = isWindows ? ['cmd.exe', '/d', '/c', 'code', ...args] : ['code', ...args];
    const ran = await $.process.run(argv, { timeoutMs: 15000 }).catch(() => undefined);
    if (ran?.exitCode !== 0) return { opened, failed: true };
    opened++;
  }
  return { opened, failed: false };
};

export const register: Register = (on) => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'changes',
      description: "Open the last turn's changes as side-by-side diffs in VS Code",
    });
    return next(e);
  });

  on('prompt.submit', async ($, e, next) => {
    // A prompt folded into a running turn belongs to that turn's changeset.
    if (e.isMeta || e.turnId !== undefined) return next(e);
    const cs = await ensure($);
    return next({ ...e, context: [...(e.context ?? []), note(cs.link)] });
  });

  on('tool.call', async ($, e, next) => {
    const tool = String(e.tool);
    const input = e as unknown as { file_path?: unknown; notebook_path?: unknown };
    const target =
      tool === 'Edit' || tool === 'Write'
        ? input.file_path
        : tool === 'NotebookEdit'
          ? input.notebook_path
          : undefined;

    if (typeof target === 'string' && target !== '') {
      const cs = await ensure($);
      const path = isAbsolute(target) ? slash(target) : join(cs.cwd, target);
      const key = keyOf(path);
      if (!cs.files.has(key)) cs.files.set(key, { path, before: snapshot($, path) });
      await cs.files.get(key)?.before;
    } else if (SHELL_TOOLS.has(tool)) {
      const cs = await ensure($);
      cs.shellBaseline ??= scan($, cs.cwd, keyOf(cs.dir));
      await cs.shellBaseline;
    }
    return next(e);
  });

  on('turn.complete', async ($, e, next) => {
    const result = await next(e);
    if (e.agentId !== undefined || current === undefined) return result;

    const cs = await current;
    current = undefined;
    const isLinked = e.answer.includes(cs.id);
    const hasChanges = await finalize($, cs, isLinked);
    // The model forgot the line: show it beneath the answer instead.
    return hasChanges && !isLinked ? { ...result, text: `[Changes list](${cs.link})` } : result;
  });

  on('command.run', { command: 'changes' }, async ($) => {
    const cwd = slash(await $.session.cwd());
    const dir = await $.store.get(`latest:${keyOf(cwd)}`);
    if (typeof dir !== 'string') return { text: 'No changes recorded in this folder yet.' };

    const manifest = JSON.parse(await $.fs.read(join(dir, 'manifest.json'))) as { rows: Row[] };
    const link = `[Changes list](${fileUrl(join(dir, 'changes.diff'))})`;
    const { opened, failed } = await openNativeDiffs($, manifest.rows);
    if (failed && opened === 0) {
      return { text: `Could not run the \`code\` command to open VS Code's diff view. ${link}` };
    }
    return { text: `Opened ${opened} diff tab${opened === 1 ? '' : 's'} in VS Code. ${link}` };
  });
};
