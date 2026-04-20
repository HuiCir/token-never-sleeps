#!/usr/bin/env python3
import argparse
import json
import os
import re
import shlex
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
    config["_config_path"] = str(path.expanduser().resolve())
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


def remote_report_settings(config: Dict[str, Any]) -> Dict[str, Any]:
    cfg = config.get("notifications", {}).get("claude_code_remote", {})
    return {
        "enabled": bool(cfg.get("enabled", False)),
        "root": str(cfg.get("root", "")),
        "report_task_start": bool(cfg.get("report_task_start", True)),
        "report_step_progress": bool(cfg.get("report_step_progress", True)),
        "report_task_complete": bool(cfg.get("report_task_complete", True)),
        "node_bin": str(cfg.get("node_bin", "node")),
    }


def tmux_settings(config: Dict[str, Any]) -> Dict[str, Any]:
    cfg = config.get("tmux", {})
    return {
        "enabled": bool(cfg.get("enabled", False)),
        "auto_create": bool(cfg.get("auto_create", True)),
        "session_name": str(cfg.get("session_name", "")),
        "window_name": str(cfg.get("window_name", "tns")),
        "socket_name": str(cfg.get("socket_name", "")),
        "manage_runner": bool(cfg.get("manage_runner", False)),
        "runner_window_name": str(cfg.get("runner_window_name", "tns-runner")),
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


def send_remote_report(config: Dict[str, Any], payload: Dict[str, Any], workspace: Path) -> None:
    settings = remote_report_settings(config)
    if not settings["enabled"]:
        return
    root = settings["root"].strip()
    if not root:
        raise RuntimeError("notifications.claude_code_remote.root is required when enabled")
    script = Path(__file__).resolve().parent / "ccremote_notify.js"
    proc = subprocess.run(
        [settings["node_bin"], str(script), "--ccr-root", root],
        input=json.dumps(payload, ensure_ascii=False),
        text=True,
        capture_output=True,
        cwd=str(workspace),
    )
    if proc.returncode != 0:
        raise RuntimeError(proc.stderr.strip() or proc.stdout.strip() or "claude-code-remote notify failed")


def try_send_remote_report(paths: Dict[str, Path], config: Dict[str, Any], payload: Dict[str, Any], phase: str) -> None:
    settings = remote_report_settings(config)
    if not settings["enabled"]:
        return
    try:
        send_remote_report(config, payload, paths["workspace"])
        append_jsonl(
            paths["activity"],
            {
                "event": "remote_report_sent",
                "at": iso(utc_now()),
                "phase": phase,
                "title": payload.get("title", ""),
                "type": payload.get("type", ""),
            },
        )
    except Exception as exc:
        append_jsonl(
            paths["activity"],
            {
                "event": "remote_report_error",
                "at": iso(utc_now()),
                "phase": phase,
                "title": payload.get("title", ""),
                "type": payload.get("type", ""),
                "error": str(exc),
            },
        )


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
    remote_settings = remote_report_settings(config)
    if remote_settings["report_task_start"]:
        try_send_remote_report(
            paths,
            config,
            {
                "type": "waiting",
                "title": f"TNS Task Started: {section['id']}",
                "message": f"TNS started section {section['id']} ({section['title']}).",
                "project": paths["workspace"].name,
                "metadata": {
                    "userQuestion": f"Start section {section['id']}: {section['title']}",
                    "claudeResponse": section.get("body", "").strip() or "Task started.",
                    "tmuxSession": read_json(paths["tmux"], {}).get("session_name", ""),
                    "tnsPhase": "task_start",
                    "tnsSectionId": section["id"],
                    "tnsSectionTitle": section["title"],
                    "tnsQuota": quota,
                },
            },
            "task_start",
        )


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
    remote_settings = remote_report_settings(config)
    if remote_settings["report_task_complete"]:
        verification_status = (verification or {}).get("status", "n/a")
        try_send_remote_report(
            paths,
            config,
            {
                "type": "completed" if verification_status == "pass" else "waiting",
                "title": f"TNS Loop Result: {section['id']}",
                "message": f"TNS finished loop for {section['id']} with verification={verification_status}.",
                "project": paths["workspace"].name,
                "metadata": {
                    "userQuestion": f"Section {section['id']} result",
                    "claudeResponse": (
                        f"Execution:\n{execution.get('summary', '')}\n\n"
                        f"Verification:\n{(verification or {}).get('summary', '(not verified)')}"
                    ).strip(),
                    "tmuxSession": read_json(paths["tmux"], {}).get("session_name", ""),
                    "tnsPhase": "task_complete",
                    "tnsSectionId": section["id"],
                    "tnsSectionTitle": section["title"],
                    "tnsVerificationStatus": verification_status,
                    "tnsArtifacts": artifacts,
                    "tnsQuota": post_quota,
                },
            },
            "task_complete",
        )


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
        "hook_events": state_dir / "hook-events.jsonl",
        "runner_log": state_dir / "runner.log",
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
                "current_step": "",
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
                "current_step": "",
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
    if not paths["runner_log"].exists():
        paths["runner_log"].write_text("", encoding="utf-8")
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


def workflow_settings(config: Dict[str, Any]) -> Dict[str, Any]:
    cfg = config.get("workflow", {})
    default_entry = "executor"
    default_nodes = [
        {
            "id": "executor",
            "agent": config.get("executor_agent", "tns-executor"),
            "schema": "executor",
            "prompt_mode": "executor",
            "transitions": [
                {
                    "field": "outcome",
                    "equals": "blocked",
                    "set_status": "blocked",
                    "summary_field": "summary",
                    "review_field": "blocker",
                    "end": True,
                },
                {
                    "field": "clean_state",
                    "equals": False,
                    "set_status": "pending",
                    "summary_field": "summary",
                    "end": True,
                },
                {
                    "field": "ready_for_verification",
                    "equals": False,
                    "set_status": "pending",
                    "summary_field": "summary",
                    "end": True,
                },
                {"next": "verifier"},
            ],
        },
        {
            "id": "verifier",
            "agent": config.get("verifier_agent", "tns-verifier"),
            "schema": "verifier",
            "prompt_mode": "verifier",
            "transitions": [
                {
                    "field": "status",
                    "equals": "pass",
                    "set_status": "done",
                    "summary_field": "summary",
                    "review_value": "",
                    "set_verified_at": True,
                    "end": True,
                },
                {
                    "field": "status",
                    "in": ["fail", "blocked"],
                    "set_status": "needs_fix",
                    "summary_field": "summary",
                    "review_field": "review_note",
                    "append_review": True,
                    "end": True,
                },
            ],
        },
    ]
    nodes = cfg.get("agents") or default_nodes
    return {
        "entry": str(cfg.get("entry", default_entry)),
        "max_steps_per_run": int(cfg.get("max_steps_per_run", 6)),
        "agents": nodes,
    }


def ensure_section_defaults(section: Dict[str, Any]) -> Dict[str, Any]:
    section.setdefault("status", "pending")
    section.setdefault("attempts", 0)
    section.setdefault("verified_at", None)
    section.setdefault("last_summary", "")
    section.setdefault("last_review", "")
    section.setdefault("current_step", "")
    return section


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


def tmux_has_window(config: Dict[str, Any], session_name: str, window_name: str, workspace: Path) -> bool:
    proc = subprocess.run(
        [*tmux_cmd(config), "list-windows", "-t", session_name, "-F", "#{window_name}"],
        cwd=str(workspace),
        capture_output=True,
        text=True,
    )
    if proc.returncode != 0:
        return False
    return window_name in [line.strip() for line in proc.stdout.splitlines() if line.strip()]


def validate_tmux_session_workspace(config: Dict[str, Any], session_name: str, workspace: Path) -> bool:
    """Check if an existing tmux session belongs to the expected workspace."""
    proc = subprocess.run(
        [*tmux_cmd(config), "display-message", "-t", session_name, "-p", "#{pane_current_path}"],
        capture_output=True, text=True,
    )
    if proc.returncode == 0:
        actual_cwd = proc.stdout.strip()
        expected_cwd = str(workspace.resolve())
        if actual_cwd != expected_cwd:
            print(f"WARNING: tmux session '{session_name}' workspace mismatch. Expected: {expected_cwd}, Found: {actual_cwd}")
            return False
    return True


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
    else:
        # Session exists - validate it belongs to correct workspace
        validate_tmux_session_workspace(config, session_name, paths["workspace"])
    payload = {
        "enabled": True,
        "session_name": session_name,
        "window_name": window_name,
        "socket_name": settings["socket_name"] or None,
        "workspace": str(paths["workspace"]),
        "updated_at": iso(utc_now()),
        "manage_runner": settings["manage_runner"],
        "runner_window_name": settings["runner_window_name"],
    }
    write_json(paths["tmux"], payload)


def tmux_runner_command(config: Dict[str, Any], paths: Dict[str, Path], poll_seconds: int) -> str:
    config_path = config.get("_config_path")
    if not config_path:
        raise RuntimeError("config path is required for tmux runner launch")
    script_path = Path(__file__).resolve()
    workspace = paths["workspace"]
    log_path = paths["runner_log"]
    return (
        f"cd {shlex.quote(str(workspace))} && "
        f"python3 {shlex.quote(str(script_path))} run "
        f"--config {shlex.quote(str(config_path))} "
        f"--poll-seconds {int(poll_seconds)} "
        f">> {shlex.quote(str(log_path))} 2>&1"
    )


def ensure_tmux_runner(config: Dict[str, Any], paths: Dict[str, Path], poll_seconds: int, restart: bool = False) -> Dict[str, Any]:
    settings = tmux_settings(config)
    if not settings["enabled"]:
        raise RuntimeError("tmux is not enabled in config")
    ensure_tmux_ready(config, paths)
    session_name = tmux_session_name(config, paths)
    window_name = settings["runner_window_name"]
    workspace = paths["workspace"]

    if tmux_has_window(config, session_name, window_name, workspace):
        if restart:
            subprocess.run(
                [*tmux_cmd(config), "kill-window", "-t", f"{session_name}:{window_name}"],
                cwd=str(workspace),
                capture_output=True,
                text=True,
                check=False,
            )
        else:
            return tmux_status(config, paths)

    subprocess.run(
        [*tmux_cmd(config), "new-window", "-d", "-t", session_name, "-n", window_name, "-c", str(workspace)],
        cwd=str(workspace),
        capture_output=True,
        text=True,
        check=True,
    )
    command = tmux_runner_command(config, paths, poll_seconds)
    subprocess.run(
        [*tmux_cmd(config), "send-keys", "-t", f"{session_name}:{window_name}", command, "C-m"],
        cwd=str(workspace),
        capture_output=True,
        text=True,
        check=True,
    )
    append_jsonl(
        paths["activity"],
        {
            "event": "tmux_runner_started",
            "at": iso(utc_now()),
            "session": session_name,
            "window": window_name,
            "poll_seconds": poll_seconds,
        },
    )
    return tmux_status(config, paths)


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
    runner_window = settings["runner_window_name"]
    payload["runner_window_exists"] = tmux_has_window(config, session_name, runner_window, paths["workspace"])
    if payload["runner_window_exists"]:
        pane_proc = subprocess.run(
            [*tmux_cmd(config), "list-panes", "-t", f"{session_name}:{runner_window}", "-F", "#{pane_id}:#{pane_pid}:#{pane_current_command}:#{pane_dead}"],
            cwd=str(paths["workspace"]),
            capture_output=True,
            text=True,
            check=True,
        )
        payload["runner_panes"] = [line.strip() for line in pane_proc.stdout.splitlines() if line.strip()]
    payload["runner_log"] = str(paths["runner_log"])
    payload["hook_event_count"] = len(iter_activity(paths["hook_events"]))
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


def recent_hook_feedback(paths: Dict[str, Path], limit: int = 5) -> str:
    events = iter_activity(paths["hook_events"])
    if not events:
        return "No recent hook feedback."
    lines = []
    for event in events[-limit:]:
        pieces = [
            f"at={event.get('at', '')}",
            f"event={event.get('event', '')}",
        ]
        if event.get("session_id"):
            pieces.append(f"session_id={event['session_id']}")
        if event.get("reason"):
            pieces.append(f"reason={event['reason']}")
        if event.get("transcript_path"):
            pieces.append(f"transcript={event['transcript_path']}")
        lines.append("- " + ", ".join(pieces))
    return "\n".join(lines)


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


def select_section(sections: List[Dict[str, Any]], max_attempts: int = 3) -> Optional[Dict[str, Any]]:
    for status in ["needs_fix", "pending", "blocked"]:
        for section in sections:
            ensure_section_defaults(section)
            if section["status"] == status:
                # Skip sections that exceeded max attempts, mark as blocked
                if section.get("attempts", 0) >= max_attempts:
                    section["status"] = "blocked"
                    continue
                return section
    return None


def recover_in_progress_sections(paths: Dict[str, Path]) -> None:
    sections = read_json(paths["sections"], [])
    changed = False
    for section in sections:
        ensure_section_defaults(section)
        if section.get("status") == "in_progress":
            section["status"] = "needs_fix"
            section["current_step"] = ""
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


def attempts_settings(config: Dict[str, Any]) -> Dict[str, Any]:
    attempts_cfg = config.get("attempts", {})
    return {
        "max_per_section": int(attempts_cfg.get("max_attempts_per_section", 3)),
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


def looks_like_retryable_error(message: str) -> bool:
    text = (message or "").lower()
    patterns = [
        # Permission errors
        "requires approval",
        "not authorized",
        "edits were not applied",
        "permission denied",
        # Network/transient errors
        "connection",
        "timeout",
        "econnrefused",
        "etimedout",
        "network",
        "temporary failure",
        "name resolution",
        "connection reset",
        "connection refused",
        "broken pipe",
        "host is down",
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


def get_effective_permission_mode(config: Dict[str, Any]) -> str:
    mode = config.get("permission_mode", "default")
    is_root = hasattr(os, "geteuid") and os.geteuid() == 0
    if mode == "bypassPermissions" and is_root:
        print("WARNING: bypassPermissions unavailable as root, using acceptEdits")
        return "acceptEdits"
    return mode


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
        get_effective_permission_mode(config),
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


def make_agent_error(agent: str, proc: subprocess.CompletedProcess) -> RuntimeError:
    stderr = proc.stderr.strip()
    if stderr:
        detail = stderr
    else:
        detail = proc.stdout.strip()[:200] if proc.stdout.strip() else f"{agent} failed"
    return RuntimeError(f"[{agent}] {detail}")


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
        raise make_agent_error(agent, proc)
    try:
        outer = json.loads(proc.stdout)
    except json.JSONDecodeError:
        raise RuntimeError(f"[{agent}] returned invalid Claude JSON: {proc.stdout[:400]}")

    if outer.get("is_error"):
        raise RuntimeError(outer.get("result") or outer.get("error") or f"[{agent}] returned an error")

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


def schema_by_name(name: Any) -> Dict[str, Any]:
    if isinstance(name, dict):
        return name
    if name == "executor":
        return EXECUTOR_SCHEMA
    if name == "verifier":
        return VERIFIER_SCHEMA
    raise RuntimeError(f"unsupported workflow schema: {name}")


def executor_prompt(paths: Dict[str, Path], section: Dict[str, Any], review_note: str, hook_feedback: str) -> str:
    review_block = f"Review note to address first:\n{review_note}\n\n" if review_note else ""
    return f"""TNS executor run.

Workspace: {paths["workspace"]}
Tracked document: {read_json(paths["manifest"])["product_doc"]}
State files:
- {paths["sections"]}
- {paths["handoff"]}
- {paths["reviews"]}
- {paths["hook_events"]}

Target section:
- id: {section["id"]}
- title: {section["title"]}
- anchor: {section["anchor"]}

Section intent:
{section.get("body", "").strip() or "(empty body)"}

Recent hook feedback:
{hook_feedback}

{review_block}Instructions:
- Make progress on exactly this section.
- Leave the workspace in a clean state.
- Use available project tests/checks where appropriate.
- If you change code or docs, make the result handoff-friendly for a fresh session.
- Do not mark the section complete unless it is ready for a separate verifier pass.
"""


def verifier_prompt(paths: Dict[str, Path], section: Dict[str, Any], execution: Dict[str, Any], hook_feedback: str) -> str:
    return f"""TNS verifier run.

Workspace: {paths["workspace"]}
Tracked document: {read_json(paths["manifest"])["product_doc"]}
State files:
- {paths["sections"]}
- {paths["handoff"]}
- {paths["reviews"]}
- {paths["hook_events"]}

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

Recent hook feedback:
{hook_feedback}

Verify the section with a fresh perspective. Pass only if the section is actually complete enough and supported by evidence.
"""


def generic_prompt(
    paths: Dict[str, Path],
    section: Dict[str, Any],
    node: Dict[str, Any],
    review_note: str,
    prior_results: Dict[str, Dict[str, Any]],
    hook_feedback: str,
) -> str:
    instructions = str(node.get("instructions", "")).strip()
    prior_summary = json.dumps(prior_results, ensure_ascii=False, indent=2)
    review_block = f"Current review note:\n{review_note}\n\n" if review_note else ""
    return f"""TNS workflow agent run.

Workflow step: {node["id"]}
Agent: {node["agent"]}
Workspace: {paths["workspace"]}
Tracked document: {read_json(paths["manifest"])["product_doc"]}
State files:
- {paths["sections"]}
- {paths["handoff"]}
- {paths["reviews"]}
- {paths["hook_events"]}

Target section:
- id: {section["id"]}
- title: {section["title"]}
- anchor: {section["anchor"]}

Section intent:
{section.get("body", "").strip() or "(empty body)"}

Recent hook feedback:
{hook_feedback}

Prior workflow results:
{prior_summary}

{review_block}Workflow instructions:
{instructions or 'Produce a valid JSON result for this workflow step.'}
"""


def build_stage_prompt(
    paths: Dict[str, Path],
    section: Dict[str, Any],
    node: Dict[str, Any],
    prior_results: Dict[str, Dict[str, Any]],
) -> str:
    hook_feedback = recent_hook_feedback(paths)
    prompt_mode = node.get("prompt_mode", "generic")
    if prompt_mode == "executor":
        return executor_prompt(paths, section, section.get("last_review", ""), hook_feedback)
    if prompt_mode == "verifier":
        execution = prior_results.get("executor", {})
        return verifier_prompt(paths, section, execution, hook_feedback)
    return generic_prompt(paths, section, node, section.get("last_review", ""), prior_results, hook_feedback)


MAX_HANDOFF_LINES = 500
KEEP_RECENT_LINES = 100


def append_handoff(paths: Dict[str, Path], title: str, body: Dict[str, Any], section_id: str) -> None:
    text = (
        f"\n## {title} | {iso(utc_now())}\n\n"
        f"- section: {section_id}\n"
        f"- payload: `{json.dumps(body, ensure_ascii=False)}`\n"
    )
    append_text(paths["handoff"], text)
    # Rotate handoff if too large
    if paths["handoff"].exists():
        lines = paths["handoff"].read_text().splitlines()
        if len(lines) > MAX_HANDOFF_LINES:
            paths["handoff"].write_text(
                "\n".join(lines[:50] + ["\n# ... (earlier entries truncated) ...\n"] + lines[-KEEP_RECENT_LINES:]),
                encoding="utf-8",
            )


def update_section(sections: List[Dict[str, Any]], section_id: str, **updates: Any) -> None:
    for section in sections:
        ensure_section_defaults(section)
        if section["id"] == section_id:
            section.update(updates)
            return
    raise KeyError(section_id)


def workflow_node_map(config: Dict[str, Any]) -> Dict[str, Dict[str, Any]]:
    nodes = workflow_settings(config)["agents"]
    mapping: Dict[str, Dict[str, Any]] = {}
    for node in nodes:
        node_id = str(node.get("id", "")).strip()
        if not node_id:
            raise RuntimeError("workflow agent is missing id")
        mapping[node_id] = node
    return mapping


def payload_value(payload: Dict[str, Any], field: str) -> Any:
    current: Any = payload
    for part in field.split("."):
        if not isinstance(current, dict):
            return None
        current = current.get(part)
    return current


def transition_matches(payload: Dict[str, Any], transition: Dict[str, Any]) -> bool:
    field = transition.get("field")
    if not field:
        return True
    value = payload_value(payload, str(field))
    if "equals" in transition:
        return value == transition.get("equals")
    if "not_equals" in transition:
        return value != transition.get("not_equals")
    if "in" in transition:
        return value in transition.get("in", [])
    if transition.get("truthy") is True:
        return bool(value)
    if transition.get("truthy") is False:
        return not bool(value)
    return False


def first_matching_transition(payload: Dict[str, Any], node: Dict[str, Any]) -> Dict[str, Any]:
    for transition in node.get("transitions", []):
        if transition_matches(payload, transition):
            return transition
    return {}


def apply_transition_to_section(
    sections: List[Dict[str, Any]],
    reviews: List[Dict[str, Any]],
    section: Dict[str, Any],
    payload: Dict[str, Any],
    transition: Dict[str, Any],
    node_id: str,
) -> Dict[str, Any]:
    updates: Dict[str, Any] = {}
    if transition.get("set_status"):
        updates["status"] = transition["set_status"]
    if transition.get("summary_field"):
        updates["last_summary"] = payload_value(payload, str(transition["summary_field"])) or ""
    if "review_value" in transition:
        updates["last_review"] = transition.get("review_value", "")
    elif transition.get("review_field"):
        updates["last_review"] = payload_value(payload, str(transition["review_field"])) or ""
    if transition.get("set_verified_at"):
        updates["verified_at"] = iso(utc_now())
    next_step = str(transition.get("next", "") or "")
    updates["current_step"] = next_step
    update_section(sections, section["id"], **updates)

    if transition.get("append_review"):
        review_note = updates.get("last_review") or updates.get("last_summary") or ""
        reviews.append(
            {
                "section": section["id"],
                "at": iso(utc_now()),
                "status": payload.get("status", ""),
                "summary": updates.get("last_summary", ""),
                "review_note": review_note,
                "findings": payload.get("findings", []),
                "step": node_id,
            }
        )
    return updates


def aggregate_step_payloads(step_results: List[Dict[str, Any]]) -> Dict[str, Any]:
    files_touched: List[str] = []
    checks_run: List[str] = []
    summary_parts: List[str] = []
    commit_message = ""
    for result in step_results:
        payload = result["payload"]
        files_touched.extend(payload.get("files_touched", []))
        checks_run.extend(payload.get("checks_run", []))
        summary = payload.get("summary")
        if summary:
            summary_parts.append(f"{result['node_id']}: {summary}")
        if payload.get("commit_message"):
            commit_message = payload["commit_message"]
    dedup_files = list(dict.fromkeys(files_touched))
    dedup_checks = list(dict.fromkeys(checks_run))
    return {
        "summary": "\n".join(summary_parts),
        "files_touched": dedup_files,
        "checks_run": dedup_checks,
        "commit_message": commit_message,
    }


def run_once(config: Dict[str, Any], paths: Dict[str, Path]) -> bool:
    manifest = load_manifest(paths)
    maybe_unfreeze(paths, manifest)
    recover_in_progress_sections(paths)
    if paths["freeze"].exists():
        return False

    sections = [ensure_section_defaults(section) for section in read_json(paths["sections"], [])]
    max_attempts = attempts_settings(config)["max_per_section"]
    section = select_section(sections, max_attempts=max_attempts)
    if not section:
        append_jsonl(paths["activity"], {"event": "complete", "at": iso(utc_now())})
        return False

    quota = evaluate_quota(config, paths)
    append_jsonl(paths["activity"], {"event": "quota_check", "at": iso(utc_now()), "quota": quota})
    notify_loop_start(paths, config, manifest, section, quota)
    git_context = begin_loop_git_context(config, paths, section)

    workflow = workflow_settings(config)
    node_map = workflow_node_map(config)
    current_step = section.get("current_step") or workflow["entry"]
    update_section(
        sections,
        section["id"],
        status="in_progress",
        attempts=section.get("attempts", 0) + 1,
        current_step=current_step,
    )
    write_json(paths["sections"], sections)
    prior_results: Dict[str, Dict[str, Any]] = {}
    step_results: List[Dict[str, Any]] = []
    reviews = read_json(paths["reviews"], [])
    max_steps = workflow["max_steps_per_run"]

    for _ in range(max_steps):
        node = node_map.get(current_step)
        if not node:
            raise RuntimeError(f"workflow step not found: {current_step}")
        append_jsonl(
            paths["activity"],
            {"event": "agent_start", "at": iso(utc_now()), "section": section["id"], "step": current_step, "agent": node["agent"]},
        )
        try:
            result = run_agent(
                config,
                paths["workspace"],
                node["agent"],
                schema_by_name(node.get("schema", "executor")),
                build_stage_prompt(paths, section, node, prior_results),
            )
        except Exception as exc:
            message = str(exc)
            if looks_like_usage_limit_error(message):
                rollback_recent_clean_state(paths, git_context, section, message)
                freeze(paths, manifest, f"usage_limit: {message}")
                sections = [ensure_section_defaults(item) for item in read_json(paths["sections"], [])]
                update_section(
                    sections,
                    section["id"],
                    status="pending",
                    last_review="Recovered after usage limit.",
                    last_summary="",
                    current_step=current_step,
                )
                write_json(paths["sections"], sections)
                return False
            if looks_like_retryable_error(message):
                append_jsonl(paths["activity"], {
                    "event": "transient_error",
                    "at": iso(utc_now()),
                    "section": section["id"],
                    "step": current_step,
                    "error": message[:500],
                })
                sections = [ensure_section_defaults(item) for item in read_json(paths["sections"], [])]
                update_section(
                    sections,
                    section["id"],
                    status="needs_fix",
                    last_review=f"Transient error (will retry): {message[:200]}",
                    current_step=current_step,
                )
                write_json(paths["sections"], sections)
                return False
            raise

        payload = result["payload"]
        prior_results[current_step] = payload
        step_results.append({"node_id": current_step, "payload": payload, "usage": result["usage"]})
        append_handoff(paths, current_step.title(), payload, section["id"])
        append_jsonl(
            paths["activity"],
            {
                "event": "agent_end",
                "at": iso(utc_now()),
                "section": section["id"],
                "step": current_step,
                "agent": node["agent"],
                "result": payload,
                "usage": result["usage"],
            },
        )
        remote_settings = remote_report_settings(config)
        if remote_settings["report_step_progress"]:
            result_summary = payload.get("summary", "") or json.dumps(payload, ensure_ascii=False)
            try_send_remote_report(
                paths,
                config,
                {
                    "type": "waiting",
                    "title": f"TNS Step Update: {section['id']} / {current_step}",
                    "message": f"TNS step {current_step} finished for {section['id']}.",
                    "project": paths["workspace"].name,
                    "metadata": {
                        "userQuestion": f"Workflow step {current_step} for {section['id']}",
                        "claudeResponse": result_summary,
                        "tmuxSession": read_json(paths["tmux"], {}).get("session_name", ""),
                        "tnsPhase": "step_progress",
                        "tnsSectionId": section["id"],
                        "tnsSectionTitle": section["title"],
                        "tnsStepId": current_step,
                        "tnsPayload": payload,
                    },
                },
                "step_progress",
            )

        sections = [ensure_section_defaults(item) for item in read_json(paths["sections"], [])]
        transition = first_matching_transition(payload, node)
        apply_transition_to_section(sections, reviews, section, payload, transition, current_step)
        write_json(paths["sections"], sections)
        write_json(paths["reviews"], reviews)
        section = next(item for item in sections if item["id"] == section["id"])
        current_step = section.get("current_step", "")
        if transition.get("end") or not current_step:
            break
    else:
        sections = [ensure_section_defaults(item) for item in read_json(paths["sections"], [])]
        update_section(sections, section["id"], status="needs_fix", last_review="Workflow exceeded max_steps_per_run.")
        write_json(paths["sections"], sections)

    execution = prior_results.get("executor") or aggregate_step_payloads(step_results)
    verification = prior_results.get("verifier")
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
        "workflow": workflow_settings(config),
        "recent_hook_feedback": recent_hook_feedback(paths),
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


def cmd_run_tmux(args: argparse.Namespace) -> int:
    config = load_config(Path(args.config))
    paths = ensure_initialized(config)
    status = ensure_tmux_runner(config, paths, int(args.poll_seconds), restart=bool(args.restart))
    print(json.dumps(status, indent=2, ensure_ascii=False))
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

    p_run_tmux = sub.add_parser("run-tmux")
    p_run_tmux.add_argument("--config", required=True)
    p_run_tmux.add_argument("--poll-seconds", default=60)
    p_run_tmux.add_argument("--restart", action="store_true")
    p_run_tmux.set_defaults(func=cmd_run_tmux)

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
