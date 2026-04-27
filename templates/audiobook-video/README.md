# TNS Audiobook Video Template

This template turns one prose chapter into a short English audiobook video with
generated still backgrounds, generated BGM, multi-voice TTS, burned subtitles,
and deterministic ffmpeg editing.

Intended scope:

- One source chapter or scene bundle per workspace.
- 2 to 4 scenes, final video under 4 minutes.
- No AI video generation. Still images, music, and voice may be generated, but
  editing is code-level and repeatable.

Workflow:

1. Put the source prose in `source/chapter.md`.
2. Run `tns init --workspace ./video-project --template audiobook-video`, then run TNS with `tns_config.json` so the executor creates or refines
   `src/production_manifest.json`.
3. Generate image, music, and speech assets according to the manifest.
4. Run `node scripts/build_video.mjs`.
5. Run `node scripts/check_video.mjs`.

Optional dialogue standees:

Add a `character_art` object to `src/production_manifest.json` when you want
transparent character PNGs to appear only during matching non-narrator dialogue
clips. The build script composites them before subtitles are burned in.

```json
{
  "character_art": {
    "Commander Chen": {
      "file": "assets/characters/chen-standee.png",
      "side": "left",
      "height": 635
    },
    "Mira Rao": {
      "file": "assets/characters/mira-standee.png",
      "side": "right",
      "height": 610
    }
  }
}
```

Suggested media commands:

```bash
your-image-command --aspect-ratio 16:9 --out-dir assets/images --out-prefix scene-01 --prompt "..."
your-music-command --instrumental --out assets/bgm/chapter-bgm.mp3 --prompt "..."
your-tts-command --voice narrator_cinematic --out assets/audio/scene-01-01-narrator.mp3 --text "..."
node scripts/build_video.mjs
node scripts/check_video.mjs
```
