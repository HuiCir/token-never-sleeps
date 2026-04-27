# Token Never Sleeps Architecture

`token-never-sleeps` is the canonical TypeScript package for running the TNS external orchestration loop locally.

## Included

- CLI commands in `src/commands`
- state tracking in `.tns/`
- executor and verifier workflow graph
- tmux-aware startup selection
- plan import and artifact indexing
- workspace templates

## Excluded

- Python runners and hooks
- plugin marketplace packaging
- remote notification bridges
- site assets and published case media

## Runtime shape

1. `tns init` writes `task.md`, `tns_config.json`, and `.tns/`
2. `tns run` selects one section and runs the executor/verifier loop
3. results are recorded in `.tns/sections.json`, `.tns/reviews.json`, `.tns/activity.jsonl`, and `.tns/handoff.md`
4. `tns status` reads the same state files and reports current progress
