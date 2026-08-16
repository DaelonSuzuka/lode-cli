# lode-cli

Mechanical acceleration for [lode](https://github.com/can1357/oh-my-pi)-style project knowledge bases.

A lode is a directory of markdown files with optional YAML frontmatter. This tool indexes, searches, maps, and lints them. It is an acceleration layer, not a gate: `read`, `edit`, and `grep` work directly on the files at all times.

## Install

```sh
# from source
git clone https://github.com/DaelonSuzuka/lode-cli.git
cd lode-cli

# symlink to PATH (Linux/macOS)
ln -sf "$(pwd)/lode.ts" ~/.local/bin/lode

# or build a standalone binary (no Bun runtime needed)
bun build --compile lode.ts --outfile lode-bin
cp lode-bin ~/.local/bin/lode
```

Requires [Bun](https://bun.sh) to run the `.ts` file directly. The compiled binary is standalone.

### Windows

```cmd
bun build --compile lode.ts --outfile lode.exe
```

Place `lode.exe` in a directory on PATH. No Bun installation needed for the binary.

## Frontmatter schema

All fields optional, but `summary` + `keywords` are recommended for every file.

```yaml
---
type: domain          # domain (about this project) | external (about someone else's system)
tags: [proxmox, storage]
keywords: proxmox, cradle, storage, nas, omv, raid
summary: Current OMV shares, accounts, plugins, and migration contracts
---
```

The frontmatter parser is a hand-rolled subset of YAML — flat key-value pairs only. No nested mappings, no block lists. If the schema grows to need nested values, replace the parser with a real YAML library.

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

A project can have nested lodes in subdirectories (e.g., `src/peripherals/lode/`, `toolchain/lode/`). The tool merges sublodes by default — `search`, `list`, `map`, `tags`, `terms`, and `check` all see the full project. File paths include the sublode prefix (e.g., `src/peripherals/lode/uart.md`).

`lode startup` includes root entrypoint files plus each sublode's `summary.md`.

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

## License

MIT