---
name: tns-task-planner
description: Convert a natural-language request or rough TNS task draft into a concrete task.md with high-quality tracked sections. Use before compile/run when task.md is vague, underspecified, missing acceptance criteria, or not split into executable sections.
---

# TNS Task Planner

Use this skill when the task is to improve the planning quality of `task.md`, not to implement the product work.

## Goal

Produce a runnable TNS `task.md` from only the source text provided by the harness.

The output must help the runner execute clear, bounded, reviewable sections without relying on later prompt inference.

## Output Shape

Return a complete markdown document in `planned_task_markdown`.

The markdown must:
- start with `# Task`
- use only `##` headings for tracked sections
- not use `###` headings
- use 3 to 10 sections unless the source is genuinely smaller
- keep each section independently executable and verifiable
- split multiple independent deliverables into separate sections so the runner can schedule them concurrently
- include these exact labels in every section:
  - `Objective:`
  - `Inputs:`
  - `Deliverables:`
  - `Acceptance criteria:`
  - `Verification:`

Use `Depends on:` when ordering matters.

## Skill Recommendations

Planner may suggest skills, but recommendations are not executable imports.

Rules:
- Do not emit `import <skill>`.
- Do not emit `import skill:`.
- If a skill would be useful, write `Recommended skills: <name>` inside the section body.
- Only recommend skills when the source text explicitly mentions a domain, file type, agent, or tool that justifies the recommendation.
- Never invent a required skill.

Executor/verifier injection is decided later by compile/run, not by planner recommendations.

## Path Rules

- Prefer relative paths.
- Do not copy the workspace root path from the prompt into `task.md`.
- Use absolute paths only when the source text explicitly included that exact path.
- Put concrete file paths or artifact names in backticks when known, so TNS can infer dependencies.

## Quality Rules

Avoid:
- catch-all sections such as "fix everything"
- pure research sections with no deliverable
- vague verbs without outputs, such as "improve", "optimize", or "handle"
- hidden assumptions presented as facts
- phase headings that are not executable work

When the source is vague, create a discovery/audit section first and list uncertainty in `warnings`.

## Completion Standard

The plan is acceptable only when:
- TNS will parse the number of `##` sections intended by the planner
- every section has clear deliverables
- independent deliverables are not bundled into one tracked section
- every section has acceptance criteria and verification
- dependencies are explicit where needed
- recommendations are clearly non-binding
- the plan does not require reading old `.tns` state or prior compiled programs
