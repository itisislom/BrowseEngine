#!/usr/bin/env python3
"""
BrowseEngine coding agent (CLI) — Enhanced Edition.

Key capabilities:
  * Context manager    - token budget; old tool outputs are cleared first, old turns are then
                         summarized by the LLM, so the dialog never overflows the window.
  * Pinned memory      - project docs + file map, .agent/memory.md (`remember` tool), the plan
                         (`update_plan` tool), the dialog summary and the list of changed files are
                         rebuilt into the system prompt on EVERY step, so they are never lost.
  * Persistent session - .agent/session.json: restart the script and the agent still knows everything.
  * Robust tool calls  - parses OpenAI native calls, Qwen XML, Hermes <tool_call>, and fenced JSON;
                         auto-falls back to text tool-calling if a provider rejects tool schemas.
  * Smart file editing - preserves LF/CRLF line endings, supports line-trimmed fallback matching in
                         `replace_in_file`, keeps in-memory backups for instant `/undo`.
  * Safety & stability - process-tree kill on command timeout, retries with backoff, loop protection,
                         Ctrl+C safe, secrets (.env*, keys) are never read, grepped or listed.

Settings (.env or environment):
  CONTEXT_TOKENS   context budget in tokens (default 32000)
  MAX_TOOL_OUTPUT  max chars of one tool result (default 6000)
"""
import os
import sys
import json
import re
import time
import uuid
import signal
import fnmatch
import difflib
import argparse
import subprocess
from pathlib import Path
from urllib import request, error

WORKSPACE_DIR = Path(__file__).resolve().parent
STATE_DIR = WORKSPACE_DIR / ".agent"
SESSION_FILE = STATE_DIR / "session.json"
MEMORY_FILE = STATE_DIR / "memory.md"

IGNORED_DIRS = {
    ".git", "node_modules", "dist", "build", "__pycache__", ".venv", "venv",
    ".agent", ".agents", ".next", ".cache", "coverage", ".idea", ".vscode",
    "target", "out", ".turbo", ".nuxt", ".pytest_cache", ".mypy_cache",
}
BINARY_EXT = {
    ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".svg", ".glb", ".gltf", ".bin", ".zip",
    ".gz", ".tar", ".7z", ".mp4", ".mp3", ".wav", ".ogg", ".ttf", ".woff", ".woff2", ".eot",
    ".pdf", ".exe", ".dll", ".so", ".dylib", ".pyc", ".pyo", ".pyd", ".class", ".jar",
    ".hdr", ".exr", ".fbx", ".obj", ".blend", ".sqlite", ".db",
}
LOCK_FILES = {
    "package-lock.json", "yarn.lock", "pnpm-lock.yaml", "poetry.lock",
    "Cargo.lock", "Gemfile.lock", "composer.lock", "uv.lock",
}
SAFE_ENV_FILES = {".env.example", ".env.sample", ".env.template", ".env.dist"}
SECRET_EXT = {".pem", ".key", ".p12", ".pfx", ".keystore"}
SECRET_NAMES = {"id_rsa", "id_ed25519", "id_ecdsa", "id_dsa", ".npmrc", ".pypirc", ".netrc"}

# --------------------------------------------------------------------------------------
# Environment / provider selection
# --------------------------------------------------------------------------------------

def load_env(env_path: Path):
    if not env_path.is_file():
        return
    try:
        with open(env_path, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                if line.startswith("export "):
                    line = line[7:].strip()
                key, val = line.split("=", 1)
                key = key.strip()
                val = val.strip().strip("'\"")
                if key and key not in os.environ:
                    os.environ[key] = val
    except OSError:
        pass


load_env(WORKSPACE_DIR / ".env")

if os.environ.get("GROQ_API_KEY"):
    API_KEY = os.environ["GROQ_API_KEY"]
    BASE_URL = os.environ.get("BASE_URL", "https://api.groq.com/openai/v1").rstrip("/")
    DEFAULT_MODEL = os.environ.get("MODEL", "qwen/qwen3-32b")
elif os.environ.get("OPENROUTER_API_KEY"):
    API_KEY = os.environ["OPENROUTER_API_KEY"]
    BASE_URL = os.environ.get("BASE_URL", "https://openrouter.ai/api/v1").rstrip("/")
    DEFAULT_MODEL = os.environ.get("MODEL", "google/gemma-4-31b-it:free")
elif os.environ.get("HF_TOKEN") or os.environ.get("HUGGINGFACE_API_KEY"):
    API_KEY = os.environ.get("HF_TOKEN") or os.environ.get("HUGGINGFACE_API_KEY", "")
    BASE_URL = (os.environ.get("BASE_URL") or os.environ.get("HF_BASE_URL", "https://router.huggingface.co/v1")).rstrip("/")
    DEFAULT_MODEL = os.environ.get("MODEL") or os.environ.get("HF_MODEL", "Qwen/Qwen2.5-Coder-32B-Instruct")
elif os.environ.get("WONKA_API_KEY"):
    API_KEY = os.environ["WONKA_API_KEY"]
    BASE_URL = os.environ.get("WONKA_BASE_URL", "https://islom-2.wonka.chat/api/agents/v1").rstrip("/")
    DEFAULT_MODEL = os.environ.get("WONKA_MODEL") or os.environ.get("WONKA_AGENT_ID", "agent_Cnarqpg5JSuX5H2ZZ-hz2")
else:
    API_KEY = os.environ.get("OPENAI_API_KEY", "")
    BASE_URL = os.environ.get("BASE_URL", "https://api.openai.com/v1").rstrip("/")
    DEFAULT_MODEL = os.environ.get("MODEL", "gpt-4o")

if "MODEL" in os.environ:
    DEFAULT_MODEL = os.environ["MODEL"]
if "BASE_URL" in os.environ:
    BASE_URL = os.environ["BASE_URL"].rstrip("/")


def _env_int(name: str, default: int) -> int:
    try:
        return int(os.environ.get(name, default))
    except (TypeError, ValueError):
        return default


CONTEXT_TOKENS = _env_int("CONTEXT_TOKENS", 32000)
MAX_TOOL_OUTPUT = _env_int("MAX_TOOL_OUTPUT", 6000)
MAX_READ_LINES = 400
LIST_LIMIT = 300
MEMORY_LIMIT = 6000      # chars kept in .agent/memory.md
SUMMARY_LIMIT = 4000     # chars of the rolling dialog summary

GRAY, RED, GREEN, YELLOW, CYAN, BLUE, RESET = (
    "\033[90m", "\033[91m", "\033[92m", "\033[93m", "\033[96m", "\033[94m", "\033[0m",
)

CFG = {
    "base_url": BASE_URL,
    "api_key": API_KEY,
    "model": DEFAULT_MODEL,
    "native_tools": True,  # auto-switches to False if provider rejects tool schema
}

# --------------------------------------------------------------------------------------
# Small helpers & security guardrails
# --------------------------------------------------------------------------------------

def est_tokens(text: str) -> int:
    """Cheap, slightly pessimistic token estimate (code is token-dense)."""
    return len(text) // 3 + 1


def clip(text: str, limit: int = None) -> str:
    """Keep head + tail of a long text, mark the cut."""
    limit = MAX_TOOL_OUTPUT if limit is None else limit
    if len(text) <= limit:
        return text
    head = int(limit * 0.7)
    tail = limit - head
    cut = len(text) - head - tail
    return f"{text[:head]}\n...[{cut} chars truncated]...\n{text[-tail:]}"


def new_call_id() -> str:
    return "call_" + uuid.uuid4().hex[:8]


def strip_think(text: str) -> str:
    text = re.sub(r"<think>.*?(?:</think>|\Z)", "", text, flags=re.S)
    if "</think>" in text:
        text = text.split("</think>", 1)[1]
    return text.strip()


def ensure_state_dir():
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    gi = STATE_DIR / ".gitignore"
    if not gi.exists():
        gi.write_text("*\n", encoding="utf-8")


def is_secret_file(path_or_name) -> bool:
    name = Path(path_or_name).name
    low = name.lower()
    if low in SAFE_ENV_FILES:
        return False
    if low == ".env" or low.startswith(".env."):
        return True
    if low in SECRET_NAMES or Path(low).suffix in SECRET_EXT:
        return True
    return False


def safe_resolve_path(rel_path: str) -> Path:
    if not rel_path or not str(rel_path).strip():
        rel_path = "."
    target = (WORKSPACE_DIR / rel_path).resolve()
    try:
        rel = target.relative_to(WORKSPACE_DIR)
    except ValueError:
        raise PermissionError(f"Access denied: Path '{rel_path}' is outside workspace.")
    if any(p in (".git", ".agent") for p in rel.parts) or is_secret_file(target):
        raise PermissionError(f"Access denied: '{rel_path}' is protected.")
    return target


def read_text_preserve_eol(path: Path) -> tuple[str, str]:
    """Read file content and detect its dominant line ending ('\\r\\n' or '\\n')."""
    raw = path.read_bytes()
    eol = "\r\n" if b"\r\n" in raw else "\n"
    text = raw.decode("utf-8", errors="replace").replace("\r\n", "\n")
    return text, eol


def write_text_preserve_eol(path: Path, text: str, eol: str = "\n"):
    normalized = text.replace("\r\n", "\n")
    if eol == "\r\n":
        normalized = normalized.replace("\n", "\r\n")
    path.write_bytes(normalized.encode("utf-8"))

# --------------------------------------------------------------------------------------
# Session (everything that must survive between steps / restarts)
# --------------------------------------------------------------------------------------

PLAN_ICONS = {"pending": "[ ]", "in_progress": "[~]", "done": "[x]"}
_STATUS_ALIASES = {
    "completed": "done", "complete": "done", "finished": "done", "x": "done",
    "active": "in_progress", "doing": "in_progress", "in-progress": "in_progress",
}


def normalize_plan(plan) -> list:
    """Accept a list of dicts, a list of strings ('[x] task') or a JSON/text string."""
    if isinstance(plan, str):
        s = plan.strip()
        try:
            plan = json.loads(s)
        except ValueError:
            plan = [ln for ln in s.splitlines() if ln.strip()]
    if not isinstance(plan, list):
        return []
    items = []
    for it in plan:
        if isinstance(it, dict):
            task = str(it.get("task") or it.get("text") or it.get("title") or "").strip()
            status = str(it.get("status") or "pending").lower()
        else:
            line = str(it).strip()
            status = "pending"
            m = re.match(r"^[-*]?\s*\[([ xX~>])\]\s*(.*)$", line)
            if m:
                status = {"x": "done", "~": "in_progress", ">": "in_progress"}.get(m.group(1).lower(), "pending")
                line = m.group(2)
            task = line
        if status not in PLAN_ICONS:
            status = _STATUS_ALIASES.get(status, "pending")
        if task:
            items.append({"task": task[:200], "status": status})
    return items[:15]


def render_plan(plan: list) -> str:
    return "\n".join(f"{PLAN_ICONS.get(i['status'], '[ ]')} {i['task']}" for i in plan)


def read_memory() -> str:
    try:
        return MEMORY_FILE.read_text(encoding="utf-8").strip()
    except OSError:
        return ""


def repair_history(history: list):
    """Ensure history starts with a user message and every assistant tool_call has a matching tool result."""
    fixed, i, n = [], 0, len(history)
    while i < n:
        m = history[i]
        fixed.append(m)
        i += 1
        if m.get("role") == "assistant" and m.get("tool_calls"):
            answered = set()
            while i < n and history[i].get("role") == "tool":
                fixed.append(history[i])
                answered.add(history[i].get("tool_call_id"))
                i += 1
            for tc in m["tool_calls"]:
                if tc["id"] not in answered:
                    fixed.append({
                        "role": "tool", "tool_call_id": tc["id"], "name": tc["function"]["name"],
                        "content": "Error: the call was interrupted before it finished.",
                    })
    # Drop orphan tool messages that aren't preceded by an assistant tool_call
    cleaned = []
    valid_tc_ids = set()
    for m in fixed:
        role = m.get("role")
        if role == "assistant":
            valid_tc_ids = {tc["id"] for tc in (m.get("tool_calls") or []) if "id" in tc}
            cleaned.append(m)
        elif role == "tool":
            if m.get("tool_call_id") in valid_tc_ids:
                cleaned.append(m)
        elif role == "user":
            valid_tc_ids = set()
            cleaned.append(m)
    # Ensure first message is from user if history is non-empty
    while cleaned and cleaned[0].get("role") != "user":
        cleaned.pop(0)
    history[:] = cleaned


class Session:
    def __init__(self):
        self.history = []
        self.summary = ""
        self.plan = []
        self.touched = []
        self.backups = {}  # rel_path -> bytes ( None if file didn't exist before )
        self.project_ctx = ""
        self.project_ctx_dirty = True
        self.budget = CONTEXT_TOKENS

    def reset(self):
        self.history, self.summary, self.plan, self.touched = [], "", [], []
        self.backups.clear()
        self.project_ctx_dirty = True

    def backup_before_write(self, resolved: Path):
        rel = resolved.relative_to(WORKSPACE_DIR).as_posix()
        if rel not in self.backups:
            self.backups[rel] = resolved.read_bytes() if resolved.is_file() else None

    def touch(self, path: str):
        rel = Path(path).as_posix()
        if rel in self.touched:
            self.touched.remove(rel)
        self.touched.append(rel)
        self.touched = self.touched[-30:]
        self.project_ctx_dirty = True

    def undo_last(self) -> str:
        if not self.touched:
            return "Nothing to undo in this session."
        rel = self.touched.pop()
        target = safe_resolve_path(rel)
        self.project_ctx_dirty = True
        if rel in self.backups:
            orig = self.backups.pop(rel)
            if orig is None:
                if target.is_file():
                    target.unlink()
                return f"Removed newly created file: {rel}"
            else:
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(orig)
                return f"Restored {rel} to its original state before session edits."
        return f"No backup snapshot found for {rel}."

    def system_text(self) -> str:
        if self.project_ctx_dirty or not self.project_ctx:
            self.project_ctx = build_project_context()
            self.project_ctx_dirty = False
        parts = [
            SYSTEM_PROMPT,
            f"## Environment\nWorkspace: {WORKSPACE_DIR}\nOS: {sys.platform}\nDate: {time.strftime('%Y-%m-%d')}",
        ]
        if not CFG["native_tools"]:
            parts.append( render_text_tools_prompt() )
        if self.project_ctx:
            parts.append("## Project context\n" + self.project_ctx)
        mem = read_memory()
        if mem:
            parts.append("## Long-term memory (saved with the `remember` tool)\n" + mem)
        if self.summary:
            parts.append("## Summary of the earlier conversation\n" + self.summary)
        if self.plan:
            parts.append("## Current plan\n" + render_plan(self.plan))
        if self.touched:
            parts.append("## Files you changed in this session\n" + ", ".join(self.touched[-20:]))
        return "\n\n".join(parts)

    def save(self):
        try:
            ensure_state_dir()
            tmp = SESSION_FILE.with_suffix(".tmp")
            tmp.write_text(json.dumps({
                "history": self.history, "summary": self.summary,
                "plan": self.plan, "touched": self.touched,
            }, ensure_ascii=False), encoding="utf-8")
            os.replace(tmp, SESSION_FILE)
        except OSError as exc:
            print(f"{YELLOW}[warn] could not save session: {exc}{RESET}")

    def load(self) -> bool:
        try:
            data = json.loads(SESSION_FILE.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return False
        self.history = [m for m in data.get("history", [])
                        if isinstance(m, dict) and m.get("role") in ("user", "assistant", "tool")]
        self.summary = str(data.get("summary", ""))
        self.plan = normalize_plan(data.get("plan", []))
        self.touched = list(data.get("touched", []))
        repair_history(self.history)
        return bool(self.history or self.summary)


SESSION = Session()

# --------------------------------------------------------------------------------------
# Project context (docs + manifest summaries + file map with symbols)
# --------------------------------------------------------------------------------------

CONTEXT_DOCS = ["GEMINI.md", "AGENTS.md", "CLAUDE.md", "README.md"]
_JS_SYM = re.compile(
    r"^(?:export\s+(?:default\s+)?)?(?:async\s+)?(?:function\*?|class|interface|enum)\s+(\w+)"
    r"|^export\s+(?:default\s+)?(?:const|let|type)\s+(\w+)", re.M)
_PY_SYM = re.compile(r"^(?:async\s+)?(?:def|class)\s+(\w+)", re.M)
_RS_SYM = re.compile(r"^(?:pub\s+)?(?:async\s+)?(?:fn|struct|enum|trait|mod)\s+(\w+)", re.M)
_GO_SYM = re.compile(r"^(?:func(?:\s+\([^)]+\))?|type)\s+(\w+)", re.M)
SYMBOL_RE = {
    ".py": _PY_SYM, ".js": _JS_SYM, ".jsx": _JS_SYM, ".ts": _JS_SYM, ".tsx": _JS_SYM, ".mjs": _JS_SYM,
    ".rs": _RS_SYM, ".go": _GO_SYM,
}


def repo_map(limit: int = 3500) -> str:
    lines, total, used = [], 0, 0
    for root, dirs, files in os.walk(WORKSPACE_DIR):
        dirs[:] = sorted(d for d in dirs if d not in IGNORED_DIRS)
        for f in sorted(files):
            p = Path(root) / f
            if p.suffix.lower() in BINARY_EXT or f in LOCK_FILES or is_secret_file(p):
                continue
            total += 1
            line = p.relative_to(WORKSPACE_DIR).as_posix()
            rx = SYMBOL_RE.get(p.suffix.lower())
            if rx:
                try:
                    if p.stat().st_size < 150_000:
                        text = p.read_text(encoding="utf-8", errors="ignore")
                        syms = []
                        for m in rx.finditer(text):
                            s = next((g for g in m.groups() if g), None)
                            if s and s not in syms:
                                syms.append(s)
                            if len(syms) >= 8:
                                break
                        if syms:
                            line += ": " + ", ".join(syms)
                except OSError:
                    pass
            if used + len(line) + 1 <= limit:
                lines.append(line)
                used += len(line) + 1
    shown = len(lines)
    if total > shown:
        lines.append(f"... and {total - shown} more files (use list_dir / find_files)")
    return "\n".join(lines)


def package_summary() -> str:
    manifests = []
    pkg_path = WORKSPACE_DIR / "package.json"
    if pkg_path.is_file():
        try:
            d = json.loads(pkg_path.read_text(encoding="utf-8"))
            if isinstance(d, dict):
                out = [f"name: {d.get('name', '?')}"]
                if d.get("scripts"):
                    out.append("scripts: " + ", ".join(f"{k}={v}" for k, v in d["scripts"].items()))
                if d.get("dependencies"):
                    out.append("dependencies: " + ", ".join(d["dependencies"].keys()))
                if d.get("devDependencies"):
                    out.append("devDependencies: " + ", ".join(d["devDependencies"].keys()))
                manifests.append("### package.json\n" + clip("\n".join(out), 1200))
        except (OSError, ValueError):
            pass
    for mf in ("pyproject.toml", "Cargo.toml", "go.mod"):
        p = WORKSPACE_DIR / mf
        if p.is_file():
            try:
                manifests.append(f"### {mf}\n" + clip(p.read_text(encoding="utf-8", errors="replace"), 800))
            except OSError:
                pass
    return "\n\n".join(manifests)


def build_project_context() -> str:
    parts, docs = [], 0
    for name in CONTEXT_DOCS:
        p = WORKSPACE_DIR / name
        if p.is_file() and docs < 2:
            docs += 1
            parts.append(f"### {name}\n" + clip(p.read_text(encoding="utf-8", errors="replace"), 2500))
    pkg = package_summary()
    if pkg:
        parts.append(pkg)
    parts.append("### File map (path: top-level symbols)\n" + repo_map())
    return "\n\n".join(parts)

# --------------------------------------------------------------------------------------
# Tools
# --------------------------------------------------------------------------------------

def tool_read_file(path: str, start_line: int = 1, end_line: int = -1) -> str:
    resolved = safe_resolve_path(path)
    if not resolved.is_file():
        return f"Error: File not found: {path}"
    text, _ = read_text_preserve_eol(resolved)
    lines = text.splitlines()
    total = len(lines)
    if total == 0:
        return f"[{path} is empty]"
    s = max(1, int(start_line))
    if s > total:
        return f"Error: start_line {s} is beyond the end of the file ({total} lines)."
    e = total if end_line <= 0 else min(total, int(end_line))
    if e - s + 1 > MAX_READ_LINES:
        e = s + MAX_READ_LINES - 1
    body = "".join(f"{i}: {lines[i - 1]}\n" for i in range(s, e + 1))
    footer = f"[lines {s}-{e} of {total}"
    footer += f"; more: call again with start_line={e + 1}]" if e < total else "]"
    return clip(body, MAX_TOOL_OUTPUT * 2) + footer


def tool_write_file(path: str, content: str) -> str:
    resolved = safe_resolve_path(path)
    SESSION.backup_before_write(resolved)
    eol = "\n"
    if resolved.is_file():
        _, eol = read_text_preserve_eol(resolved)
    resolved.parent.mkdir(parents=True, exist_ok=True)
    write_text_preserve_eol(resolved, content, eol=eol)
    SESSION.touch(path)
    line_count = content.replace("\r\n", "\n").count("\n") + 1
    return f"Success: Wrote {len(content)} characters ({line_count} lines) to {path}"


def _fuzzy_line_replace(content: str, target: str, replacement: str) -> tuple[str | None, int, int]:
    """Fallback when exact match fails: match lines ignoring trailing whitespace."""
    c_lines = content.splitlines()
    t_lines = target.splitlines()
    if not t_lines:
        return None, 0, 0
    t_stripped = [ln.rstrip() for ln in t_lines]
    c_stripped = [ln.rstrip() for ln in c_lines]
    n_t = len(t_lines)
    matches = [
        i for i in range(len(c_lines) - n_t + 1)
        if c_stripped[i:i + n_t] == t_stripped
    ]
    if len(matches) != 1:
        return None, len(matches), 0
    idx = matches[0]
    r_lines = replacement.splitlines()
    new_lines = c_lines[:idx] + r_lines + c_lines[idx + n_t:]
    if content.endswith("\n"):
        return "\n".join(new_lines) + "\n", 1, idx + 1
    return "\n".join(new_lines), 1, idx + 1


def tool_replace_in_file(path: str, target: str, replacement: str) -> str:
    resolved = safe_resolve_path(path)
    if not resolved.is_file():
        return f"Error: File not found: {path}"
    content, eol = read_text_preserve_eol(resolved)
    target_norm = target.replace("\r\n", "\n")
    replacement_norm = replacement.replace("\r\n", "\n")

    if not target_norm:
        return "Error: 'target' must not be empty."

    count = content.count(target_norm)
    if count == 1:
        idx = content.index(target_norm)
        start_line = content[:idx].count("\n") + 1
        new_content = content.replace(target_norm, replacement_norm, 1)
    elif count > 1:
        return f"Error: Target content occurs {count} times in {path}. Include surrounding lines for unique context."
    else:
        new_content, f_count, start_line = _fuzzy_line_replace(content, target_norm, replacement_norm)
        if f_count > 1:
            return f"Error: Target content occurs {f_count} times in {path} (ignoring trailing spaces). Provide more context."
        if new_content is None:
            hint = ""
            first = next((ln.strip() for ln in target_norm.splitlines() if ln.strip()), "")
            if first:
                for i, ln in enumerate(content.splitlines(), 1):
                    if first in ln:
                        hint = f" Hint: the first line of target appears near line {i}; call read_file around line {max(1, i - 5)} first."
                        break
            return f"Error: Target content not found in {path}.{hint}"

    SESSION.backup_before_write(resolved)
    write_text_preserve_eol(resolved, new_content, eol=eol)
    SESSION.touch(path)
    end_line = start_line + replacement_norm.count("\n")
    return f"Success: Replaced target content in {path} (now lines {start_line}-{end_line})."


def tool_list_dir(path: str = ".", recursive: bool = False) -> str:
    resolved = safe_resolve_path(path)
    if not resolved.is_dir():
        return f"Error: Directory not found: {path}"
    results = []
    if recursive:
        for root, dirs, files in os.walk(resolved):
            dirs[:] = sorted(d for d in dirs if d not in IGNORED_DIRS)
            for d in dirs:
                rel = (Path(root) / d).relative_to(WORKSPACE_DIR).as_posix()
                results.append(f"[DIR]  {rel}")
            for f in sorted(files):
                if is_secret_file(f):
                    continue
                rel = (Path(root) / f).relative_to(WORKSPACE_DIR).as_posix()
                results.append(f"[FILE] {rel}")
            if len(results) >= LIST_LIMIT:
                results.append(f"... [truncated at {LIST_LIMIT} entries; list a subdirectory instead]")
                break
    else:
        for p in sorted(resolved.iterdir()):
            if p.name in IGNORED_DIRS or is_secret_file(p.name):
                continue
            rel = p.relative_to(WORKSPACE_DIR).as_posix()
            results.append(f"{'[DIR] ' if p.is_dir() else '[FILE]'} {rel}")
    return "\n".join(results) if results else "Empty directory."


def tool_find_files(pattern: str, path: str = ".") -> str:
    base = safe_resolve_path(path)
    if not base.is_dir():
        return f"Error: Directory not found: {path}"
    if not any(c in pattern for c in "*?["):
        pattern = f"*{pattern}*"
    out = []
    for root, dirs, files in os.walk(base):
        dirs[:] = sorted(d for d in dirs if d not in IGNORED_DIRS)
        for f in sorted(files):
            if is_secret_file(f):
                continue
            rel = (Path(root) / f).relative_to(WORKSPACE_DIR).as_posix()
            if fnmatch.fnmatch(rel.lower(), pattern.lower()) or fnmatch.fnmatch(f.lower(), pattern.lower()):
                out.append(rel)
                if len(out) >= 100:
                    out.append("... [truncated at 100 results]")
                    return "\n".join(out)
    return "\n".join(out) if out else "No files matched."


def _kill_process_tree(proc: subprocess.Popen):
    try:
        if os.name == "nt":
            subprocess.run(
                ["taskkill", "/F", "/T", "/PID", str(proc.pid)],
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=5,
            )
        else:
            os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
    except Exception:
        try:
            proc.kill()
        except Exception:
            pass


def tool_run_command(command: str, timeout: int = 120) -> str:
    blocked_patterns = [
        r"\brm\s+-[a-zA-Z]*r[a-zA-Z]*f?\s+/(?:\s|$)",
        r":\(\)\s*\{\s*:\|:&\s*\}\s*;:",
        r"\bdel\s+/[sS]\s+/[qQ]\s+c:\\",
        r"\bformat\s+[a-zA-Z]:",
        r"\bmkfs\.",
        r"\bdd\s+if=.*of=/dev/",
    ]
    for pat in blocked_patterns:
        if re.search(pat, command, re.I):
            return "Error: Command rejected by safety guardrail."

    timeout = max(1, min(int(timeout), 600))
    kwargs = {
        "shell": True,
        "cwd": str(WORKSPACE_DIR),
        "stdout": subprocess.PIPE,
        "stderr": subprocess.PIPE,
        "text": True,
        "encoding": "utf-8",
        "errors": "replace",
    }
    if os.name == "nt":
        kwargs["creationflags"] = getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)
    else:
        kwargs["start_new_session"] = True

    proc = None
    try:
        proc = subprocess.Popen(command, **kwargs)
        out, err = proc.communicate(timeout=timeout)
        SESSION.project_ctx_dirty = True
        return f"Exit code: {proc.returncode}\nStdout:\n{clip(out.strip(), 3500)}\nStderr:\n{clip(err.strip(), 2500)}"
    except subprocess.TimeoutExpired:
        if proc is not None:
            _kill_process_tree(proc)
        return f"Error: Command timed out after {timeout} seconds (process tree terminated)."
    except Exception as exc:
        if proc is not None:
            _kill_process_tree(proc)
        return f"Error executing command: {exc}"


def tool_grep_search(
    query: str,
    path: str = ".",
    is_regex: bool = False,
    file_pattern: str = "*",
    context: int = 0,
) -> str:
    resolved = safe_resolve_path(path)
    if not resolved.exists():
        return f"Error: Path not found: {path}"
    try:
        pattern = re.compile(query if is_regex else re.escape(query), re.IGNORECASE)
    except re.error as exc:
        return f"Error: invalid regex: {exc}"

    ctx = max(0, min(int(context), 5))

    def iter_files():
        if resolved.is_file():
            yield resolved
            return
        for root, dirs, files in os.walk(resolved):
            dirs[:] = sorted(d for d in dirs if d not in IGNORED_DIRS)
            for fn in sorted(files):
                yield Path(root) / fn

    matches = []
    for f in iter_files():
        if is_secret_file(f) or f.name in LOCK_FILES or f.suffix.lower() in BINARY_EXT:
            continue
        if file_pattern and file_pattern != "*":
            if not (fnmatch.fnmatch(f.name.lower(), file_pattern.lower())
                    or fnmatch.fnmatch(f.relative_to(WORKSPACE_DIR).as_posix().lower(), file_pattern.lower())):
                continue
        try:
            if f.stat().st_size > 1_000_000:
                continue
            lines = f.read_text(encoding="utf-8", errors="ignore").splitlines()
            rel = f.relative_to(WORKSPACE_DIR).as_posix()
            for idx, line in enumerate(lines, 1):
                if pattern.search(line):
                    if ctx == 0:
                        matches.append(f"{rel}:{idx}: {line.strip()[:200]}")
                    else:
                        s = max(1, idx - ctx)
                        e = min(len(lines), idx + ctx)
                        snippet = "\n".join(
                            f"  {'>' if i == idx else ' '} {rel}:{i}: {lines[i - 1][:180]}"
                            for i in range(s, e + 1)
                        )
                        matches.append(snippet)
                    if len(matches) >= 50:
                        matches.append("... [Output truncated at 50 matches]")
                        return "\n".join(matches)
        except OSError:
            continue
    return "\n".join(matches) if matches else "No matches found."


def tool_remember(note: str) -> str:
    note = " ".join(str(note).split())
    if not note:
        return "Error: empty note."
    ensure_state_dir()
    lines = [ln for ln in read_memory().splitlines() if ln.strip()]
    entry = f"- {note[:300]}"
    if entry in lines:
        return "Already remembered."
    lines.append(entry)
    while sum(len(ln) + 1 for ln in lines) > MEMORY_LIMIT and len(lines) > 1:
        lines.pop(0)
    MEMORY_FILE.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return "Saved to long-term memory."


def tool_update_plan(plan) -> str:
    SESSION.plan = normalize_plan(plan)
    return "Plan updated:\n" + render_plan(SESSION.plan) if SESSION.plan else "Plan cleared."


def _spec(func, description, properties, required=()):
    return {"func": func, "description": description, "properties": properties, "required": list(required)}


TOOL_SPECS = {
    "read_file": _spec(
        tool_read_file,
        f"Read a file with 1-based line numbers. Returns at most {MAX_READ_LINES} lines per call; use start_line/end_line to page.",
        {"path": {"type": "string", "description": "Relative path to file."},
         "start_line": {"type": "integer", "description": "Starting line number.", "default": 1},
         "end_line": {"type": "integer", "description": "Ending line number. Use -1 for end of file.", "default": -1}},
        ["path"]),
    "write_file": _spec(
        tool_write_file,
        "Create or overwrite a file with the given content.",
        {"path": {"type": "string", "description": "Relative path to target file."},
         "content": {"type": "string", "description": "Entire file content to write."}},
        ["path", "content"]),
    "replace_in_file": _spec(
        tool_replace_in_file,
        "Replace a unique target string in a file. Prefer this over write_file for edits.",
        {"path": {"type": "string", "description": "Relative path to target file."},
         "target": {"type": "string", "description": "Exact text to find and replace (must be unique)."},
         "replacement": {"type": "string", "description": "New text to insert."}},
        ["path", "target", "replacement"]),
    "list_dir": _spec(
        tool_list_dir,
        "List directory contents (ignores node_modules, .git, dist, ...).",
        {"path": {"type": "string", "description": "Relative directory path.", "default": "."},
         "recursive": {"type": "boolean", "description": "Whether to list recursively.", "default": False}}),
    "find_files": _spec(
        tool_find_files,
        "Find files by glob pattern (e.g. '*.tsx', 'src/**/Viewport*') or by name substring.",
        {"pattern": {"type": "string", "description": "Glob pattern or name substring."},
         "path": {"type": "string", "description": "Directory to search in.", "default": "."}},
        ["pattern"]),
    "grep_search": _spec(
        tool_grep_search,
        "Search for a text/regex across project files. Returns file:line: text (max 50 matches).",
        {"query": {"type": "string", "description": "Search term or regex."},
         "path": {"type": "string", "description": "Subdirectory or file to search.", "default": "."},
         "is_regex": {"type": "boolean", "description": "Whether query is a regex.", "default": False},
         "file_pattern": {"type": "string", "description": "Optional glob filter, e.g. '*.py' or '*.ts'.", "default": "*"},
         "context": {"type": "integer", "description": "Surrounding lines of context (0-5).", "default": 0}},
        ["query"]),
    "run_command": _spec(
        tool_run_command,
        "Run a shell command in the workspace and get exit code, stdout, stderr.",
        {"command": {"type": "string", "description": "Terminal command to run."},
         "timeout": {"type": "integer", "description": "Timeout in seconds.", "default": 120}},
        ["command"]),
    "remember": _spec(
        tool_remember,
        "Save a short durable note (conventions, architecture decisions, user preferences, gotchas) to long-term memory.",
        {"note": {"type": "string", "description": "One short fact, max ~300 chars."}},
        ["note"]),
    "update_plan": _spec(
        tool_update_plan,
        "Set the task plan for multi-step work (3+ steps). Always send the full plan; keep exactly one item in_progress.",
        {"plan": {"type": "array", "description": "Full list of plan items.",
                  "items": {"type": "object",
                            "properties": {"task": {"type": "string"},
                                           "status": {"type": "string", "enum": ["pending", "in_progress", "done"]}},
                            "required": ["task", "status"]}}},
        ["plan"]),
}

TOOLS_REGISTRY = {n: s["func"] for n, s in TOOL_SPECS.items()}
OPENAI_TOOLS = [
    {"type": "function", "function": {
        "name": n, "description": s["description"],
        "parameters": {"type": "object", "properties": s["properties"], "required": s["required"]}}}
    for n, s in TOOL_SPECS.items()
]
TOOLS_TOKENS = est_tokens(json.dumps(OPENAI_TOOLS))


def render_text_tools_prompt() -> str:
    """Fallback tool instructions for providers that reject native OpenAI `tools` schemas."""
    lines = [
        "## Tools (Text Mode)",
        "Call tools by emitting a `<tool_call>` block containing valid JSON:",
        '<tool_call>{"name": "tool_name", "arguments": {"arg1": "val1"}}</tool_call>',
        "Available tools:",
    ]
    for name, spec in TOOL_SPECS.items():
        args_desc = ", ".join(
            f"{k}: {v.get('type', 'any')}{'*' if k in spec['required'] else ''}"
            for k, v in spec["properties"].items()
        )
        lines.append(f"- `{name}({args_desc})`: {spec['description']}")
    return "\n".join(lines)


_ARG_ALIASES = {
    "path": ("file", "filepath", "file_path", "filename", "dir", "directory", "target_file"),
    "query": ("pattern", "search", "term", "regex", "text"),
    "pattern": ("glob", "query", "name", "filename"),
    "command": ("cmd", "shell", "script"),
    "target": ("old", "old_str", "old_text", "search", "find"),
    "replacement": ("new", "new_str", "new_text", "replace"),
    "content": ("text", "body", "code", "data"),
}


def coerce_args(name: str, args) -> dict:
    """Fix typical model mistakes: wrong key names, values of the wrong type."""
    props = TOOL_SPECS[name]["properties"]
    args = dict(args) if isinstance(args, dict) else {}
    # 1. Map known aliases first
    for canonical, aliases in _ARG_ALIASES.items():
        if canonical in props and canonical not in args:
            for alias in aliases:
                if alias in args and alias not in props:
                    args[canonical] = args.pop(alias)
                    break
    # 2. Map remaining unknown keys to missing required parameters
    missing = [r for r in TOOL_SPECS[name]["required"] if r not in args]
    for k in [k for k in list(args) if k not in props]:
        v = args.pop(k)
        if missing:
            args[missing.pop(0)] = v
    # 3. Coerce types
    for k, v in list(args.items()):
        t = props[k].get("type")
        try:
            if t == "integer":
                args[k] = int(str(v).strip())
            elif t == "boolean":
                args[k] = v if isinstance(v, bool) else str(v).strip().lower() in ("true", "1", "yes")
            elif t in ("array", "object") and isinstance(v, str):
                args[k] = json.loads(v)
        except ValueError:
            pass
    return args


def execute_tool(name: str, args) -> str:
    if name not in TOOL_SPECS:
        return f"Error: Unknown tool '{name}'. Available tools: {', '.join(TOOL_SPECS)}."
    args = coerce_args(name, args)
    missing = [r for r in TOOL_SPECS[name]["required"] if r not in args]
    if missing:
        return (f"Error: missing required argument(s) {missing} for {name}. "
                f"Expected arguments: {list(TOOL_SPECS[name]['properties'])}.")
    try:
        return clip(str(TOOLS_REGISTRY[name](**args)), MAX_TOOL_OUTPUT * 2)
    except Exception as exc:
        return f"Error running {name}: {exc}"

# --------------------------------------------------------------------------------------
# Text tool-call parsing (Qwen XML, Hermes JSON, fenced JSON)
# --------------------------------------------------------------------------------------

_XML_FUNC = re.compile(r"<function=([\w\-.]+)>(.*?)</function>", re.S)
_XML_PARAM = re.compile(r"<parameter=([\w\-.]+)>(.*?)</parameter>", re.S)
_HERMES = re.compile(r"<tool_call>\s*(\{.*?\})\s*</tool_call>", re.S)
_FENCE = re.compile(r"```(?:tool|tool_call|json)?\s*(\{[\s\S]*?\})\s*```")


def _trim_param(v: str) -> str:
    if v.startswith("\n"):
        v = v[1:]
    if v.endswith("\n"):
        v = v[:-1]
    return v


def parse_text_tool_calls(text: str):
    """Return (tool_calls, remaining_text). Some models print tool calls as text instead of using the API field."""
    calls = []

    def add(name, args):
        if isinstance(args, str):
            try:
                args = json.loads(args)
            except ValueError:
                args = {}
        if not isinstance(args, dict):
            args = {}
        calls.append({"id": new_call_id(), "type": "function",
                      "function": {"name": name, "arguments": json.dumps(args, ensure_ascii=False)}})

    for m in _XML_FUNC.finditer(text):
        add(m.group(1), {pm.group(1): _trim_param(pm.group(2)) for pm in _XML_PARAM.finditer(m.group(2))})
    rest = _XML_FUNC.sub("", text)

    for m in _HERMES.finditer(rest):
        try:
            obj = json.loads(m.group(1))
        except ValueError:
            continue
        name = obj.get("name") or obj.get("tool") or obj.get("function")
        if isinstance(name, str):
            add(name, obj.get("arguments") or obj.get("parameters") or obj.get("args") or {})
    rest = _HERMES.sub("", rest)

    if not calls:  # fenced JSON: only accept known tools, normal answers may contain JSON snippets
        for m in _FENCE.finditer(rest):
            try:
                obj = json.loads(m.group(1))
            except ValueError:
                continue
            name = obj.get("tool") or obj.get("function") or obj.get("action") or obj.get("name")
            if name in TOOL_SPECS:
                add(name, obj.get("parameters") or obj.get("args") or obj.get("arguments") or {})
                rest = rest.replace(m.group(0), "")

    rest = re.sub(r"</?tool_call>", "", rest).strip()
    return calls, rest

# --------------------------------------------------------------------------------------
# LLM API
# --------------------------------------------------------------------------------------

class ContextOverflow(RuntimeError):
    """The request was too large for the model / the provider's per-request limit."""


def _api_error_message(err_body: str) -> str:
    try:
        j = json.loads(err_body)
        e = j.get("error", j) if isinstance(j, dict) else j
        msg = e.get("message", err_body) if isinstance(e, dict) else str(e)
    except ValueError:
        return err_body
    if "Agent not found" in msg:
        msg += ("\nTip: in WonkaChat the model parameter is the unique Agent ID "
                "(Agents -> All Agents -> ... -> Copy link). Set WONKA_MODEL=<ID> in .env or use -m <ID>.")
    return msg


def _serialize_messages_for_text_mode(messages: list) -> list:
    """Convert native tool_calls / role=='tool' messages into plain user/assistant messages for providers without tool support."""
    out = []
    for m in messages:
        role = m.get("role")
        if role == "assistant" and m.get("tool_calls"):
            calls_txt = "\n".join(
                f'<tool_call>{json.dumps({"name": tc["function"]["name"], "arguments": json.loads(tc["function"].get("arguments") or "{}")}, ensure_ascii=False)}</tool_call>'
                for tc in m["tool_calls"]
            )
            content = ((m.get("content") or "") + "\n" + calls_txt).strip()
            out.append({"role": "assistant", "content": content})
        elif role == "tool":
            out.append({
                "role": "user",
                "content": f"[Tool Result: {m.get('name', 'tool')}]\n{m.get('content', '')}",
            })
        else:
            out.append({"role": role, "content": m.get("content") or ""})
    return out


def call_llm(base_url: str, api_key: str, model: str, messages: list, tools: list = None, retries: int = 3) -> dict:
    url = f"{base_url}/chat/completions"
    use_tools = bool(tools and CFG.get("native_tools", True))
    req_messages = messages if use_tools else _serialize_messages_for_text_mode(messages)

    payload = {"model": model, "messages": req_messages, "stream": False}
    if use_tools:
        payload["tools"] = tools
        payload["tool_choice"] = "auto"
    data = json.dumps(payload).encode("utf-8")
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
        "Accept": "application/json",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) BrowseEngine/1.1",
        "HTTP-Referer": "https://github.com/itisislom/BrowseEngine",
        "X-Title": "BrowseEngine Coding Agent",
    }
    delay = 2.0
    for attempt in range(retries + 1):
        req = request.Request(url, data=data, headers=headers, method="POST")
        try:
            with request.urlopen(req, timeout=120) as resp:
                body = resp.read().decode("utf-8")
        except error.HTTPError as exc:
            err_body = exc.read().decode("utf-8", errors="replace")
            low = err_body.lower()
            if (exc.code == 413 or "context_length" in low or "maximum context" in low
                    or "too many tokens" in low or "request too large" in low or "reduce the length" in low):
                raise ContextOverflow(_api_error_message(err_body)[:300])
            if use_tools and exc.code == 400 and ("tool" in low or "schema" in low or "function" in low):
                print(f"{YELLOW}[warn] provider rejected native tool schema; switching to text tool-calling mode{RESET}")
                CFG["native_tools"] = False
                return call_llm(base_url, api_key, model, messages, tools=None, retries=retries)
            if exc.code in (429, 500, 502, 503, 504) and attempt < retries:
                try:
                    wait = float(exc.headers.get("Retry-After", delay))
                except (TypeError, ValueError):
                    wait = delay
                wait = min(max(wait, 1.0), 30.0)
                print(f"{GRAY}[api] HTTP {exc.code}, retry in {wait:.0f}s ({attempt + 1}/{retries}){RESET}")
                time.sleep(wait)
                delay *= 2
                continue
            raise RuntimeError(f"HTTP {exc.code}: {_api_error_message(err_body)}")
        except (error.URLError, TimeoutError, ConnectionError) as exc:
            if attempt < retries:
                print(f"{GRAY}[api] network error ({exc}), retry in {delay:.0f}s{RESET}")
                time.sleep(delay)
                delay *= 2
                continue
            raise RuntimeError(f"Network error: {exc}")
        trimmed = body.strip().lower()
        if trimmed.startswith("<!doctype") or trimmed.startswith("<html"):
            raise RuntimeError(
                f"Server returned an HTML page instead of JSON from '{url}'.\n"
                "WonkaChat needs your workspace subdomain in WONKA_BASE_URL, "
                "e.g. https://<your-organization>.wonka.chat/api/agents/v1")
        try:
            return json.loads(body)
        except ValueError:
            raise RuntimeError(f"Invalid JSON from API: {body[:200]}")
    raise RuntimeError("API request failed after retries.")

# --------------------------------------------------------------------------------------
# Context manager: budget -> clear old tool output -> summarize old turns
# --------------------------------------------------------------------------------------

def msg_tokens(m: dict) -> int:
    n = len(m.get("content") or "")
    for tc in m.get("tool_calls") or []:
        fn = tc.get("function", {})
        n += len(fn.get("name", "")) + len(fn.get("arguments", ""))
    return n // 3 + 4


def total_tokens(system_text: str, history: list) -> int:
    return est_tokens(system_text) + TOOLS_TOKENS + sum(msg_tokens(m) for m in history)


def shrink_message(m: dict) -> dict:
    """Lighter copy of an old message: big tool output / big tool-call arguments are replaced by a stub."""
    if m.get("role") == "tool":
        c = m.get("content") or ""
        if len(c) > 240:
            first = next((ln.strip() for ln in c.splitlines() if ln.strip()), "")[:120]
            return {**m, "content": f"[old output cleared, {len(c)} chars: {first} ... re-run the tool if needed]"}
    elif m.get("role") == "assistant" and m.get("tool_calls"):
        new_calls = []
        for tc in m["tool_calls"]:
            fn = tc["function"]
            args = fn.get("arguments", "")
            if len(args) > 300:
                try:
                    a = json.loads(args)
                except ValueError:
                    a = None
                if isinstance(a, dict):
                    a = {k: (f"<{len(v)} chars omitted>" if isinstance(v, str) and len(v) > 200 else v)
                         for k, v in a.items()}
                    args = json.dumps(a, ensure_ascii=False)
                elif a is None:
                    args = args[:200]
            new_calls.append({**tc, "function": {**fn, "arguments": args}})
        return {**m, "tool_calls": new_calls}
    return m


def choose_cut(history: list, limit: int):
    """Earliest index where history can be cut so that the kept tail fits `limit` tokens.
    A valid cut is a user message, or an assistant message right after a tool/user message."""
    n = len(history)
    suffix = [0] * (n + 1)
    for i in range(n - 1, -1, -1):
        suffix[i] = suffix[i + 1] + msg_tokens(history[i])
    cands = [i for i in range(1, n)
             if history[i]["role"] == "user"
             or (history[i]["role"] == "assistant" and history[i - 1]["role"] in ("tool", "user"))]
    if not cands:
        return None
    for c in cands:
        if suffix[c] <= limit:
            return c
    return cands[-1]


SUMMARY_PROMPT = (
    "You compress the history of a coding-agent session into a memory note for the agent itself.\n"
    "Merge the previous summary with the new events. Write a dense summary (max ~350 words) in the "
    "language the user writes in, with these sections:\n"
    "GOAL: what the user wants overall\n"
    "DONE: what has been done (files created/changed, commands run, results)\n"
    "STATE: current state, known bugs, open problems\n"
    "FACTS: key paths, names, decisions, conventions worth keeping\n"
    "NEXT: the immediate next step\n"
    "Keep exact file paths and identifiers. No fluff, no greetings."
)


def _transcript(msgs: list, total: int = 14000) -> str:
    lines = []
    for m in msgs:
        r = m.get("role")
        if r == "user":
            lines.append("USER: " + clip(m.get("content") or "", 1400))
        elif r == "assistant":
            if m.get("content"):
                lines.append("ASSISTANT: " + clip(m["content"], 700))
            for tc in m.get("tool_calls") or []:
                lines.append(f"CALL {tc['function']['name']}({clip(tc['function'].get('arguments', ''), 240)})")
        elif r == "tool":
            lines.append("RESULT: " + clip(m.get("content") or "", 300))
    return clip("\n".join(lines), total)


def heuristic_summary(prev: str, older: list) -> str:
    users, files, cmds = [], [], []
    for m in older:
        if m.get("role") == "user":
            users.append(clip(m.get("content") or "", 160))
        for tc in m.get("tool_calls") or []:
            try:
                a = json.loads(tc["function"]["arguments"])
            except ValueError:
                continue
            if not isinstance(a, dict):
                continue
            n = tc["function"]["name"]
            if n in ("write_file", "replace_in_file") and a.get("path"):
                files.append(a["path"])
            elif n == "run_command" and a.get("command"):
                cmds.append(str(a["command"])[:80])
    parts = [prev] if prev else []
    if users:
        parts.append("User asked: " + " | ".join(users[-6:]))
    if files:
        parts.append("Changed files: " + ", ".join(dict.fromkeys(files)))
    if cmds:
        parts.append("Commands run: " + "; ".join(cmds[-6:]))
    return clip("\n".join(parts), SUMMARY_LIMIT)


def llm_summary(prev: str, older: list) -> str:
    user = f"Previous summary:\n{prev or '(none)'}\n\nNew events to merge:\n{_transcript(older)}"
    try:
        resp = call_llm(CFG["base_url"], CFG["api_key"], CFG["model"],
                        [{"role": "system", "content": SUMMARY_PROMPT}, {"role": "user", "content": user}],
                        tools=None, retries=2)
        msg = (resp.get("choices") or [{}])[0].get("message") or {}
        text = strip_think(msg.get("content") or "")
        if len(text) > 40:
            return clip(text, SUMMARY_LIMIT)
    except RuntimeError as exc:
        print(f"{YELLOW}[warn] summarizer failed ({str(exc)[:120]}), using a simple summary{RESET}")
    return heuristic_summary(prev, older)


def fit_context(sess: Session, force: bool = False):
    budget = sess.budget

    def used() -> int:
        return total_tokens(sess.system_text(), sess.history)

    if not force and used() <= budget * 0.8:
        return
    # 1. cheap and lossless-ish: clear old tool output and huge tool-call arguments
    for keep in (8, 4, 2):
        for i in range(max(0, len(sess.history) - keep)):
            sess.history[i] = shrink_message(sess.history[i])
        if not force and used() <= budget * 0.7:
            return
    # 2. summarize the older part of the dialog, keep a recent tail (~30% of the budget)
    cut = choose_cut(sess.history, int(budget * 0.3))
    if cut is None:
        return
    head = []
    if sess.history[cut]["role"] != "user":  # cut inside a long turn: keep the user's request
        u = max((i for i in range(cut) if sess.history[i]["role"] == "user"), default=None)
        if u is not None:
            head = [sess.history[u]]
        else:
            head = [{"role": "user", "content": "Continue working on the current task based on the summary."}]
    older = sess.history[:cut]
    print(f"{GRAY}[context] compacting {len(older)} old messages into a summary...{RESET}")
    sess.summary = llm_summary(sess.summary, older)
    sess.history = head + sess.history[cut:]
    repair_history(sess.history)
    # 3. last resort
    if used() > budget:
        for i in range(len(sess.history)):
            sess.history[i] = shrink_message(sess.history[i])


def show_context(sess: Session):
    sys_t = est_tokens(sess.system_text())
    hist_t = sum(msg_tokens(m) for m in sess.history)
    total = sys_t + TOOLS_TOKENS + hist_t
    print(f"Context ~{total}/{sess.budget} tokens: system {sys_t} + tools {TOOLS_TOKENS} + history {hist_t} "
          f"({len(sess.history)} msgs). Summary: {len(sess.summary)} chars, memory: {len(read_memory())} chars, "
          f"plan items: {len(sess.plan)}, backups: {len(sess.backups)}.")

# --------------------------------------------------------------------------------------
# Agent loop
# --------------------------------------------------------------------------------------

SYSTEM_PROMPT = """You are an expert autonomous software engineer working inside the user's repository through tools.

How to work:
1. Orient first. The project context and file map are given below. Use find_files / grep_search to locate code, then read only the line ranges you need. Do not re-read files that are already in the conversation.
2. For tasks with 3+ steps call update_plan first and keep it current (exactly one item in_progress). The plan is pinned in your context and survives long sessions.
3. Make minimal, precise edits (replace_in_file for small changes, write_file for new files). Never invent files, APIs or commands.
4. Verify your work: run the build / tests / linter with run_command when it makes sense (e.g. `npm run build`, `npx tsc -b`, `pytest`) and fix what you broke.
5. When you learn something durable (conventions, architecture decisions, user preferences, gotchas) save it with `remember`. Keep notes short.
6. Tool output is truncated. If something is cut, ask for a narrower range instead of repeating the same call.
7. Answer in the user's language, concisely, once the task is done: what changed and why. No filler."""


def run_agent_turn(sess: Session, max_steps: int = 40):
    recent = []
    for step in range(1, max_steps + 1):
        fit_context(sess)
        resp = None
        for _attempt in range(3):
            system_text = sess.system_text()
            messages = [{"role": "system", "content": system_text}] + sess.history
            print(f"{GRAY}[Step {step}/{max_steps}] ctx ~{total_tokens(system_text, sess.history)}/{sess.budget} tok{RESET}")
            try:
                resp = call_llm(CFG["base_url"], CFG["api_key"], CFG["model"], messages, OPENAI_TOOLS)
                break
            except ContextOverflow as exc:
                sess.budget = max(3000, int(sess.budget * 0.6))
                print(f"{YELLOW}[context] provider says the request is too large ({str(exc)[:120]}); "
                      f"budget lowered to {sess.budget} tokens{RESET}")
                fit_context(sess, force=True)
            except RuntimeError as exc:
                print(f"{RED}API Error: {exc}{RESET}")
                return
        if resp is None:
            print(f"{RED}Could not fit the request into the provider's limit. Try /clear or a smaller CONTEXT_TOKENS.{RESET}")
            return

        choices = resp.get("choices") or []
        if not choices:
            print(f"{RED}No response choices returned.{RESET}")
            return
        msg = choices[0].get("message") or {}
        content = strip_think(msg.get("content") or "")

        calls = []
        for tc in msg.get("tool_calls") or []:
            fn = tc.get("function") or {}
            a = fn.get("arguments", "{}")
            if not isinstance(a, str):
                a = json.dumps(a, ensure_ascii=False)
            calls.append({"id": tc.get("id") or new_call_id(), "type": "function",
                          "function": {"name": fn.get("name", ""), "arguments": a or "{}"}})
        if not calls and content:
            calls, content = parse_text_tool_calls(content)

        if not calls and not content:
            print(f"{YELLOW}(empty response){RESET}")
            return

        assistant = {"role": "assistant", "content": content}
        if calls:
            assistant["tool_calls"] = calls
        sess.history.append(assistant)

        if not calls:
            print(f"\n{GREEN}=== Agent Response ==={RESET}")
            print(content)
            sess.save()
            return

        if content:
            print(f"\n{YELLOW}[Thought]{RESET} {content}")

        for tc in calls:
            name = tc["function"]["name"]
            try:
                args = json.loads(tc["function"]["arguments"] or "{}")
            except ValueError:
                args = None
            print(f"{CYAN}[Tool Call]{RESET} {name}({clip(json.dumps(args, ensure_ascii=False), 200)})")
            if not isinstance(args, dict):
                result = "Error: tool arguments must be a valid JSON object."
            else:
                result = execute_tool(name, args)
                if name != "run_command":
                    sig = name + json.dumps(args, sort_keys=True, ensure_ascii=False)
                    recent = (recent + [sig])[-12:]
                    reps = recent.count(sig)
                    if reps >= 5:
                        sess.history.append({"role": "tool", "tool_call_id": tc["id"], "name": name,
                                             "content": "Error: repeated identical call, stopped."})
                        repair_history(sess.history)
                        print(f"{RED}[loop] the agent keeps repeating {name}; stopping this turn.{RESET}")
                        sess.save()
                        return
                    if reps >= 3:
                        result = ("WARNING: you already made this exact call several times. "
                                  "Change your approach.\n") + result
            preview = result[:200] + ("..." if len(result) > 200 else "")
            print(f"{BLUE}[Tool Result]{RESET} {preview}")
            sess.history.append({"role": "tool", "tool_call_id": tc["id"], "name": name, "content": result})
        sess.save()
    print(f"{YELLOW}[max steps reached] say 'continue' to go on.{RESET}")
    sess.save()


def run_user_message(sess: Session, text: str, max_steps: int):
    sess.project_ctx_dirty = True
    sess.history.append({"role": "user", "content": text})
    try:
        run_agent_turn(sess, max_steps)
    except KeyboardInterrupt:
        print(f"\n{YELLOW}[interrupted]{RESET}")
        repair_history(sess.history)
    sess.save()


def show_session_diff(sess: Session):
    if not sess.backups:
        print("(no files modified in this session yet)")
        return
    for rel, orig_bytes in sess.backups.items():
        target = WORKSPACE_DIR / rel
        old_lines = [] if orig_bytes is None else orig_bytes.decode("utf-8", errors="replace").splitlines()
        new_lines = [] if not target.is_file() else target.read_text(encoding="utf-8", errors="replace").splitlines()
        diff = list(difflib.unified_diff(old_lines, new_lines, fromfile=f"a/{rel}", tofile=f"b/{rel}", lineterm=""))
        if diff:
            print("\n".join(diff[:120]))
            if len(diff) > 120:
                print(f"{GRAY}... ({len(diff) - 120} more diff lines){RESET}")


HELP = """Commands:
  /clear          forget the dialog (long-term memory in .agent/memory.md is kept)
  /compact        force summarizing the old dialog now
  /context        show how full the context is
  /diff           show unified diff of files modified in this session
  /undo           revert the most recently modified file in this session
  /memory         show long-term memory
  /forget         clear long-term memory (.agent/memory.md)
  /plan           show the current plan
  /model <name>   show or switch the active model
  /refresh        rebuild the project context / file map
  exit            quit"""


def handle_command(line: str, sess: Session):
    parts = line.strip().split(maxsplit=1)
    cmd = parts[0].lower()
    arg = parts[1].strip() if len(parts) > 1 else ""
    if cmd == "/clear":
        sess.reset()
        sess.save()
        print("Dialog cleared.")
    elif cmd == "/compact":
        fit_context(sess, force=True)
        sess.save()
        show_context(sess)
    elif cmd == "/context":
        show_context(sess)
    elif cmd == "/diff":
        show_session_diff(sess)
    elif cmd == "/undo":
        print(sess.undo_last())
        sess.save()
    elif cmd == "/memory":
        print(read_memory() or "(memory is empty)")
    elif cmd == "/forget":
        if MEMORY_FILE.is_file():
            MEMORY_FILE.unlink()
        print("Long-term memory cleared.")
    elif cmd == "/plan":
        print(render_plan(sess.plan) or "(no plan)")
    elif cmd == "/model":
        if arg:
            CFG["model"] = arg
            CFG["native_tools"] = True
            print(f"Model switched to: {CFG['model']}")
        else:
            print(f"Current model: {CFG['model']}")
    elif cmd == "/refresh":
        sess.project_ctx = build_project_context()
        sess.project_ctx_dirty = False
        print(f"Project context rebuilt (~{est_tokens(sess.project_ctx)} tokens).")
    else:
        print(HELP)


def main():
    parser = argparse.ArgumentParser(description="BrowseEngine AI Coding Agent CLI")
    parser.add_argument("prompt", nargs="*", help="Optional initial task prompt")
    parser.add_argument("--base-url", default=BASE_URL, help="API base URL")
    parser.add_argument("--api-key", default=API_KEY, help="API key")
    parser.add_argument("-m", "--model", default=DEFAULT_MODEL, help="Model name or Agent ID")
    parser.add_argument("--max-steps", type=int, default=40, help="Max tool iterations per request")
    parser.add_argument("--context", type=int, default=CONTEXT_TOKENS, help="Context budget in tokens")
    parser.add_argument("--new", action="store_true", help="Do not resume the previous session")
    args = parser.parse_args()

    if not args.api_key:
        print(f"{RED}Error: API key is not set. Put it into .env or pass --api-key.{RESET}")
        sys.exit(1)

    CFG.update(base_url=args.base_url.rstrip("/"), api_key=args.api_key, model=args.model)
    SESSION.budget = max(3000, args.context)

    print("\033[1;34m========================================\033[0m")
    print("\033[1;34m      BrowseEngine Coding Agent CLI      \033[0m")
    print("\033[1;34m========================================\033[0m")
    print(f"Base URL : {CFG['base_url']}")
    print(f"Model    : {CFG['model']}")
    print(f"Context  : {SESSION.budget} tokens")
    print(f"Workspace: {WORKSPACE_DIR}")

    if not args.new and SESSION.load():
        print(f"Session  : resumed ({len(SESSION.history)} msgs, summary: {'yes' if SESSION.summary else 'no'}). "
              f"/clear to start over, /help for commands.")
    print()

    initial = " ".join(args.prompt).strip()
    if initial:
        run_user_message(SESSION, initial, args.max_steps)
        return

    while True:
        try:
            user_input = input(f"\033[1;32mUser>{RESET} ").strip()
        except (KeyboardInterrupt, EOFError):
            print("\nExiting.")
            break
        if not user_input:
            continue
        if user_input.lower() in ("exit", "quit"):
            break
        if user_input.startswith("/"):
            handle_command(user_input, SESSION)
            continue
        run_user_message(SESSION, user_input, args.max_steps)


if __name__ == "__main__":
    try:  # Windows consoles: ANSI colors + UTF-8 (Cyrillic)
        os.system("")
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass
    main()