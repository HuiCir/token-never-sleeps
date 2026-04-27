# Audiobook Video Task

Create a short English audiobook video from the source chapter in this
workspace. The final video must use generated still backgrounds, generated or
procedural BGM, multi-voice speech, burned English subtitles, and deterministic
ffmpeg editing. Do not use AI video generation.

Constraints:

- Source prose is in `source/chapter.md`.
- Keep the final video between 90 and 240 seconds.
- Use 3 or 4 scenes.
- Use at least 3 voices: narrator plus two characters.
- Subtitle text and voice text must be English.
- Every generated asset and command should be recorded in `build/run-logs/`.

## Section 1: English adaptation and production manifest

Read `source/chapter.md` and create `src/production_manifest.json`. The manifest
must include the title, resolution, BGM path, output path, voice cast, and a
scene list. Each scene must include a concise visual prompt, an emotional tone,
and short voice clips with `speaker`, `voice`, `emotion`, `file`, and `text`.

Acceptance criteria:

- `src/production_manifest.json` exists and is valid JSON.
- The manifest has 3 or 4 scenes.
- The manifest uses at least 3 distinct speakers and at least 3 voice IDs.
- The complete spoken script is English and short enough for a sub-4-minute
  video.
- `node scripts/check_manifest.mjs` passes.

## Section 2: Media generation

Generate or place the assets listed in `src/production_manifest.json`. Still
images should be 16:9 science-fiction backgrounds. BGM should be instrumental
and subdued enough for spoken narration. Speech must use the requested voices
and should match the emotion labels.

Acceptance criteria:

- Every `scene.image` file exists.
- The configured BGM file exists.
- Every clip `file` exists.
- Asset generation commands and adjustments are recorded under
  `build/run-logs/`.
- `node scripts/check_manifest.mjs --assets` passes.

## Section 3: Deterministic edit and QA

Run the code-level edit and verify the result.

Acceptance criteria:

- `node scripts/build_video.mjs` creates the configured output video.
- `node scripts/check_video.mjs` passes.
- Final video has a video stream, an audio stream, 1280x720 resolution, and a
  duration between 90 and 240 seconds.
- English subtitles are burned into the rendered frames.

