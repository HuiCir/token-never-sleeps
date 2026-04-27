#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const manifest = JSON.parse(readFileSync("src/production_manifest.json", "utf8"));
const width = manifest.resolution?.width || 1280;
const height = manifest.resolution?.height || 720;
const buildDir = "build";
const audioDir = `${buildDir}/scene-audio`;
const videoDir = `${buildDir}/scene-video`;
const subtitleDir = `${buildDir}/subtitles`;
const silencePath = `${audioDir}/silence-450ms.mp3`;
mkdirSync(audioDir, { recursive: true });
mkdirSync(videoDir, { recursive: true });
mkdirSync(subtitleDir, { recursive: true });
mkdirSync(dirname(manifest.output), { recursive: true });

function run(cmd, args, label) {
  const result = spawnSync(cmd, args, { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`${label} failed\n${result.stderr || result.stdout}`);
  }
  return result.stdout;
}

function selectVideoCodecArgs() {
  const encoders = run("ffmpeg", ["-hide_banner", "-encoders"], "list ffmpeg encoders");
  if (encoders.includes("libx264")) return ["-c:v", "libx264", "-preset", "medium", "-crf", "20"];
  if (encoders.match(/\bmpeg4\b/)) return ["-c:v", "mpeg4", "-q:v", "4"];
  throw new Error("no usable MP4 video encoder found; expected libx264 or mpeg4");
}

const videoCodecArgs = selectVideoCodecArgs();

function ensureSilence() {
  run("ffmpeg", [
    "-y",
    "-f", "lavfi",
    "-i", "anullsrc=r=32000:cl=mono",
    "-t", "0.45",
    "-c:a", "libmp3lame",
    "-b:a", "128k",
    silencePath,
  ], "create pause audio");
}

function durationSeconds(file) {
  const out = run("ffprobe", [
    "-v", "error",
    "-show_entries", "format=duration",
    "-of", "default=noprint_wrappers=1:nokey=1",
    file,
  ], `ffprobe ${file}`);
  const value = Number.parseFloat(out.trim());
  if (!Number.isFinite(value) || value <= 0) throw new Error(`invalid duration for ${file}: ${out}`);
  return value;
}

function assTime(seconds) {
  const cs = Math.max(0, Math.round(seconds * 100));
  const h = Math.floor(cs / 360000);
  const m = Math.floor((cs % 360000) / 6000);
  const s = Math.floor((cs % 6000) / 100);
  const c = cs % 100;
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(c).padStart(2, "0")}`;
}

function assEscape(text) {
  return String(text).replace(/[{}]/g, "").replace(/\n/g, " ");
}

function writeAss(file, cues) {
  const lines = [
    "[Script Info]",
    "ScriptType: v4.00+",
    `PlayResX: ${width}`,
    `PlayResY: ${height}`,
    "ScaledBorderAndShadow: yes",
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    "Style: Default,DejaVu Sans,36,&H00FFFFFF,&H000000FF,&HAA000000,&H80000000,0,0,0,0,100,100,0,0,1,2,1,2,80,80,46,1",
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
  ];
  for (const cue of cues) {
    lines.push(`Dialogue: 0,${assTime(cue.start)},${assTime(cue.end)},Default,,0,0,0,,${assEscape(cue.text)}`);
  }
  writeFileSync(file, `${lines.join("\n")}\n`);
}

function ensureBgm(minDuration) {
  if (manifest.bgm) return manifest.bgm;
  const fallback = `${buildDir}/fallback-bgm.mp3`;
  run("ffmpeg", [
    "-y",
    "-f", "lavfi",
    "-i", `sine=frequency=82:duration=${Math.ceil(minDuration)}`,
    "-f", "lavfi",
    "-i", `anoisesrc=color=pink:duration=${Math.ceil(minDuration)}:amplitude=0.035`,
    "-filter_complex", "[0:a]volume=0.18[a0];[1:a]volume=0.18[a1];[a0][a1]amix=inputs=2:duration=longest[a]",
    "-map", "[a]",
    "-c:a", "libmp3lame",
    fallback,
  ], "fallback BGM");
  manifest.bgm = fallback;
  return fallback;
}

function characterArtForSpeaker(speaker) {
  return manifest.character_art?.[speaker] || null;
}

function renderX(art) {
  if (art.x !== undefined) return String(art.x);
  return art.side === "right" ? "W-w-34" : "34";
}

function renderY(art) {
  if (art.y !== undefined) return String(art.y);
  return "H-h-20";
}

function secondsExpr(value) {
  return Number(value).toFixed(3);
}

function buildVideoFilter(scene, cues, assPath) {
  const filters = [
    `[0:v]scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},format=rgba[v0]`,
  ];
  let base = "v0";
  let overlayCount = 0;
  const overlays = cues
    .map((cue) => ({ cue, art: characterArtForSpeaker(cue.speaker) }))
    .filter((item) => item.art?.file);
  const artInputs = new Map();
  for (const { art } of overlays) {
    if (!artInputs.has(art.file)) artInputs.set(art.file, 3 + artInputs.size);
  }

  for (const { cue, art } of overlays) {
    const inputIndex = artInputs.get(art.file);
    const heightPx = art.height || 620;
    const fadeDuration = Math.min(0.16, Math.max(0.04, (cue.end - cue.start) / 4));
    const outStart = Math.max(cue.start, cue.end - fadeDuration);
    const fg = `fg${overlayCount}`;
    const next = `v${overlayCount + 1}`;
    filters.push(
      `[${inputIndex}:v]scale=-1:${heightPx},format=rgba,` +
      `fade=t=in:st=${secondsExpr(cue.start)}:d=${secondsExpr(fadeDuration)}:alpha=1,` +
      `fade=t=out:st=${secondsExpr(outStart)}:d=${secondsExpr(fadeDuration)}:alpha=1[${fg}]`,
    );
    filters.push(
      `[${base}][${fg}]overlay=x=${renderX(art)}:y=${renderY(art)}:` +
      `enable='between(t,${secondsExpr(cue.start)},${secondsExpr(cue.end)})'[${next}]`,
    );
    base = next;
    overlayCount += 1;
  }

  filters.push(`[${base}]ass=${assPath},format=yuv420p[v]`);
  return {
    filter: filters.join(";"),
    artFiles: [...artInputs.keys()],
  };
}

const sceneVideos = [];
const timeline = [];
ensureSilence();

for (const scene of manifest.scenes) {
  const concatList = `${audioDir}/${scene.id}.txt`;
  const sceneAudio = `${audioDir}/${scene.id}.mp3`;
  const cues = [];
  const listLines = [];
  let cursor = 0;

  scene.clips.forEach((clip, index) => {
    listLines.push(`file '${resolve(clip.file)}'`);
    const duration = durationSeconds(clip.file);
    const start = cursor;
    const end = cursor + duration;
    cues.push({
      start,
      end,
      speaker: clip.speaker,
      text: `${clip.speaker}: ${clip.text}`,
    });
    timeline.push({ scene: scene.id, clip: index + 1, speaker: clip.speaker, file: clip.file, start, end });
    cursor = end;
    if (index < scene.clips.length - 1) {
      listLines.push(`file '${resolve(silencePath)}'`);
      cursor += 0.45;
    }
  });

  writeFileSync(concatList, `${listLines.join("\n")}\n`);
  run("ffmpeg", [
    "-y",
    "-f", "concat",
    "-safe", "0",
    "-i", concatList,
    "-c:a", "libmp3lame",
    "-q:a", "2",
    sceneAudio,
  ], `concat audio ${scene.id}`);

  const sceneDuration = durationSeconds(sceneAudio);
  const assPath = `${subtitleDir}/${scene.id}.ass`;
  writeAss(assPath, cues);
  const sceneVideo = `${videoDir}/${scene.id}.mp4`;
  const bgmPath = ensureBgm(sceneDuration);
  const videoFilter = buildVideoFilter(scene, cues, assPath);
  const inputArgs = [
    "-y",
    "-loop", "1",
    "-i", scene.image,
    "-i", sceneAudio,
    "-stream_loop", "-1",
    "-i", bgmPath,
  ];
  for (const file of videoFilter.artFiles) {
    inputArgs.push("-loop", "1", "-i", file);
  }

  run("ffmpeg", [
    ...inputArgs,
    "-filter_complex", `[1:a]volume=${manifest.voice_volume ?? 1.15}[voice];[2:a]volume=${manifest.bgm_volume ?? 0.32}[music];[voice][music]amix=inputs=2:duration=first:normalize=0:dropout_transition=2,alimiter=limit=0.95[a];${videoFilter.filter}`,
    "-map", "[v]",
    "-map", "[a]",
    "-t", String(sceneDuration),
    ...videoCodecArgs,
    "-c:a", "aac",
    "-b:a", "160k",
    "-movflags", "+faststart",
    sceneVideo,
  ], `render scene ${scene.id}`);

  sceneVideos.push(sceneVideo);
}

const videoList = `${buildDir}/video-list.txt`;
writeFileSync(videoList, `${sceneVideos.map((file) => `file '${resolve(file)}'`).join("\n")}\n`);
run("ffmpeg", [
  "-y",
  "-f", "concat",
  "-safe", "0",
  "-i", videoList,
  "-c", "copy",
  manifest.output,
], "concat final video");

writeFileSync(`${buildDir}/timeline.json`, `${JSON.stringify(timeline, null, 2)}\n`);
console.log(`video written: ${manifest.output}`);
