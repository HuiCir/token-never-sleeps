#!/usr/bin/env python3
import argparse
import json
import os
import re
import shutil
import smtplib
import subprocess
import sys
import time
import uuid
from datetime import datetime, timedelta, timezone
from email.message import EmailMessage
from pathlib import Path
from typing import Any, Dict, List, Optional


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def read_json(path: Path, default: Any = None) -> Any:
    if not path.exists():
        return default
    return json.loads(path.read_text(encoding="utf-8"))


def write_json(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


def append_jsonl(path: Path, payload: Dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as fh:
        fh.write(json.dumps(payload, ensure_ascii=False) + "\n")


def append_text(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as fh:
        fh.write(text)


def require_claude() -> str:
    claude = shutil.which("claude")
    if not claude:
        raise SystemExit("claude CLI not found in PATH")
    return claude


def require_tmux() -> str:
    tmux = shutil.which("tmux")
    if not tmux:
        raise RuntimeError("tmux not found in PATH")
    return tmux


def git_run(workspace: Path, args: List[str], check: bool = True) -> subprocess.CompletedProcess:
    proc = subprocess.run(["git", *args], cwd=str(workspace), capture_output=True, text=True)
    if check and proc.returncode != 0:
        raise RuntimeError(proc.stderr.strip() or proc.stdout.strip() or f"git {' '.join(args)} failed")
    return proc


def is_git_repo(workspace: Path) -> bool:
    proc = subprocess.run(
        ["git", "rev-parse", "--is-inside-work-tree"],
        cwd=str(workspace),
        capture_output=True,
        text=True,
    )
    return proc.returncode == 0 and proc.stdout.strip() == "true"


def git_head(workspace: Path) -> str:
    return git_run(workspace, ["rev-parse", "HEAD"]).stdout.strip()


def git_current_branch(workspace: Path) -> str:
    return git_run(workspace, ["branch", "--show-current"]).stdout.strip()


def git_has_changes(workspace: Path) -> bool:
    return bool(git_run(workspace, ["status", "--porcelain"], check=False).stdout.strip())


def git_commit_all(workspace: Path, message: str) -> Optional[str]:
    if not git_has_changes(workspace):
        return None
    git_run(workspace, ["add", "-A"])
    git_run(workspace, ["commit", "-m", message])
    return git_head(workspace)


def load_config(path: Path) -> Dict[str, Any]:
    config = read_json(path)
    if not isinstance(config, dict):
        raise SystemExit(f"invalid config: {path}")
    required = ["workspace"]
    missing = [key for key in required if not config.get(key)]
    if missing:
        raise SystemExit(f"config missing required keys: {', '.join(missing)}")
    if not config.get("product_doc"):
        workspace = Path(config["workspace"]).expanduser().resolve()
        config["product_doc"] = str(workspace / "task.md")
    return config


def git_settings(config: Dict[str, Any]) -> Dict[str, Any]:
    cfg = config.get("git", {})
    return {
        "enabled": bool(cfg.get("enabled", True)),
        "default_branch": str(cfg.get("default_branch", "master")),
        "record_all_branches": bool(cfg.get("record_all_branches", False)),
        "rollback_on_quota_exhaustion": bool(cfg.get("rollback_on_quota_exhaustion", True)),
        "auto_init": bool(cfg.get("auto_init", True)),
    }


def notification_settings(config: Dict[str, Any]) -> Dict[str, Any]:
    cfg = config.get("notifications", {}).get("email", {})
    return {
        "enabled": bool(cfg.get("enabled", False)),
        "method": str(cfg.get("method", "local_mail")),
        "to": list(cfg.get("to", [])),
        "from": str(cfg.get("from", "tns@localhost")),
        "subject_prefix": str(cfg.get("subject_prefix", "[TNS]")),
        "smtp": cfg.get("smtp", {}),
    }


def tmux_settings(config: Dict[str, Any]) -> Dict[str, Any]:
    cfg = config.get("tmux", {})
    return {
        "enabled": bool(cfg.get("enabled", False)),
        "auto_create": bool(cfg.get("auto_create", True)),
        "session_name": str(cfg.get("session_name", "")),
        "window_name": str(cfg.get("window_name", "tns")),
        "socket_name": str(cfg.get("socket_name", "")),
    }


def send_email_notification(config: Dict[str, Any], subject: str, body: str) -> None:
    settings = notification_settings(config)
    if not settings["enabled"] or not settings["to"]:
        return

    prefix = settings["subject_prefix"].strip()
    full_subject = f"{prefix} {subject}".strip()
    method = settings["method"]

    if method == "local_mail":
        for recipient in settings["to"]:
            proc = subprocess.run(
                ["mail", "-s", full_subject, "-r", settings["from"], recipient],
                input=body,
                text=True,
                capture_output=True,
            )
            if proc.returncode != 0:
                raise RuntimeError(proc.stderr.strip() or proc.stdout.strip() or f"mail delivery failed for {recipient}")
        return

    if method == "smtp":
        smtp_cfg = settings["smtp"]
        host = smtp_cfg.get("host")
        port = int(smtp_cfg.get("port", 587))
        username = smtp_cfg.get("username")
        password = smtp_cfg.get("password")
        starttls = bool(smtp_cfg.get("starttls", True))
        ssl_enabled = bool(smtp_cfg.get("ssl", False))
        if not host:
            raise RuntimeError("smtp host is required")

        msg = EmailMessage()
        msg["From"] = settings["from"]
        msg["To"] = ", ".join(settings["to"])
        msg["Subject"] = full_subject
        msg.set_content(body)

        if ssl_enabled:
            with smtplib.SMTP_SSL(host, port, timeout=30) as server:
                if username:
                    server.login(username, password or "")
                server.send_message(msg)
        else:
            with smtplib.SMTP(host, port, timeout=30) as server:
                if starttls:
                    server.starttls()
                if username:
                    server.login(username, password or "")
                server.send_message(msg)
        return

    raise RuntimeError(f"unsupported email method: {method}")


def try_send_email_notification(paths: Dict[str, Path], config: Dict[str, Any], subject: str, body: str, phase: str) -> None:
    settings = notification_settings(config)
    if not settings["enabled"]:
        return
    try:
        send_email_notification(config, subject, body)
        append_jsonl(paths["activity"], {"event": "email_sent", "at": iso(utc_now()), "phase": phase, "subject": subject, "to": settings["to"]})
    except Exception as exc:
        append_jsonl(paths["activity"], {"event": "email_error", "at": iso(utc_now()), "phase": phase, "subject": subject, "error": str(exc), "to": settings["to"]})


def notify_loop_start(paths: Dict[str, Path], config: Dict[str, Any], manifest: Dict[str, Any], section: Dict[str, Any], quota: Dict[str, Any]) -> None:
    settings = notification_settings(config)
    if not settings["enabled"]:
        return
    body = (
        f"Token Never Sleeps task activation\n\n"
        f"Tracked document: {manifest['product_doc']}\n"
        f"Section ID: {section['id']}\n"
        f"Section title: {section['title']}\n"
        f"Section anchor: {section['anchor']}\n\n"
        f"Task requirements:\n{section.get('body', '').strip() or '(empty)'}\n\n"
        f"Quota snapshot:\n{json.dumps(quota, ensure_ascii=False, indent=2)}\n"
    )
    try_send_email_notification(paths, config, f"Task Start {section['id']}", body, "start")


def notify_loop_end(
    paths: Dict[str, Path],
    config: Dict[str, Any],
    section: Dict[str, Any],
    execution: Dict[str, Any],
    verification: Optional[Dict[str, Any]],
    post_quota: Dict[str, Any],
    artifacts: List[Dict[str, Any]],
) -> None:
    settings = notification_settings(config)
    if not settings["enabled"]:
        return
    body = (
        f"Token Never Sleeps task summary\n\n"
        f"Section ID: {section['id']}\n"
        f"Section title: {section['title']}\n\n"
        f"Execution summary:\n{execution.get('summary', '')}\n\n"
        f"Verification summary:\n{(verification or {}).get('summary', '(not verified)')}\n"
        f"Verification status: {(verification or {}).get('status', 'n/a')}\n\n"
        f"Artifacts:\n"
        + "\n".join(f"- {item['path']} (verified={item['verified']})" for item in artifacts)
        + "\n\n"
        f"Quota after loop:\n{json.dumps(post_quota, ensure_ascii=False, indent=2)}\n"
    )
    try_send_email_notification(paths, config, f"Task Complete {section['id']}", body, "end")


def state_paths(config: Dict[str, Any]) -> Dict[str, Path]:
    workspace = Path(config["workspace"]).expanduser().resolve()
    state_dir = workspace / ".tns"
    return {
        "workspace": workspace,
        "state_dir": state_dir,
        "manifest": state_dir / "manifest.json",
        "sections": state_dir / "sections.json",
        "handoff": state_dir / "handoff.md",
        "reviews": state_dir / "reviews.json",
        "freeze": state_dir / "freeze.json",
        "activity": state_dir / "activity.jsonl",
        "artifacts": state_dir / "artifacts.json",
        "tmux": state_dir / "tmux.json",
    }


def iso(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).isoformat()


def slugify(value: str) -> str:
    slug = re.sub(r"[^a-zA-Z0-9]+", "-", value).strip("-").lower()
    return slug or "tns"


def parse_sections(product_doc: Path) -> List[Dict[str, Any]]:
    text = product_doc.read_text(encoding="utf-8")
    lines = text.splitlines()
    sections: List[Dict[str, Any]] = []
    current = None
    for line in lines:
        match = re.match(r"^(##|###)\s+(.+?)\s*$", line)
        if match:
            if current:
                sections.append(current)
            current = {
                "id": f"sec-{len(sections)+1:03d}",
                "title": match.group(2).strip(),
                "anchor": line.strip(),
                "status": "pending",
                "attempts": 0,
                "verified_at": None,
                "last_summary": "",
                "last_review": "",
            }
            continue
        if current is not None:
            body = current.setdefault("body", [])
            body.append(line)
    if current:
        sections.append(current)
    if not sections:
        sections.append(
            {
                "id": "sec-001",
                "title": product_doc.name,
                "anchor": product_doc.name,
                "body": lines,
                "status": "pending",
                "attempts": 0,
                "verified_at": None,
                "last_summary": "",
                "last_review": "",
            }
        )
    for section in sections:
        section["body"] = "\n".join(section.get("body", [])).strip()
    return sections


def init_state(config: Dict[str, Any]) -> None:
    paths = state_paths(config)
    product_doc = Path(config["product_doc"]).expanduser().resolve()
    if not product_doc.exists():
        raise SystemExit(f"product doc not found: {product_doc}")
    sections = parse_sections(product_doc)
    started_at = utc_now()
    manifest = {
        "workspace": str(paths["workspace"]),
        "product_doc": str(product_doc),
        "started_at": iso(started_at),
        "refresh_anchor_at": iso(started_at),
        "refresh_hours": int(config.get("refresh_hours", 5)),
        "refresh_minutes": config.get("refresh_minutes"),
        "refresh_seconds": config.get("refresh_seconds"),
        "plugin_root": str(Path(__file__).resolve().parents[1]),
    }
    write_json(paths["manifest"], manifest)
    write_json(paths["sections"], sections)
    write_json(paths["reviews"], [])
    write_json(paths["artifacts"], [])
    if not paths["handoff"].exists():
        paths["handoff"].write_text(
            "# TNS Handoff\n\nThis file is appended by the harness after each executor/verifier cycle.\n",
            encoding="utf-8",
        )
    ensure_git_ready(config, paths)
    ensure_tmux_ready(config, paths)
    append_jsonl(paths["activity"], {"event": "init", "at": iso(started_at), "sections": len(sections)})


def load_manifest(paths: Dict[str, Path]) -> Dict[str, Any]:
    manifest = read_json(paths["manifest"])
    if not isinstance(manifest, dict):
        raise SystemExit("TNS is not initialized. Run init first.")
    return manifest


def ensure_initialized(config: Dict[str, Any]) -> Dict[str, Path]:
    paths = state_paths(config)
    if not paths["manifest"].exists():
        init_state(config)
    return paths


def refresh_window_seconds(manifest: Dict[str, Any]) -> int:
    if manifest.get("refresh_seconds") is not None:
        return int(manifest["refresh_seconds"])
    if manifest.get("refresh_minutes") is not None:
        return int(manifest["refresh_minutes"]) * 60
    return int(manifest.get("refresh_hours", 5)) * 3600


def current_window(manifest: Dict[str, Any]) -> Dict[str, Any]:
    anchor = datetime.fromisoformat(manifest["refresh_anchor_at"])
    window_seconds = refresh_window_seconds(manifest)
    delta = utc_now() - anchor
    index = max(0, int(delta.total_seconds() // window_seconds))
    start = anchor + timedelta(seconds=window_seconds * index)
    end = start + timedelta(seconds=window_seconds)
    return {"index": index, "start": start, "end": end}


def ensure_git_ready(config: Dict[str, Any], paths: Dict[str, Path]) -> None:
    settings = git_settings(config)
    if not settings["enabled"]:
        return
    workspace = paths["workspace"]
    if not is_git_repo(workspace):
        if not settings["auto_init"]:
            raise RuntimeError("git is enabled but workspace is not a git repo")
        git_run(workspace, ["init"])
    git_run(workspace, ["config", "user.name", "TNS Bot"], check=False)
    git_run(workspace, ["config", "user.email", "tns@example.local"], check=False)
    default_branch = settings["default_branch"]
    current_branch = git_current_branch(workspace)
    if not current_branch:
        git_run(workspace, ["checkout", "-B", default_branch])
    elif current_branch != default_branch and not settings["record_all_branches"]:
        git_run(workspace, ["checkout", default_branch])
    if not git_run(workspace, ["rev-parse", "--verify", "HEAD"], check=False).stdout.strip():
        git_commit_all(workspace, "tns: initial workspace snapshot")


def tmux_cmd(config: Dict[str, Any]) -> List[str]:
    cmd = [require_tmux()]
    socket_name = tmux_settings(config)["socket_name"]
    if socket_name:
        cmd.extend(["-L", socket_name])
    return cmd


def tmux_session_name(config: Dict[str, Any], paths: Dict[str, Path]) -> str:
    settings = tmux_settings(config)
    if settings["session_name"]:
        return settings["session_name"]
    workspace_name = slugify(paths["workspace"].name)
    return f"tns-{workspace_name}"


def tmux_has_session(config: Dict[str, Any], session_name: str, workspace: Path) -> bool:
    proc = subprocess.run(
        [*tmux_cmd(config), "has-session", "-t", session_name],
        cwd=str(workspace),
        capture_output=True,
        text=True,
    )
    return proc.returncode == 0


def ensure_tmux_ready(config: Dict[str, Any], paths: Dict[str, Path]) -> None:
    settings = tmux_settings(config)
    if not settings["enabled"]:
        return
    session_name = tmux_session_name(config, paths)
    window_name = settings["window_name"]
    if not tmux_has_session(config, session_name, paths["workspace"]):
        if not settings["auto_create"]:
            raise RuntimeError(f"tmux session does not exist: {session_name}")
        subprocess.run(
            [*tmux_cmd(config), "new-session", "-d", "-s", session_name, "-n", window_name, "-c", str(paths["workspace"])],
            check=True,
            cwd=str(paths["workspace"]),
            capture_output=True,
            text=True,
        )
        append_jsonl(paths["activity"], {"event": "tmux_session_created", "at": iso(utc_now()), "session": session_name})
    payload = {
        "enabled": True,
        "session_name": session_name,
        "window_name": window_name,
        "socket_name": settings["socket_name"] or None,
        "workspace": str(paths["workspace"]),
        "updated_at": iso(utc_now()),
    }
    write_json(paths["tmux"], payload)


def tmux_status(config: Dict[str, Any], paths: Dict[str, Path]) -> Dict[str, Any]:
    settings = tmux_settings(config)
    if not settings["enabled"]:
        return {"enabled": False}
    ensure_tmux_ready(config, paths)
    session_name = tmux_session_name(config, paths)
    proc = subprocess.run(
        [*tmux_cmd(config), "list-windows", "-t", session_name, "-F", "#{window_index}:#{window_name}:#{window_active}"],
        cwd=str(paths["workspace"]),
        capture_output=True,
        text=True,
        check=True,
    )
    windows = [line.strip() for line in proc.stdout.splitlines() if line.strip()]
    payload = read_json(paths["tmux"], {})
    payload["windows"] = windows
    payload["exists"] = True
    return payload


def begin_loop_git_context(config: Dict[str, Any], paths: Dict[str, Path], section: Dict[str, Any]) -> Dict[str, Any]:
    settings = git_settings(config)
    context = {"enabled": settings["enabled"]}
    if not settings["enabled"]:
        return context

    ensure_git_ready(config, paths)
    workspace = paths["workspace"]
    default_branch = settings["default_branch"]
    git_run(workspace, ["checkout", default_branch])

    if settings["record_all_branches"]:
        loop_branch = f"tns/{section['id']}-{utc_now().strftime('%Y%m%d%H%M%S')}-{uuid.uuid4().hex[:6]}"
        git_run(workspace, ["checkout", "-b", loop_branch])
        checkpoint = git_head(workspace)
    else:
        loop_branch = default_branch
        checkpoint = git_head(workspace)

    pre_loop_commit = git_commit_all(workspace, f"tns: pre-loop snapshot for {section['id']}")
    if pre_loop_commit:
        checkpoint = pre_loop_commit

    ctx = {
        "enabled": True,
        "default_branch": default_branch,
        "loop_branch": loop_branch,
        "checkpoint": checkpoint,
        "record_all_branches": settings["record_all_branches"],
        "rollback_on_quota_exhaustion": settings["rollback_on_quota_exhaustion"],
    }
    append_jsonl(paths["activity"], {"event": "git_loop_begin", "at": iso(utc_now()), "section": section["id"], "git": ctx})
    return ctx


def finalize_loop_git_context(
    config: Dict[str, Any],
    paths: Dict[str, Path],
    section: Dict[str, Any],
    context: Dict[str, Any],
    exhausted: bool,
    commit_message: str,
) -> None:
    if not context.get("enabled"):
        return

    workspace = paths["workspace"]
    default_branch = context["default_branch"]
    loop_branch = context["loop_branch"]
    record_all = context["record_all_branches"]
    checkpoint = context["checkpoint"]
    rollback_enabled = context["rollback_on_quota_exhaustion"]

    if exhausted and rollback_enabled:
        if record_all:
            git_commit_all(workspace, f"tns: exhausted loop record for {section['id']}")
            git_run(workspace, ["checkout", default_branch])
        else:
            git_run(workspace, ["reset", "--hard", checkpoint])
            git_run(workspace, ["clean", "-fd"])
        append_jsonl(
            paths["activity"],
            {"event": "git_loop_rollback", "at": iso(utc_now()), "section": section["id"], "loop_branch": loop_branch},
        )
        return

    actual_commit = git_commit_all(workspace, commit_message)
    if record_all:
        git_run(workspace, ["checkout", default_branch])
        git_run(workspace, ["merge", "--no-ff", loop_branch, "-m", f"tns: merge {loop_branch}"])
    append_jsonl(
        paths["activity"],
        {
            "event": "git_loop_commit",
            "at": iso(utc_now()),
            "section": section["id"],
            "loop_branch": loop_branch,
            "commit": actual_commit or git_head(workspace),
        },
    )


def iter_activity(path: Path) -> List[Dict[str, Any]]:
    if not path.exists():
        return []
    events: List[Dict[str, Any]] = []
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            events.append(json.loads(line))
        except json.JSONDecodeError:
            continue
    return events


def event_at(event: Dict[str, Any]) -> Optional[datetime]:
    value = event.get("at")
    if not value:
        return None
    try:
        return datetime.fromisoformat(value)
    except ValueError:
        return None


def usage_total_tokens(usage: Dict[str, Any]) -> int:
    if not usage:
        return 0
    total = 0
    for key in (
        "input_tokens",
        "output_tokens",
        "cache_read_input_tokens",
        "cache_creation_input_tokens",
    ):
        total += int(usage.get(key, 0) or 0)
    return total


def window_usage(paths: Dict[str, Path], manifest: Dict[str, Any]) -> Dict[str, Any]:
    window = current_window(manifest)
    total = 0
    by_agent = {"executor": 0, "verifier": 0}
    for event in iter_activity(paths["activity"]):
        at = event_at(event)
        if at is None or not (window["start"] <= at < window["end"]):
            continue
        if event.get("event") in {"executor_end", "verifier_end"}:
            usage = event.get("usage") or {}
            tokens = usage_total_tokens(usage)
            total += tokens
            if event["event"] == "executor_end":
                by_agent["executor"] += tokens
            else:
                by_agent["verifier"] += tokens
    return {
        "window_index": window["index"],
        "window_start": iso(window["start"]),
        "window_end": iso(window["end"]),
        "used_tokens": total,
        "by_agent": by_agent,
    }


def maybe_unfreeze(paths: Dict[str, Path], manifest: Dict[str, Any]) -> None:
    freeze = read_json(paths["freeze"])
    if not freeze:
        return
    window = current_window(manifest)
    until = freeze.get("until")
    if until and utc_now() >= datetime.fromisoformat(until):
        paths["freeze"].unlink(missing_ok=True)
        append_jsonl(paths["activity"], {"event": "auto_unfreeze", "at": iso(utc_now()), "window": window["index"]})


def select_section(sections: List[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    for status in ["needs_fix", "pending", "blocked"]:
        for section in sections:
            if section["status"] == status:
                return section
    return None


def recover_in_progress_sections(paths: Dict[str, Path]) -> None:
    sections = read_json(paths["sections"], [])
    changed = False
    for section in sections:
        if section.get("status") == "in_progress":
            section["status"] = "needs_fix"
            note = section.get("last_review", "")
            prefix = "Recovered after interrupted run."
            section["last_review"] = f"{prefix} {note}".strip()
            changed = True
    if changed:
        write_json(paths["sections"], sections)
        append_jsonl(paths["activity"], {"event": "recover_in_progress", "at": iso(utc_now())})


def run_quota_command(command: str, cwd: Path) -> Dict[str, Any]:
    proc = subprocess.run(command, shell=True, cwd=str(cwd), capture_output=True, text=True)
    if proc.returncode != 0:
        return {"ok": False, "reason": proc.stderr.strip() or proc.stdout.strip() or "quota command failed"}
    try:
        return json.loads(proc.stdout)
    except json.JSONDecodeError as exc:
        return {"ok": False, "reason": f"invalid quota JSON: {exc}"}


def evaluate_quota(config: Dict[str, Any], paths: Dict[str, Path]) -> Dict[str, Any]:
    quota_cfg = config.get("quota", {})
    provider = quota_cfg.get("provider", "none")
    if provider == "none":
        return {"ok": False, "reason": "quota provider disabled"}
    if provider == "rolling_usage":
        manifest = load_manifest(paths)
        stats = window_usage(paths, manifest)
        budget = int(quota_cfg.get("window_token_budget", 0) or 0)
        if budget <= 0:
            return {"ok": False, "reason": "quota.window_token_budget must be > 0 for rolling_usage"}
        remaining = budget - int(stats["used_tokens"])
        return {
            "ok": True,
            "provider": "rolling_usage",
            "remaining": remaining,
            "used": stats["used_tokens"],
            "budget": budget,
            "unit": "tokens",
            "window_index": stats["window_index"],
            "window_start": stats["window_start"],
            "window_end": stats["window_end"],
            "by_agent": stats["by_agent"],
            "observed_at": iso(utc_now()),
        }
    if provider != "command":
        return {"ok": False, "reason": f"unsupported quota provider: {provider}"}
    command = quota_cfg.get("command")
    if not command:
        return {"ok": False, "reason": "quota.command is missing"}
    result = run_quota_command(command, paths["workspace"])
    result.setdefault("ok", False)
    return result


def quota_policy(config: Dict[str, Any]) -> Dict[str, Any]:
    quota_cfg = config.get("quota", {})
    return {
        "enforce_freeze": bool(quota_cfg.get("enforce_freeze", False)),
        "freeze_on_unknown": bool(quota_cfg.get("freeze_on_unknown", False)),
    }


def looks_like_usage_limit_error(message: str) -> bool:
    text = (message or "").lower()
    patterns = [
        "usage limit",
        "rate limit",
        "limit reached",
        "too many requests",
        "quota exceeded",
        "overloaded",
        "credit balance is too low",
    ]
    return any(pattern in text for pattern in patterns)


def freeze(paths: Dict[str, Path], manifest: Dict[str, Any], reason: str) -> None:
    window = current_window(manifest)
    payload = {
        "reason": reason,
        "at": iso(utc_now()),
        "until": iso(window["end"]),
        "window": window["index"],
    }
    write_json(paths["freeze"], payload)
    append_jsonl(paths["activity"], {"event": "freeze", **payload})


def update_artifact_index(
    paths: Dict[str, Path],
    section: Dict[str, Any],
    execution: Dict[str, Any],
    verification: Optional[Dict[str, Any]],
) -> None:
    artifacts = read_json(paths["artifacts"], [])
    touched = execution.get("files_touched", [])
    normalized: List[Dict[str, Any]] = []
    for file_path in touched:
        resolved = Path(file_path)
        if not resolved.is_absolute():
            resolved = (paths["workspace"] / file_path).resolve()
        normalized.append(
            {
                "section_id": section["id"],
                "section_title": section["title"],
                "path": str(resolved),
                "exists": resolved.exists(),
                "indexed_at": iso(utc_now()),
                "verified": verification is not None and verification.get("status") == "pass",
            }
        )
    artifacts = [entry for entry in artifacts if entry.get("section_id") != section["id"]]
    artifacts.extend(normalized)
    write_json(paths["artifacts"], artifacts)
    return normalized


def rebuild_artifact_index(paths: Dict[str, Path]) -> List[Dict[str, Any]]:
    sections = {section["id"]: section for section in read_json(paths["sections"], [])}
    by_section: Dict[str, Dict[str, Dict[str, Any]]] = {}
    verification_status: Dict[str, bool] = {}
    for event in iter_activity(paths["activity"]):
        event_name = event.get("event")
        section_id = event.get("section")
        if not section_id:
            continue
        if event_name == "verifier_end":
            verification_status[section_id] = event.get("result", {}).get("status") == "pass"
        if event_name != "executor_end":
            continue
        result = event.get("result", {})
        touched = result.get("files_touched", [])
        bucket = by_section.setdefault(section_id, {})
        for file_path in touched:
            resolved = Path(file_path)
            if not resolved.is_absolute():
                resolved = (paths["workspace"] / file_path).resolve()
            bucket[str(resolved)] = {
                "section_id": section_id,
                "section_title": sections.get(section_id, {}).get("title", ""),
                "path": str(resolved),
                "exists": resolved.exists(),
                "indexed_at": event.get("at", iso(utc_now())),
                "verified": verification_status.get(section_id, sections.get(section_id, {}).get("status") == "done"),
            }
    artifacts: List[Dict[str, Any]] = []
    for section_id in sorted(by_section.keys()):
        artifacts.extend(by_section[section_id].values())
    write_json(paths["artifacts"], artifacts)
    return artifacts


def build_common_claude_args(config: Dict[str, Any], workspace: Path) -> List[str]:
    claude = require_claude()
    plugin_root = Path(__file__).resolve().parents[1]
    args = [
        claude,
        "-p",
        "--plugin-dir",
        str(plugin_root),
        "--add-dir",
        str(workspace),
        "--permission-mode",
        config.get("permission_mode", "default"),
        "--effort",
        config.get("effort", "high"),
        "--output-format",
        "json",
    ]
    max_budget = config.get("max_budget_usd")
    if max_budget is not None:
        args.extend(["--max-budget-usd", str(max_budget)])
    return args


def normalize_schema_result(config: Dict[str, Any], workspace: Path, schema: Dict[str, Any], text: str) -> Dict[str, Any]:
    args = build_common_claude_args(config, workspace)
    args.extend(
        [
            "--effort",
            "low",
            "--json-schema",
            json.dumps(schema, ensure_ascii=False),
            (
                "Convert the following text into a JSON object that strictly matches the provided schema. "
                "Preserve uncertainty honestly. Return only JSON.\n\n"
                f"TEXT:\n{text}"
            ),
        ]
    )
    proc = subprocess.run(args, cwd=str(workspace), capture_output=True, text=True)
    if proc.returncode != 0:
        raise RuntimeError(proc.stderr.strip() or proc.stdout.strip() or "schema normalization failed")
    outer = json.loads(proc.stdout)
    result_text = outer.get("result", "")
    return json.loads(result_text)


def run_agent(
    config: Dict[str, Any],
    workspace: Path,
    agent: str,
    schema: Dict[str, Any],
    prompt: str,
) -> Dict[str, Any]:
    args = build_common_claude_args(config, workspace)
    args.extend(["--agent", agent, "--json-schema", json.dumps(schema, ensure_ascii=False), prompt])
    proc = subprocess.run(args, cwd=str(workspace), capture_output=True, text=True)
    if proc.returncode != 0:
        raise RuntimeError(proc.stderr.strip() or proc.stdout.strip() or f"{agent} failed")
    try:
        outer = json.loads(proc.stdout)
    except json.JSONDecodeError:
        raise RuntimeError(f"{agent} returned invalid Claude JSON: {proc.stdout[:400]}")

    if outer.get("is_error"):
        raise RuntimeError(outer.get("result") or outer.get("error") or f"{agent} returned an error")

    result_text = outer.get("result", "")
    try:
        payload = json.loads(result_text)
    except json.JSONDecodeError:
        structured = outer.get("structured_output")
        if isinstance(structured, dict) and structured:
            payload = structured
        else:
            payload = normalize_schema_result(config, workspace, schema, result_text)

    return {
        "payload": payload,
        "usage": outer.get("usage") or {},
        "raw": outer,
    }


def rollback_recent_clean_state(paths: Dict[str, Path], git_context: Dict[str, Any], section: Dict[str, Any], reason: str) -> None:
    if not git_context.get("enabled"):
        append_jsonl(paths["activity"], {"event": "rollback_skipped", "at": iso(utc_now()), "section": section["id"], "reason": reason})
        return
    workspace = paths["workspace"]
    checkpoint = git_context["checkpoint"]
    loop_branch = git_context["loop_branch"]
    default_branch = git_context["default_branch"]
    record_all = git_context["record_all_branches"]
    if record_all:
        git_commit_all(workspace, f"tns: limit-hit record for {section['id']}")
        git_run(workspace, ["checkout", default_branch])
    else:
        git_run(workspace, ["reset", "--hard", checkpoint])
        git_run(workspace, ["clean", "-fd"])
    append_jsonl(
        paths["activity"],
        {"event": "git_limit_rollback", "at": iso(utc_now()), "section": section["id"], "loop_branch": loop_branch, "reason": reason},
    )


EXECUTOR_SCHEMA = {
    "type": "object",
    "properties": {
        "outcome": {"type": "string", "enum": ["implemented", "needs_more_work", "blocked"]},
        "clean_state": {"type": "boolean"},
        "ready_for_verification": {"type": "boolean"},
        "summary": {"type": "string"},
        "handoff_note": {"type": "string"},
        "files_touched": {"type": "array", "items": {"type": "string"}},
        "checks_run": {"type": "array", "items": {"type": "string"}},
        "blocker": {"type": "string"},
        "commit_message": {"type": "string"}
    },
    "required": [
        "outcome",
        "clean_state",
        "ready_for_verification",
        "summary",
        "handoff_note",
        "files_touched",
        "checks_run",
        "blocker",
        "commit_message"
    ]
}

VERIFIER_SCHEMA = {
    "type": "object",
    "properties": {
        "status": {"type": "string", "enum": ["pass", "fail", "blocked"]},
        "summary": {"type": "string"},
        "checks_run": {"type": "array", "items": {"type": "string"}},
        "findings": {"type": "array", "items": {"type": "string"}},
        "review_note": {"type": "string"}
    },
    "required": ["status", "summary", "checks_run", "findings", "review_note"]
}


def executor_prompt(paths: Dict[str, Path], section: Dict[str, Any], review_note: str) -> str:
    review_block = f"Review note to address first:\n{review_note}\n\n" if review_note else ""
    return f"""TNS executor run.

Workspace: {paths["workspace"]}
Tracked document: {read_json(paths["manifest"])["product_doc"]}
State files:
- {paths["sections"]}
- {paths["handoff"]}
- {paths["reviews"]}

Target section:
- id: {section["id"]}
- title: {section["title"]}
- anchor: {section["anchor"]}

Section intent:
{section.get("body", "").strip() or "(empty body)"}

{review_block}Instructions:
- Make progress on exactly this section.
- Leave the workspace in a clean state.
- Use available project tests/checks where appropriate.
- If you change code or docs, make the result handoff-friendly for a fresh session.
- Do not mark the section complete unless it is ready for a separate verifier pass.
"""


def verifier_prompt(paths: Dict[str, Path], section: Dict[str, Any], execution: Dict[str, Any]) -> str:
    return f"""TNS verifier run.

Workspace: {paths["workspace"]}
Tracked document: {read_json(paths["manifest"])["product_doc"]}
State files:
- {paths["sections"]}
- {paths["handoff"]}
- {paths["reviews"]}

Section under review:
- id: {section["id"]}
- title: {section["title"]}
- anchor: {section["anchor"]}

Executor summary:
{execution["summary"]}

Executor files touched:
{json.dumps(execution["files_touched"], ensure_ascii=False)}

Executor checks run:
{json.dumps(execution["checks_run"], ensure_ascii=False)}

Verify the section with a fresh perspective. Pass only if the section is actually complete enough and supported by evidence.
"""


def append_handoff(paths: Dict[str, Path], title: str, body: Dict[str, Any], section_id: str) -> None:
    text = (
        f"\n## {title} | {iso(utc_now())}\n\n"
        f"- section: {section_id}\n"
        f"- payload: `{json.dumps(body, ensure_ascii=False)}`\n"
    )
    append_text(paths["handoff"], text)


def update_section(sections: List[Dict[str, Any]], section_id: str, **updates: Any) -> None:
    for section in sections:
        if section["id"] == section_id:
            section.update(updates)
            return
    raise KeyError(section_id)


def run_once(config: Dict[str, Any], paths: Dict[str, Path]) -> bool:
    manifest = load_manifest(paths)
    maybe_unfreeze(paths, manifest)
    recover_in_progress_sections(paths)
    if paths["freeze"].exists():
        return False

    sections = read_json(paths["sections"], [])
    section = select_section(sections)
    if not section:
        append_jsonl(paths["activity"], {"event": "complete", "at": iso(utc_now())})
        return False

    quota = evaluate_quota(config, paths)
    append_jsonl(paths["activity"], {"event": "quota_check", "at": iso(utc_now()), "quota": quota})
    notify_loop_start(paths, config, manifest, section, quota)
    git_context = begin_loop_git_context(config, paths, section)

    review_note = section.get("last_review", "")
    update_section(sections, section["id"], status="in_progress", attempts=section.get("attempts", 0) + 1)
    write_json(paths["sections"], sections)
    append_jsonl(paths["activity"], {"event": "executor_start", "at": iso(utc_now()), "section": section["id"]})

    try:
        execution_result = run_agent(
            config,
            paths["workspace"],
            config.get("executor_agent", "tns-executor"),
            EXECUTOR_SCHEMA,
            executor_prompt(paths, section, review_note),
        )
    except Exception as exc:
        message = str(exc)
        if looks_like_usage_limit_error(message):
            rollback_recent_clean_state(paths, git_context, section, message)
            freeze(paths, manifest, f"usage_limit: {message}")
            sections = read_json(paths["sections"], [])
            update_section(sections, section["id"], status="pending", last_review="Recovered after usage limit.", last_summary="")
            write_json(paths["sections"], sections)
            return False
        raise
    execution = execution_result["payload"]
    append_handoff(paths, "Executor", execution, section["id"])
    append_jsonl(
        paths["activity"],
        {
            "event": "executor_end",
            "at": iso(utc_now()),
            "section": section["id"],
            "result": execution,
            "usage": execution_result["usage"],
        },
    )

    sections = read_json(paths["sections"], [])
    if execution["outcome"] == "blocked":
        update_section(sections, section["id"], status="blocked", last_summary=execution["summary"], last_review=execution["blocker"])
        write_json(paths["sections"], sections)
        artifact_entries = update_artifact_index(paths, section, execution, None)
        notify_loop_end(paths, config, section, execution, None, evaluate_quota(config, paths), artifact_entries)
        finalize_loop_git_context(
            config,
            paths,
            section,
            git_context,
            False,
            execution.get("commit_message") or f"tns: blocked {section['id']}",
        )
        return True

    if not execution["clean_state"] or not execution["ready_for_verification"]:
        update_section(sections, section["id"], status="pending", last_summary=execution["summary"])
        write_json(paths["sections"], sections)
        artifact_entries = update_artifact_index(paths, section, execution, None)
        notify_loop_end(paths, config, section, execution, None, evaluate_quota(config, paths), artifact_entries)
        finalize_loop_git_context(
            config,
            paths,
            section,
            git_context,
            False,
            execution.get("commit_message") or f"tns: partial {section['id']}",
        )
        return True

    append_jsonl(paths["activity"], {"event": "verifier_start", "at": iso(utc_now()), "section": section["id"]})
    verification_result = run_agent(
        config,
        paths["workspace"],
        config.get("verifier_agent", "tns-verifier"),
        VERIFIER_SCHEMA,
        verifier_prompt(paths, section, execution),
    )
    verification = verification_result["payload"]
    append_handoff(paths, "Verifier", verification, section["id"])
    append_jsonl(
        paths["activity"],
        {
            "event": "verifier_end",
            "at": iso(utc_now()),
            "section": section["id"],
            "result": verification,
            "usage": verification_result["usage"],
        },
    )

    sections = read_json(paths["sections"], [])
    reviews = read_json(paths["reviews"], [])
    if verification["status"] == "pass":
        update_section(
            sections,
            section["id"],
            status="done",
            verified_at=iso(utc_now()),
            last_summary=verification["summary"],
            last_review="",
        )
    else:
        review_note = verification["review_note"] or verification["summary"]
        update_section(
            sections,
            section["id"],
            status="needs_fix",
            last_summary=verification["summary"],
            last_review=review_note,
        )
        reviews.append(
            {
                "section": section["id"],
                "at": iso(utc_now()),
                "status": verification["status"],
                "summary": verification["summary"],
                "review_note": review_note,
                "findings": verification["findings"],
            }
        )
        write_json(paths["reviews"], reviews)
    write_json(paths["sections"], sections)
    artifact_entries = update_artifact_index(paths, section, execution, verification)

    post_quota = evaluate_quota(config, paths)
    exhausted = False
    append_jsonl(paths["activity"], {"event": "post_loop_quota", "at": iso(utc_now()), "section": section["id"], "quota": post_quota})
    notify_loop_end(paths, config, section, execution, verification, post_quota, artifact_entries)
    finalize_loop_git_context(
        config,
        paths,
        section,
        git_context,
        exhausted,
        execution.get("commit_message") or f"tns: complete {section['id']}",
    )
    return True


def cmd_init(args: argparse.Namespace) -> int:
    config = load_config(Path(args.config))
    init_state(config)
    print(f"initialized TNS in {Path(config['workspace']).expanduser().resolve() / '.tns'}")
    return 0


def cmd_status(args: argparse.Namespace) -> int:
    config = load_config(Path(args.config))
    paths = ensure_initialized(config)
    manifest = load_manifest(paths)
    maybe_unfreeze(paths, manifest)
    artifacts = rebuild_artifact_index(paths)
    sections = read_json(paths["sections"], [])
    counts: Dict[str, int] = {}
    for section in sections:
        counts[section["status"]] = counts.get(section["status"], 0) + 1
    window = current_window(manifest)
    status = {
        "workspace": str(paths["workspace"]),
        "window_index": window["index"],
        "window_start": iso(window["start"]),
        "window_end": iso(window["end"]),
        "freeze": read_json(paths["freeze"]),
        "counts": counts,
        "next_section": (select_section(sections) or {}).get("id"),
        "quota": evaluate_quota(config, paths),
        "artifact_count": len(artifacts),
        "tmux": tmux_status(config, paths),
    }
    print(json.dumps(status, indent=2, ensure_ascii=False))
    return 0


def cmd_run(args: argparse.Namespace) -> int:
    config = load_config(Path(args.config))
    paths = ensure_initialized(config)
    load_manifest(paths)
    interval = int(args.poll_seconds)
    success_interval = int(config.get("success_interval_seconds", 1))
    idle_interval = int(config.get("idle_interval_seconds", interval))
    while True:
        ran = run_once(config, paths)
        if args.once:
            break
        if not ran:
            time.sleep(idle_interval)
        else:
            time.sleep(success_interval)
    return 0


def cmd_freeze(args: argparse.Namespace) -> int:
    config = load_config(Path(args.config))
    paths = state_paths(config)
    manifest = load_manifest(paths)
    freeze(paths, manifest, args.reason or "manual freeze")
    print(json.dumps(read_json(paths["freeze"]), indent=2, ensure_ascii=False))
    return 0


def cmd_unfreeze(args: argparse.Namespace) -> int:
    config = load_config(Path(args.config))
    paths = state_paths(config)
    paths["freeze"].unlink(missing_ok=True)
    append_jsonl(paths["activity"], {"event": "manual_unfreeze", "at": iso(utc_now())})
    print("unfrozen")
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Token Never Sleeps runner")
    sub = parser.add_subparsers(dest="command", required=True)

    p_init = sub.add_parser("init")
    p_init.add_argument("--config", required=True)
    p_init.set_defaults(func=cmd_init)

    p_status = sub.add_parser("status")
    p_status.add_argument("--config", required=True)
    p_status.set_defaults(func=cmd_status)

    p_reindex = sub.add_parser("reindex-artifacts")
    p_reindex.add_argument("--config", required=True)
    p_reindex.set_defaults(
        func=lambda args: (
            print(
                json.dumps(
                    rebuild_artifact_index(state_paths(load_config(Path(args.config)))),
                    indent=2,
                    ensure_ascii=False,
                )
            )
            or 0
        )
    )

    p_run = sub.add_parser("run")
    p_run.add_argument("--config", required=True)
    p_run.add_argument("--poll-seconds", default=60)
    p_run.add_argument("--once", action="store_true")
    p_run.set_defaults(func=cmd_run)

    p_freeze = sub.add_parser("freeze")
    p_freeze.add_argument("--config", required=True)
    p_freeze.add_argument("--reason")
    p_freeze.set_defaults(func=cmd_freeze)

    p_unfreeze = sub.add_parser("unfreeze")
    p_unfreeze.add_argument("--config", required=True)
    p_unfreeze.set_defaults(func=cmd_unfreeze)
    return parser


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
