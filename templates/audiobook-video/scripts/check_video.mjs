#!/usr/bin/env node
import { existsSync, readFileSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";

const manifest = JSON.parse(readFileSync("src/production_manifest.json", "utf8"));
const output = manifest.output;
const failures = [];

if (!existsSync(output)) {
  failures.push(`missing output ${output}`);
} else {
  const size = statSync(output).size;
  if (size < 500_000) failures.push(`output file is too small: ${size}`);

  const probe = spawnSync("ffprobe", [
    "-v", "error",
    "-print_format", "json",
    "-show_format",
    "-show_streams",
    output,
  ], { encoding: "utf8" });
  if (probe.status !== 0) {
    failures.push(`ffprobe failed: ${probe.stderr || probe.stdout}`);
  } else {
    const data = JSON.parse(probe.stdout);
    const duration = Number.parseFloat(data.format?.duration || "0");
    const video = (data.streams || []).find((stream) => stream.codec_type === "video");
    const audio = (data.streams || []).find((stream) => stream.codec_type === "audio");
    if (!Number.isFinite(duration) || duration < 90 || duration > 240) {
      failures.push(`duration must be 90-240 seconds, got ${duration}`);
    }
    if (!video) failures.push("missing video stream");
    if (!audio) failures.push("missing audio stream");
    if (video && (video.width !== 1280 || video.height !== 720)) {
      failures.push(`expected 1280x720, got ${video.width}x${video.height}`);
    }
  }
}

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}

console.log(`video check passed: ${output}`);

