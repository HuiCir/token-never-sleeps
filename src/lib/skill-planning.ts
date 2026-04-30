import { parseSections } from "../core/sections.js";
import type { FsmProgramSettings, TnsConfig } from "../types.js";

export function extractSkillImports(text: string): string[] {
  const imports: string[] = [];
  for (const line of text.split("\n")) {
    const match = line.trim().match(/^import\s+([A-Za-z0-9_.-]+)(?:\s+as\s+[A-Za-z0-9_.-]+)?\s*$/);
    if (match) {
      imports.push(match[1]);
    }
  }
  return Array.from(new Set(imports));
}

export function sectionSkillImports(config: TnsConfig): Map<string, string[]> {
  const imports = new Map<string, string[]>();
  for (const section of parseSections(config.product_doc)) {
    const skills = extractSkillImports(`${section.title}\n${section.body}`);
    if (skills.length > 0) {
      imports.set(section.id, skills);
    }
  }
  return imports;
}

export function programNeedsSkillMaterialization(config: TnsConfig): boolean {
  return Boolean(config.program) ||
    Math.max(1, Number(config.threads ?? config.thread ?? 1)) > 1 ||
    sectionSkillImports(config).size > 0;
}

export function enrichProgramWithSectionImports(program: FsmProgramSettings, config: TnsConfig): FsmProgramSettings {
  const imports = sectionSkillImports(config);
  if (imports.size === 0) {
    return program;
  }
  return {
    ...program,
    states: program.states.map((state) => {
      const skills = imports.get(state.id) ?? [];
      if (skills.length === 0) {
        return state;
      }
      return {
        ...state,
        parallel: {
          ...(state.parallel ?? {}),
          skills: Array.from(new Set([...(state.parallel?.skills ?? []), ...skills])),
        },
      };
    }),
  };
}
