# Plan Import

将 Plan mode 生成的计划文件转换为 TNS task sections 并初始化 TNS 状态。

## Usage

```
/plan-import <plan_file> [--merge]
```

## Arguments

- `plan_file`: Plan mode 输出文件的路径
- `--merge`: 可选，合并现有 sections（保留 done/blocked 状态）

## 示例

```
/plan-import implementation_plan.md
/plan-import my_plan.md --merge
```

## 说明

1. 读取 Plan mode 输出文件
2. 解析其中的 ## / ### 标题作为 section 边界
3. 支持识别的标题格式：
   - `## Section N` / `### Section N`
   - `## Step N` / `### Step N`
   - `## Phase N` / `### Phase N`
   - `## Task N` / `### Task N`
   - `## Context` / `## Plan` / `## Verification`
4. 生成 `sections.json` 并写入 `.tns/` 目录

## 等效命令

```bash
python3 scripts/tns_runner.py plan-import --config tns_config.json --plan-file plan.md
```
