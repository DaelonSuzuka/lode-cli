# lode-cli

Mechanical acceleration for [lode](https://github.com/can1357/oh-my-pi)-style project knowledge bases.

A lode is a directory of markdown files with optional YAML frontmatter. This tool indexes, searches, maps, and lints them. It is an acceleration layer, not a gate: `read`, `edit`, and `grep` work directly on the files at all times.

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
lode search <query>       match keywords, tags, type, summary, filename
lode list [--type=T] [--tag=T]   list files, optionally filtered
lode walk <file-or-dir>   resolve internal links, show linked summaries
lode map                  generate index from frontmatter
lode terms                aggregate term blocks into glossary
lode tags                 tag counts
lode check                lint frontmatter, links, terms, line count, orphans
lode mail send <project> <subject>   send inter-project mail (body on stdin)
lode mail read                        show and mark unread mail
lode mail list                        all mail for current project
lode mail unread                      print count of unread mail
```

### `--path=DIR`

Overrides the lode root directory. If omitted, the tool auto-detects by walking up from the current directory looking for a `lode/` subdirectory or a directory containing `lode-map.md` or `summary.md`.

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

- Missing frontmatter (no type, tags, keywords, or summary)
- Missing `type` (must be `domain` or `external`)
- Missing `summary` or `keywords`
- Broken internal links (relative path points at nothing)
- Term conflicts (same term name, different definition)
- Files over 250 lines
- Orphan files (no incoming links, not an entrypoint file)
- Invalid or unsafe sublode ownership declarations

## Plans with lifecycle

Plans in `plans/` carry a `status` field in their frontmatter:

```yaml
status: idea
```

The lifecycle: `idea` → `accepted` → `active` → `done` / `parked`.

The roadmap and todos files collapse into `plans/` with status filtering. A completed plan's conclusions are absorbed into the lode domain files that own that knowledge. The plan is the mechanism; the lode file is the owner.

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