# Novel Writing Task

Write a five-chapter short story using the persistent story bible files in this
workspace. Each section owns exactly one chapter.

Global protocol for every section:

- Read `story_bible/world.md`, `story_bible/characters.md`, `story_bible/timeline.md`,
  `story_bible/entities.md`, `story_bible/chapter_summaries.md`, and all previous
  chapter files before writing.
- Before drafting, update any needed assumptions in world, timeline, or character notes.
- Write the chapter to `draft/chapters/chapter-XX.md`.
- Append a concise chapter summary and continuity handoff to `story_bible/chapter_summaries.md`.
- Update entity relationship changes in `story_bible/entities.md`.
- Merge lasting character state changes back into `story_bible/characters.md`.
- Run `node scripts/check_novel.js` before claiming the section is ready.

## Chapter 01: Opening pressure

Write the first chapter. Establish the world, the protagonist, the main political
crisis, and the immediate stakes.

Acceptance criteria:

- `draft/chapters/chapter-01.md` exists and contains a complete chapter.
- The chapter creates a clear inciting pressure point.
- Story bible files reflect the chapter's durable changes.
- `node scripts/check_novel.js` passes.

## Chapter 02: Escalation

Write the second chapter. Escalate the conflict and make at least one relationship
or loyalty more complicated.

Acceptance criteria:

- `draft/chapters/chapter-02.md` exists and contains a complete chapter.
- The chapter follows causally from chapter 01.
- Story bible files reflect the chapter's durable changes.
- `node scripts/check_novel.js` passes.

## Chapter 03: Reversal

Write the third chapter. Deliver the central reversal of the story.

Acceptance criteria:

- `draft/chapters/chapter-03.md` exists and contains a complete chapter.
- The chapter changes the political or personal situation irreversibly.
- Story bible files reflect the chapter's durable changes.
- `node scripts/check_novel.js` passes.

## Chapter 04: Collapse

Write the fourth chapter. Show the cost of the reversal and force the surviving
characters into a narrower path.

Acceptance criteria:

- `draft/chapters/chapter-04.md` exists and contains a complete chapter.
- The chapter tightens the danger and prepares the ending.
- Story bible files reflect the chapter's durable changes.
- `node scripts/check_novel.js` passes.

## Chapter 05: Escape

Write the final chapter. Complete this prequel arc while leaving a clean opening
for a larger novel.

Acceptance criteria:

- `draft/chapters/chapter-05.md` exists and contains a complete chapter.
- The ending resolves the immediate escape while preserving future stakes.
- Story bible files contain final summaries and relationship states.
- `node scripts/check_novel.js` passes.
