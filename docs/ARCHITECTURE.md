# Token Never Sleeps Architecture

`token-never-sleeps` is the canonical TypeScript package for running the TNS external orchestration loop locally.

## Included

- CLI commands in `src/commands`
- state tracking in `.tns/`
- executor and verifier workflow graph
- stage-local skill injection for executor, verifier, compiler, and exploration agents
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

## Skill and verifier boundaries

- Executor skills are domain/action skills used to produce task artifacts.
- Verifier skills are audit skills used for independent review, readonly inspection, schema checks, official tests, or evidence collection.
- The verifier does not inherit executor skills by default. Use `injections.rules` to opt into shared skill context explicitly.
- `execution.verifier` models the verifier as a short-cycle validation node with a bounded runtime and no persistent task state.
- `skillbases.sources` lets a workspace reference user plugin libraries, extracted skillbases, or direct skill directories. `program.states[].parallel.skills` and `verifier_skills` declare imports at plan time; runtime resolves them, creates a per-agent plugin sandbox, records the selected source, and garbage-collects it after the call.
- TNS internal skills are separate from user injection skillbases. Package-local `skills/` entries are only resolved for TNS internal compile-time `tns-*` skills; executor, verifier, and exploration imports resolve from configured user skillbases or explicit external skill paths.
