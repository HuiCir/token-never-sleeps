# Declaring External Dependencies

Use `config.externals` to declare runtime dependencies that are not encoded purely by local files.

Shape:

```json
{
  "externals": {
    "tools": [
      { "name": "ffmpeg", "required": true, "purpose": "deterministic audio/video render" }
    ],
    "skills": [
      { "name": "tns-program-compiler", "required": true, "purpose": "compile task into deterministic runtime contract" }
    ],
    "mcp": [
      { "server": "openaiDeveloperDocs", "required": false, "purpose": "official API docs lookup" }
    ]
  }
}
```

Rules:

1. Declare a tool when the workflow depends on a concrete executable.
2. Declare a skill when the workspace assumes a reusable instruction pack.
3. Declare MCP when the workflow depends on a server/resource outside the workspace.
4. Do not hide dependencies in prose only.
5. Keep `purpose` short and operational.

The runner does not automatically install these dependencies. The point is to make them explicit and machine-readable.
