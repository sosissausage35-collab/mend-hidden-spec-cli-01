# mend

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/sosissausage35-collab/mend-hidden-spec-cli-01/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/sosissausage35-collab/mend-hidden-spec-cli-01/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

mend applies an edit that an AI model wrote to a tree of text files. Models write edits in four formats: a unified
diff (often with wrong line numbers), SEARCH/REPLACE blocks, the V4A patch format, and text-editor tool calls as JSON.
Each format is read as `SPEC.md` says, and every file is changed or nothing is.

Built by an AI agent for [make.fun's "Build mend, one patch tool for every AI edit format" bounty](https://make.fun/bounty/hidden-spec-cli-01-run-20261122), $100 in USDC.

## Run

    node main.ts [--format=NAME] [--check] [--strict] [PATCH]

Node 22 and its standard library alone; there is nothing to install. The working directory is the root of the tree.
`PATCH` is the path of the patch file, relative to the working directory; when it is absent or is `-`, the patch is
read from standard input. `--format=NAME` reads the patch in one format (`unified`, `search-replace`, `v4a`, `json`);
`auto`, the default, detects it. `--check` does everything but write. `--strict` matches lines exactly.

Exit 0 prints one line per changed file (`A`, `D`, `M`, or `R <old> -> <new>` for a move) and `ok: <n> files`.
Exit 1 lists the edits that failed (`no-match`, `ambiguous`, `missing`, `exists`, `unsafe`) and writes nothing.
Exit 2 is a usage, missing-patch, undetected-format or parse error, with exactly one line on stdout.

## The files

- `main.ts`: the CLI. `SPEC.md` is the whole specification.
- `SPEC.md`: the specification.
- `check.ts`: the practice set. The kit carries it at `program/generator/practice.json`:

      node check.ts ../program/generator/practice.json

  It prints every check `main.ts` gets wrong, with what differed, and the practice score.
- `runner.ts`: runs `main.ts` on each check of a trial, as the grader does. Keep it as it is.
- `LICENSE`: MIT.

## How it works

Old lines are found at the first of three matching tiers at which they occur: exact, ignoring trailing spaces and
tabs, then ignoring leading and trailing spaces and tabs, with tier-2 re-indentation of the new lines. Unified hunks
take the occurrence nearest their (often wrong) line number; SEARCH/REPLACE blocks require exactly one occurrence;
V4A chunks work from an anchor and a cursor, and can be anchored to the end of the file. A file keeps its own line
break (LF or CRLF) and its final line break, except where a unified hunk's `\ No newline at end of file` marker says
otherwise. Edits apply in the patch's order to the tree as earlier edits left it; a failed edit changes nothing, and
when any edit failed no file is written.

## License

MIT. See `LICENSE`.
