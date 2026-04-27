#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";

const required = [
  "story_bible/world.md",
  "story_bible/characters.md",
  "story_bible/entities.md",
  "story_bible/timeline.md",
  "story_bible/chapter_summaries.md",
];

const failures = [];

for (const file of required) {
  if (!existsSync(file)) {
    failures.push(`missing ${file}`);
    continue;
  }
  const text = readFileSync(file, "utf8").trim();
  if (text.length < 80) failures.push(`${file} is too thin`);
}

const chapterFiles = Array.from({ length: 5 }, (_, i) => `draft/chapters/chapter-${String(i + 1).padStart(2, "0")}.md`);
const existingChapters = chapterFiles.filter((file) => existsSync(file));
if (existingChapters.length === 0) failures.push("no chapter files found");

for (const file of existingChapters) {
  const text = readFileSync(file, "utf8").trim();
  if (!text.startsWith("# ")) failures.push(`${file} must start with a markdown H1 title`);
  if (text.length < 900) failures.push(`${file} is shorter than 900 characters`);
}

const summaries = existsSync("story_bible/chapter_summaries.md")
  ? readFileSync("story_bible/chapter_summaries.md", "utf8")
  : "";
for (const file of existingChapters) {
  const chapterNumber = file.match(/chapter-(\d+)/)?.[1];
  if (chapterNumber && !summaries.includes(`Chapter ${chapterNumber}`)) {
    failures.push(`missing Chapter ${chapterNumber} summary`);
  }
}

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}

console.log(`novel check passed: ${existingChapters.length} chapter file(s), ${required.length} story bible file(s)`);
