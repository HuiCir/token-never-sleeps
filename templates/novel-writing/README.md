# Novel Writing TNS Template

This template turns long-form fiction into small TNS sections. Each section writes
one chapter and updates the persistent story bible before the verifier accepts it.

Core loop for every chapter:

1. Review `story_bible/world.md`, `story_bible/characters.md`, `story_bible/timeline.md`,
   `story_bible/entities.md`, `story_bible/chapter_summaries.md`, and previous chapters.
2. Update the relevant world and character assumptions before drafting.
3. Write one complete chapter in `draft/chapters/chapter-XX.md`.
4. Append a chapter summary and continuity note to `story_bible/chapter_summaries.md`.
5. Update entity relationship changes in `story_bible/entities.md`.
6. Merge lasting character changes back into `story_bible/characters.md`.

Recommended run:

```bash
tns init --workspace ./novel-project --template novel-writing
cd ./novel-project
tns run --config ./tns_config.json --once
tns status --config ./tns_config.json
```

Repeat `tns run --once` until all chapter sections are done, or use `tns start`
for a longer unattended loop.
