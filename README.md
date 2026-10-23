# Changes list for Claude Code

A Claude Code plugin that adds a **Changes list** link to replies after files change. Open the link to see a per-turn summary and unified diff, without relying on Git.

## Install

Run this in your terminal with a current Claude Code version that supports TypeScript hook modules and `--marketplace`:

```sh
claude plugin install changes-list --marketplace SemihArslanhw/claude-changes-list
```

Or run this inside Claude Code:

```text
/plugin install changes-list --marketplace SemihArslanhw/claude-changes-list
```

You can also register the marketplace and install separately:

```text
/plugin marketplace add SemihArslanhw/claude-changes-list
/plugin install changes-list@claude-changes-list
```

Restart your Claude Code session after installing, or run `/reload-plugins`.

## Use

Work as usual. After a turn changes files, the reply includes a **Changes list** link to a local `changes.diff` file. VS Code displays additions and removals with diff highlighting.

Run `/changes` to open the latest recorded turn as side-by-side diffs in VS Code. This requires the `code` command on your PATH; at most 20 diff tabs open per invocation.

## What gets recorded

- `Edit`, `Write`, and `NotebookEdit`: before/after text snapshots and line diffs.
- Shell commands: added, modified, and deleted files detected by size and modification time, without line diffs.
- Binary, unreadable, and files over 4 MiB: a status note instead of a line diff.
- Shell scanning is limited to roughly 20,000 files and skips dependency, build, cache, and version-control directories.

Records are saved under `~/.claude/changes/`, or under `$CLAUDE_CONFIG_DIR/changes/` when configured. They include local paths and copies of edited text files, which may contain sensitive content. Records persist until you remove them. The plugin does not upload records.

## Local development

```sh
claude --plugin-dir .
claude plugin validate . --strict
claude plugin test .
```

The repository is both a plugin and a marketplace. `.claude-plugin/marketplace.json` points to the plugin at the repository root; hooks remain in `hooks/`.

Installation format: [Claude Code marketplace documentation](https://code.claude.com/docs/en/plugin-marketplaces).
