# Atlas

Atlas is a lightweight persistent memory extension for [pi](https://pi.dev/).
The public package source and the private runtime memory are deliberately kept
in separate locations:

- `~/src/pi-atlas/` — public/package source: the pi package manifest and
  extension code.
- `~/.atlas/memory/` — private runtime memory: daily context, projects,
  knowledge, and history.

**Memory is not part of this public repository.** Do not copy, commit, publish,
or otherwise share `~/.atlas/memory/`; it may contain private or sensitive
personal and project information. The repository's `.gitignore` also excludes
`memory/` and other local state as a safety measure.

## What it does

- **Auto-injects context** at session start: `memory/daily.md` and
  `memory/projects.md` are appended to the system prompt.
- **Knowledge triggers**: `memory/knowledge/index.csv` maps reference docs to
  trigger words. When a trigger appears in a prompt, the matching knowledge
  file is injected automatically.
- **Three tools** for keeping memory current:
  - `atlas_read` — read a file by relative path
  - `atlas_update` — replace or append to a file
  - `atlas_search` — search the knowledge trigger index
- **Nightly archive**: stale `daily.md` files are moved to
  `memory/history/daily/<date>.md` at session start.
- **`/atlas-status` command** — show today's context and active projects.

## Runtime memory location

The extension reads and writes memory beneath `ATLAS_ROOT`. If unset,
`ATLAS_ROOT` defaults to `~/.atlas`, so the default memory directory is
`~/.atlas/memory/`:

```bash
export ATLAS_ROOT="$HOME/.atlas"
```

Set `ATLAS_ROOT` to another private directory before starting pi if the memory
bank should live elsewhere. The source package remains in `~/src/pi-atlas`.

## Install

### Local checkout

Install the local package directly:

```bash
pi install ~/src/pi-atlas
```

Or add the local path to `~/.pi/agent/settings.json`:

```json
{
  "packages": ["~/src/pi-atlas"]
}
```

Restart pi after installing or changing package settings. The Atlas tools and
`/atlas-status` command will then be available in each session.

### GitHub package

After this source has been published to GitHub, install it with the repository
URL (replace `OWNER` with the GitHub account or organization):

```bash
pi install git:github.com/OWNER/pi-atlas
```

This checkout currently has no remote and has not been published. Publishing
or installing from GitHub does **not** include the private memory directory;
keep `~/.atlas/memory/` separate and private.

## Memory conventions

- Keep `daily.md` to 150 lines or fewer, append entries rather than overwriting.
- Keep `projects.md` to 50 lines or fewer, grouped by priority.
- Add reference documents under `memory/knowledge/` and register their triggers
  in `memory/knowledge/index.csv`.
- The memory directory is ordinary local files; back it up privately if needed.
