# lode-cli Extensions

These portable rules extend the base Lode methodology with mechanical tooling.
They are not installed by `install.sh`; compose them into the target agent rules
when the global prompt does not already carry the same contract.

## The `lode` tool

The `lode` CLI is an acceleration layer, not a project-file editor. Content
commands are read-only over the Lode; use `read` and `edit` directly. Mail
commands separately mutate mailbox and registry state under `~/.lode/`.

- `lode search <query>` — find files by keywords, tags, status, summary, or
  filename when the target is not already known.
- `lode list [--type=T] [--tag=T]` — list the files in the root and declared
  sublodes.
- `lode walk <file-or-dir>` — follow internal links and show linked summaries.
- `lode terms` — aggregate inline term blocks across the owned Lode.
- `lode map` — generate the directory index from frontmatter.
- `lode check` — lint frontmatter, ownership and source relationships, links,
  term conflicts, plan status, and orphans. Run it after editing Lode files.
- `lode plans [--status=S]` — list plans in lifecycle order or select one
  lifecycle state.
- `lode precommit` — report Lode files whose exact `sources` relationships
  match staged Git changes.
- `lode recent [N]` — show patches for the newest `N` commits that touched the
  root or a declared sublode.
- `lode mail send <project> <subject>` — send inter-project mail with the body
  on stdin.
- `lode mail read` — read and mark unread mail for the current project.

## Frontmatter schema

General Lode files may carry four retrieval fields:

```yaml
---
type: domain
tags: [proxmox, storage]
keywords: proxmox, cradle, storage, nas, omv, raid
summary: Current OMV shares, accounts, plugins, and migration contracts
---
```

- `type` — `domain` for this project or `external` for another system.
- `tags` — cross-cutting labels.
- `keywords` — retrieval terms, including synonyms, names, errors, and numbers.
- `summary` — one-line description used by navigation commands.

Mechanism-specific fields exist only where a command consumes them:

- `sublodes` on the selected root `summary.md` declares Lode ownership.
- `sources` on any Lode file declares exact source-file relationships.
- `status` on files under `plans/` records plan lifecycle.

The parser supports flat scalar fields and inline or block lists. It does not
implement nested mappings or general YAML semantics. Fields are optional, but
`summary` and `keywords` should normally be present; `lode check` reports
missing recommended or mechanism-required fields.

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

The selected root `summary.md` declares the complete set of nested Lodes owned
by the project:

```yaml
sublodes:
  - src/peripherals/lode
  - toolchain/lode
```

Paths are relative to the project root, the parent of the selected root Lode.
The tool never infers ownership by recursively searching for directories named
`lode`; the same directory shape may belong to an unrelated project. Unlisted
Lodes are outside scope. Root and declared sublodes are merged by navigation,
checking, plans, startup, and Git-aware commands.

`lode check` rejects absolute, escaping, missing, duplicate, overlapping,
self-referential, and summary-less declarations.

## Source relationships and Git history

Any Lode file may declare the exact project files it documents:

```yaml
sources:
  - src/os/shell.c
  - src/os/shell.h
```

Source paths are project-relative and may name a currently missing file so a
staged deletion still activates the relationship. `lode precommit` considers
all staged change types, including both sides of renames. Matches are
informational and exit successfully.

`lode recent [N]` prints metadata and owned-Lode patches for the newest `N`
Lode-touching commits; `N` defaults to 5. It excludes unrelated source patches
from mixed commits. Both Git commands warn and skip declared Lodes outside the
selected root's repository rather than merging repositories implicitly.

## Plans with lifecycle

Plans in an owned Lode's `plans/` directory carry one lifecycle status:

```yaml
status: idea
```

The lifecycle is `idea` → `accepted` → `active` → `done` / `parked`.

- `idea` — unvetted backlog item.
- `accepted` — committed work not currently active.
- `active` — currently being worked.
- `done` — conclusions merged into the domain files that own the knowledge.
- `parked` — deferred but retained.

`lode plans` lists every plan in lifecycle order.
`lode plans --status=active` is the roadmap;
`lode plans --status=idea` is the backlog. `lode check` reports missing or
unknown plan status.

Roadmap and todo files collapse into `plans/`. A plan is the intent and
coordination mechanism, not a disposable task: it completes when its conclusions
are absorbed by the Lode files that own them.

## Inter-project mail

`lode mail` provides a dead-drop for cross-project communication. Each project
has a mailbox at `~/.lode/mail/<project>/`. Any mail command registers the
calling project. Ambiguous project names are rejected — use the full path.