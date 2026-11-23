[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/khususcrypto0000-coder/mend-makefun/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/khususcrypto0000-coder/mend-makefun/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

# mend

One patch tool for every AI edit format. `mend` reads a patch that an AI
model wrote — a unified diff (often with wrong line numbers), SEARCH/REPLACE
blocks, a V4A patch, or text-editor tool calls as JSON — finds the lines each
edit names even when the model drifted their whitespace or indentation, and
changes every file or none.

## Usage

```
node main.ts [--format=NAME] [--check] [--strict] [PATCH]
```

- `PATCH` is the patch file, relative to the working directory. With no
  patch, or `-`, the patch is read from standard input.
- `--format=NAME` reads the patch in one format: `unified`,
  `search-replace`, `v4a` or `json`. `auto`, the default, detects it.
- `--check` does everything but write: the same output and exit code, and
  no file is created, changed or deleted.
- `--strict` matches lines exactly (tier 0 only).

## How it reports

- Exit 2, one line, when the patch cannot be used at all: `error: usage`,
  `error: no-patch`, `error: format`, or `error: parse <N>`.
- Exit 1 when some edits failed: one `error: <code> <path>` line per failed
  edit, then `failed: <k> of <n> edits`. Nothing is written.
- Exit 0 when every edit applied: one line per changed path (`A`, `D`, `M`,
  or `R <old> -> <new>` for a move), then `ok: <n> files`.

## Matching

Old lines are found at the first of three tiers at which they occur at
least once: exact lines, lines equal once trailing spaces and tabs are
removed, then lines equal once leading and trailing spaces and tabs are
removed. A unified hunk takes the occurrence nearest to the line number the
diff names; a SEARCH/REPLACE block needs exactly one occurrence; a V4A
chunk takes the first occurrence at or after its cursor (or its anchor).
At tier 2, added lines are re-indented from the patch's indentation to the
file's, and context lines are always written as the file's own lines.

## Layout

- `main.ts` — the CLI itself (Node 22, standard library only).
- `runner.ts` — the trial runner: with `MAKEFUN_ENV_URL` set, `main.ts`
  hands the trial over to it, and it runs the CLI on every check the env
  serves and posts the results back.
- `check.ts` — runs the kit's public practice set against `main.ts`:
  `node check.ts <practice.json> [<family or key prefix>...]`.

## Practice result

100 of 100 practice checks pass (practice score 1000) on the kit's public
practice set, run twice with identical results.

## Notes

- Deterministic: the same check gives the same exit code, stdout and files
  every run. No clock, no randomness, no network.
- All-or-nothing: a failed edit changes nothing, edits after it still run,
  and when any edit failed no file is written at all.
