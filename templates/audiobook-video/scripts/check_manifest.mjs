#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";

const requireAssets = process.argv.includes("--assets");
const manifestPath = "src/production_manifest.json";
const failures = [];

if (!existsSync(manifestPath)) {
  failures.push(`missing ${manifestPath}`);
} else {
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (error) {
    failures.push(`invalid JSON in ${manifestPath}: ${error.message}`);
  }

  if (manifest) {
    if (!manifest.title) failures.push("manifest.title is required");
    if (!manifest.output) failures.push("manifest.output is required");
    if (!manifest.bgm) failures.push("manifest.bgm is required");
    if (!manifest.resolution || manifest.resolution.width !== 1280 || manifest.resolution.height !== 720) {
      failures.push("manifest.resolution must be 1280x720");
    }
    if (!Array.isArray(manifest.scenes) || manifest.scenes.length < 3 || manifest.scenes.length > 4) {
      failures.push("manifest.scenes must contain 3 or 4 scenes");
    }

    const speakers = new Set();
    const voices = new Set();
    const clipFiles = [];
    const characterArtFiles = [];

    if (manifest.character_art !== undefined && typeof manifest.character_art !== "object") {
      failures.push("manifest.character_art must be an object when provided");
    }

    for (const [speaker, art] of Object.entries(manifest.character_art || {})) {
      if (!art || typeof art !== "object") {
        failures.push(`character_art.${speaker} must be an object`);
        continue;
      }
      if (!art.file) failures.push(`character_art.${speaker} missing file`);
      if (art.file) characterArtFiles.push(art.file);
      if (art.side && !["left", "right"].includes(art.side)) {
        failures.push(`character_art.${speaker}.side must be left or right`);
      }
    }

    for (const scene of manifest.scenes || []) {
      if (!scene.id) failures.push("scene missing id");
      if (!scene.image) failures.push(`${scene.id || "scene"} missing image`);
      if (!scene.visual_prompt || scene.visual_prompt.length < 80) failures.push(`${scene.id || "scene"} visual_prompt is too thin`);
      if (!Array.isArray(scene.clips) || scene.clips.length === 0) failures.push(`${scene.id || "scene"} has no clips`);
      if (requireAssets && scene.image && !existsSync(scene.image)) failures.push(`missing image ${scene.image}`);
      for (const clip of scene.clips || []) {
        if (!clip.speaker) failures.push(`${scene.id || "scene"} clip missing speaker`);
        if (!clip.voice) failures.push(`${scene.id || "scene"} clip missing voice`);
        if (!clip.file) failures.push(`${scene.id || "scene"} clip missing file`);
        if (!clip.text || clip.text.length < 20) failures.push(`${scene.id || "scene"} clip text is too short`);
        if (/[\u3400-\u9fff]/.test(clip.text || "")) failures.push(`${scene.id || "scene"} clip contains non-English CJK text`);
        if (clip.speaker) speakers.add(clip.speaker);
        if (clip.voice) voices.add(clip.voice);
        if (clip.file) clipFiles.push(clip.file);
      }
    }

    if (speakers.size < 3) failures.push("at least 3 speakers are required");
    if (voices.size < 3) failures.push("at least 3 voice IDs are required");
    if (requireAssets && manifest.bgm && !existsSync(manifest.bgm)) failures.push(`missing BGM ${manifest.bgm}`);
    if (requireAssets) {
      for (const file of characterArtFiles) {
        if (!existsSync(file)) failures.push(`missing character art ${file}`);
      }
      for (const file of clipFiles) {
        if (!existsSync(file)) failures.push(`missing voice clip ${file}`);
      }
    }
  }
}

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}

console.log(`manifest check passed${requireAssets ? " with assets" : ""}`);
