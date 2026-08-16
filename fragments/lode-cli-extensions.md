# lode-cli Extensions

These rules extend the base lode methodology with mechanical tooling. They sit
on top of the existing lode contract, not in place of it.

## The `lode` tool

The `lode` CLI is available for searching and navigating the project lode.
It is an acceleration layer, not a gate — `read`, `edit`, and `grep` work
directly on the files at all times.

- `lode search <query>` — find files by keywords, tags, summary, or filename.
  Use this instead of grepping the lode directory when you don't know which file
  you need.
- `lode walk <file-or-dir>` — follow internal links from a file, showing
  linked summaries. Use this to orient quickly when entering a subsystem.
- `lode terms` — aggregate term blocks across the lode. Use this instead of
  reading `terminology.md` when you need a specific definition.
- `lode check` — lint frontmatter, links, term conflicts, and orphans. Run
  this after editing lode files.
- `lode map` — regenerate the directory index from frontmatter.
- `lode mail send <project> <subject>` — send inter-project mail (body on
  stdin). Use this when one project's agent needs to ask another a question.
- `lode mail read` — read and mark unread mail for the current project.

## Frontmatter schema

Lode files carry optional YAML frontmatter with four fields:

```yaml
---
type: domain          # domain (about this project) | external (about someone else's system)
tags: [proxmox, storage]
keywords: proxmox, cradle, storage, nas, omv, raid
summary: Current OMV shares, accounts, plugins, and migration contracts
---
```

- `type` — whether this file is a statement about this project (`domain`) or
  about an external system (`external`). An external file is kept for
  compatibility or reverse-engineering; it is not a claim about the project's
  own state.
- `tags` — cross-cutting labels for grouping.
- `keywords` — retrieval terms: synonyms, names, error strings, numbers. Be
  generous; these are what `lode search` matches on.
- `summary` — one-line description used by `lode map` and `lode walk`.

All fields are optional, but `summary` and `keywords` should be present on
every file. `lode check` flags missing fields.

## Term blocks

Terms are defined inline in any file:

```markdown
## Terms

- **RAIDZ2** — ZFS RAID variant tolerating two drive failures
- **OMV** — OpenMediaVault, the NAS management interface
```

`lode terms` aggregates these across the lode. The standalone `terminology.md`
is the human-authored cross-check; the tool-generated glossary is the
comprehensive view. Term conflicts (same name, different definition) are
flagged by `lode check`.

## Sublodes

A project can have nested lodes in subdirectories (e.g.,
`src/peripherals/lode/`, `toolchain/lode/`). The tool merges sublodes by
default — search, list, map, and check see the full project. `lode startup`
includes each sublode's `summary.md` in the session-start context.

## Plans with lifecycle

Plans in `plans/` carry a `status` field in their frontmatter:

```yaml
status: idea
```

The lifecycle: `idea` → `accepted` → `active` → `done` / `parked`.

- `idea` — unvetted, was a todo.
- `accepted` — committed to, was a roadmap item.
- `active` — being worked on.
- `done` — conclusions merged into lode domain files; the plan's job is
  complete.
- `parked` — deferred but not abandoned.

The roadmap and todos files collapse into `plans/` with status filtering.
`lode plans --status=active` is the roadmap. `lode plans --status=idea` is
the backlog. A completed plan's conclusions are absorbed into the lode domain
files that own that knowledge. The plan is the mechanism; the lode file is
the owner.

## Inter-project mail

`lode mail` provides a dead-drop for cross-project communication. Each project
has a mailbox at `~/.lode/mail/<project>/`. Any mail command registers the
calling project. Ambiguous project names are rejected — use the full path.