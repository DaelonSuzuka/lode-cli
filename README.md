# lode-cli

Mechanical acceleration for [lode](https://github.com/can1357/oh-my-pi)-style project knowledge bases.

A Lode is a directory of Markdown files with optional YAML frontmatter. Content
commands index, search, map, and lint without modifying project files; use
`read` and `edit` for direct access. Mail commands separately write mailbox and
registry state under `~/.lode/`.

## Install

```sh
# from source
git clone https://github.com/DaelonSuzuka/lode-cli.git
cd lode-cli

# install everything (CLI + omp hook)
./install.sh

# or install just the CLI
./install.sh cli

# or install just the omp startup hook
./install.sh hook

# verify what's installed
./install.sh check
```

Requires [Bun](https://bun.sh) to run the `.ts` file directly. The compiled
binary is standalone (no Bun runtime needed).

### omp integration

The `install.sh hook` command symlinks `hooks/load-lode.ts` into
`~/.omp/agent/hooks/pre/`. This hook replaces omp's built-in lode loading with
`lode startup`, which adds sublode summaries and tool help to the session-start
context. The hook falls back silently if `lode` is not on PATH.

### Windows

```cmd
bun build --compile lode.ts --outfile lode.exe
```

Place `lode.exe` in a directory on PATH. No Bun installation needed for the
binary.

## Frontmatter schema

All fields are optional. `summary` and `keywords` are recommended for every
file. The selected root's `summary.md` may also declare the complete set of
sublodes that belong to the project:

```yaml
---
type: domain          # domain (about this project) | external (about someone else's system)
tags: [proxmox, storage]
keywords: proxmox, cradle, storage, nas, omv, raid
summary: Current OMV shares, accounts, plugins, and migration contracts
sublodes:
  - src/os/lode
  - src/peripherals/lode
  - toolchain/lode
---
```

Sublode paths are relative to the project root, which is the parent of the
selected root lode. The list is complete rather than recursive: unlisted lodes
are outside the project's ownership scope.

Any Lode file may declare the exact project source files it documents:

```yaml
---
sources:
  - src/os/shell.c
  - src/os/shell.h
---
```

Source paths are also relative to the project root. They need not currently
exist, so a staged deletion can still notify the Lode file that documented it.

The frontmatter parser supports flat scalar fields plus inline and block lists.
It does not implement nested mappings, multiline strings, anchors, or
references.

## Term blocks

Define terminology inline in any file:

```markdown
## Terms

- **RAIDZ2** — ZFS RAID variant tolerating two drive failures
- **OMV** — OpenMediaVault, the NAS management interface
```

`lode terms` aggregates all term blocks across the lode and flags conflicts (same term name, different definition).

## Commands

```
lode startup              dump entrypoint files for session start
lode search <query>       metadata search; --content enables bounded full text
lode list [--type=T] [--tag=T]   list files, optionally filtered
lode walk <file-or-dir>   resolve internal links, show linked summaries
lode map                  print directory index from frontmatter
lode terms                aggregate term blocks into glossary
lode tags                 tag counts
lode check                lint frontmatter, links, terms, line count, orphans
lode precommit            report staged sources linked from lode files
lode recent [N]           show patches for recent lode-touching commits
lode plans [--status=S]  list and filter plans by lifecycle status
lode mail send <project> <subject>   send inter-project mail (body on stdin)
lode mail read                        show and mark unread mail
lode mail list                        all mail for current project
lode mail unread                      print count of unread mail
```

### `--path=DIR`

Overrides the lode root directory. If omitted, the tool auto-detects by walking up from the current directory looking for a `lode/` subdirectory or a directory containing `lode-map.md` or `summary.md`.

### Search modes

`lode search <query>` keeps the metadata-first behavior: it matches keywords,
tags, type, lifecycle status, summary, and filename. Full text is explicit:

```bash
lode search snapshots --content
lode search snapshots --content --under=lode/machines/cradle
```

`--under` accepts a project-relative file or directory exactly as printed by
Lode commands. The loader filters paths before reading Markdown bodies, allowing
a metadata pass to identify a subtree and a second content pass to search only
that scope. Absolute and project-escaping scopes are rejected.

Search results are bounded to 20 files by default; `--limit=N` accepts 1-100.
Text mode emits at most three anchored snippets per file. `--json` emits the
same bounded results as a stable machine-readable object.
Machine callers should pass exact query text as `--query=TEXT`; it cannot be
mistaken for a search flag. Positional query text remains the concise human
interface, and mixing positional text with `--query` is rejected.

## Sublodes

A project owns nested lodes by listing them in its root `summary.md` frontmatter.
The tool does not infer ownership by recursively searching for directories named
`lode`; the same directory shape can represent either a sublode or an unrelated
project.

Declared sublodes are merged by default. `search`, `list`, `map`, `tags`,
`terms`, and `check` see the full declared project. File paths include the
sublode prefix, such as `src/peripherals/lode/uart.md`. `lode startup` includes
root entrypoint files plus every declared sublode's `summary.md`.

`lode check` reports declarations that are absolute, escape the project root,
refer back to the root lode, overlap or duplicate another declaration, do not
name a directory, or lack `summary.md`. Invalid declarations are skipped by all
commands.

## Precommit source relationships

`lode precommit` reads every staged Git change and compares both sides of
renames with the optional `sources` lists on root and declared-sublode files:

```text
[INFO] lode/architecture/shell.md: staged source changed → src/os/shell.c
```

Matches are informational and exit successfully. The command errors only when
the selected Lode is outside Git or Git cannot read the index. Absolute,
project-escaping, and duplicate source declarations are reported by
`lode check`; invalid declarations are skipped by `precommit`.

## Recent committed changes

`lode recent [N]` shows commit metadata and unified patches for the newest `N`
commits that touched the root or a declared sublode. `N` defaults to 5 and
counts Lode-touching commits, not repository commits. Patches exclude unrelated
source changes from mixed commits.

The command reads committed history only; staged impact belongs to
`lode precommit`. It asks Git for the repository containing the selected root,
so it works both when `lode/` is part of a project repository and when the Lode
directory is itself a repository.

Both Git commands warn and skip declared lodes outside the selected root's
repository; they do not merge histories or indexes across repositories.

## Mail

Inter-project dead-drop mail. Each project has a mailbox at `~/.lode/mail/<project>/`. Mails are individual JSON files (UUID-named).

```sh
# send mail (body on stdin)
echo "Can you review the ADC abstraction?" | lode mail send MC-7300 "ADC review"

# read unread mail for the current project
lode mail read

# list all mail
lode mail list

# count unread (machine-readable)
lode mail unread
```

Any mail command registers the current project in `~/.lode/projects.json`. Project resolution tries: exact mailbox name, final path segment, relative path from `~/projects/`, full path. Ambiguous names are rejected loudly with the list of matching paths.

## Lode root detection

The tool finds the lode root in this order:

1. `--path=DIR` — explicit override, always wins
2. `./lode/` — a `lode/` subdirectory in the current directory
3. Current directory itself, if it contains `lode-map.md` or `summary.md`
4. Walk up from cwd looking for a `lode/` subdirectory

## What `lode check` catches

- Missing recognized frontmatter
- Missing `type` (must be `domain` or `external`)
- Missing `summary` or `keywords`
- Broken internal links (relative path points at nothing)
- Term conflicts (same term name, different definition)
- Files over 250 lines
- Orphan files (no incoming links, not an entrypoint file)
- Invalid or unsafe sublode ownership declarations
- Invalid, escaping, or duplicate `sources` declarations
- Missing or unknown lifecycle status on plan files

## Plans with lifecycle

Plans in each owned Lode's `plans/` directory carry a `status` field:

```yaml
---
status: idea
summary: Candidate intent and its current constraints
---
```

The lifecycle is `idea` → `accepted` → `active` → `done` / `parked`.

```sh
lode plans
lode plans --status=active
lode plans --status=idea
lode plans --status=done
```

The unfiltered command merges root and declared-sublode plans and sorts them by
lifecycle state, then path. Missing or unknown status remains visible in the
unfiltered output and is reported by `lode check`; filters accept only the five
recognized states.

Every change still moves through understanding, expectation, implementation,
and evidence, but not every loop warrants a plan file. Materialize a plan only
when it reduces coordination, interruption, or re-entry cost. A plan is a
transient working packet carrying the current expectations, decisions, evidence
boundary, and unresolved questions—not a routine implementation prerequisite or
project history.

`idea` plans form the backlog and `active` plans form the roadmap. `done` means
implementation is complete but durable absorption and deletion remain; use
`lode plans --status=done` as the closure queue. Once lasting rationale,
decisions, relationships, and expectations have reached their owning Lode or
product artifacts, inspect the plan for unique information and delete it.
Roadmap and todo files are legacy migration inputs rather than parallel
authorities.

## Repository contents

```
lode-cli/
  lode.ts                       # the CLI tool (single file, zero dependencies)
  lode.test.ts                  # focused CLI regression tests
  hooks/
    load-lode.ts                # omp startup hook (shells out to `lode startup`)
  fragments/
    lode-cli-extensions.md      # agent rules for the lode-cli extensions
  install.sh                    # install CLI + hook
  README.md
```

## License

MIT