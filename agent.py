import os
import sys
import json
import re
import argparse
import subprocess
from pathlib import Path
from urllib import request, error

WORKSPACE_DIR = Path(__file__).resolve().parent

def load_env(env_path: Path):
    if not env_path.is_file():
        return
    with open(env_path, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, val = line.split("=", 1)
            key = key.strip()
            val = val.strip().strip("'\"")
            if key not in os.environ:
                os.environ[key] = val

load_env(WORKSPACE_DIR / ".env")

API_KEY = os.environ.get("WONKA_API_KEY", "")
BASE_URL = os.environ.get("WONKA_BASE_URL", "https://wonka.chat/api/agents/v1").rstrip("/")
DEFAULT_MODEL = os.environ.get("WONKA_MODEL", os.environ.get("WONKA_AGENT_ID", "claude-opus-5-5"))

def safe_resolve_path(rel_path: str) -> Path:
    target = (WORKSPACE_DIR / rel_path).resolve()
    try:
        target.relative_to(WORKSPACE_DIR)
    except ValueError:
        raise PermissionError(f"Access denied: Path '{rel_path}' is outside workspace.")
    if ".git" in target.parts or target.name == ".env":
        raise PermissionError(f"Access denied: Modifying '{rel_path}' is forbidden.")
    return target

def tool_read_file(path: str, start_line: int = 1, end_line: int = -1) -> str:
    resolved = safe_resolve_path(path)
    if not resolved.is_file():
        return f"Error: File not found: {path}"
    with open(resolved, "r", encoding="utf-8", errors="replace") as f:
        lines = f.readlines()
    total = len(lines)
    s = max(1, start_line)
    e = total if end_line <= 0 else min(total, end_line)
    sliced = [f"{i}: {lines[i - 1]}" for i in range(s, e + 1)]
    return "".join(sliced)

def tool_write_file(path: str, content: str) -> str:
    resolved = safe_resolve_path(path)
    resolved.parent.mkdir(parents=True, exist_ok=True)
    with open(resolved, "w", encoding="utf-8") as f:
        f.write(content)
    return f"Success: Wrote {len(content)} characters to {path}"

def tool_replace_in_file(path: str, target: str, replacement: str) -> str:
    resolved = safe_resolve_path(path)
    if not resolved.is_file():
        return f"Error: File not found: {path}"
    with open(resolved, "r", encoding="utf-8") as f:
        content = f.read()
    count = content.count(target)
    if count == 0:
        return f"Error: Target content not found in {path}"
    if count > 1:
        return f"Error: Target content occurs {count} times in {path}. Provide unique context."
    new_content = content.replace(target, replacement, 1)
    with open(resolved, "w", encoding="utf-8") as f:
        f.write(new_content)
    return f"Success: Replaced target content in {path}"

def tool_list_dir(path: str = ".", recursive: bool = False) -> str:
    resolved = safe_resolve_path(path)
    if not resolved.is_dir():
        return f"Error: Directory not found: {path}"
    results = []
    if recursive:
        for p in resolved.rglob("*"):
            if ".git" in p.parts or "node_modules" in p.parts or ".agents" in p.parts:
                continue
            rel = p.relative_to(WORKSPACE_DIR)
            results.append(f"{'[DIR] ' if p.is_dir() else '[FILE]'} {rel.as_posix()}")
    else:
        for p in sorted(resolved.iterdir()):
            if p.name in (".git", "node_modules"):
                continue
            rel = p.relative_to(WORKSPACE_DIR)
            results.append(f"{'[DIR] ' if p.is_dir() else '[FILE]'} {rel.as_posix()}")
    return "\n".join(results) if results else "Empty directory."

def tool_run_command(command: str, timeout: int = 120) -> str:
    blocked = ["rm -rf /", ":(){ :|:& };:", "del /s /q c:\\", "format "]
    if any(b in command.lower() for b in blocked):
        return "Error: Command rejected by safety guardrail."
    try:
        proc = subprocess.run(
            command,
            shell=True,
            cwd=str(WORKSPACE_DIR),
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            timeout=timeout,
            encoding="utf-8",
            errors="replace"
        )
        out = proc.stdout.strip()
        err = proc.stderr.strip()
        return f"Exit code: {proc.returncode}\nStdout:\n{out}\nStderr:\n{err}"
    except subprocess.TimeoutExpired:
        return f"Error: Command timed out after {timeout} seconds."
    except Exception as exc:
        return f"Error executing command: {exc}"

def tool_grep_search(query: str, path: str = ".", is_regex: bool = False) -> str:
    resolved = safe_resolve_path(path)
    if not resolved.exists():
        return f"Error: Path not found: {path}"
    pattern = re.compile(query if is_regex else re.escape(query), re.IGNORECASE)
    matches = []
    files_to_check = [resolved] if resolved.is_file() else resolved.rglob("*")
    for f in files_to_check:
        if not f.is_file() or ".git" in f.parts or "node_modules" in f.parts or "dist" in f.parts:
            continue
        try:
            with open(f, "r", encoding="utf-8", errors="ignore") as handle:
                for idx, line in enumerate(handle, 1):
                    if pattern.search(line):
                        rel = f.relative_to(WORKSPACE_DIR)
                        matches.append(f"{rel.as_posix()}:{idx}: {line.strip()}")
                        if len(matches) >= 50:
                            matches.append("... [Output truncated at 50 matches]")
                            return "\n".join(matches)
        except Exception:
            continue
    return "\n".join(matches) if matches else "No matches found."

TOOLS_REGISTRY = {
    "read_file": tool_read_file,
    "write_file": tool_write_file,
    "replace_in_file": tool_replace_in_file,
    "list_dir": tool_list_dir,
    "run_command": tool_run_command,
    "grep_search": tool_grep_search,
}

OPENAI_TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "read_file",
            "description": "Read file lines with 1-based indexing.",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {"type": "string", "description": "Relative path to file."},
                    "start_line": {"type": "integer", "description": "Starting line number.", "default": 1},
                    "end_line": {"type": "integer", "description": "Ending line number. Use -1 for end of file.", "default": -1}
                },
                "required": ["path"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "write_file",
            "description": "Create or overwrite a file with given content.",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {"type": "string", "description": "Relative path to target file."},
                    "content": {"type": "string", "description": "Entire file content to write."}
                },
                "required": ["path", "content"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "replace_in_file",
            "description": "Replace a unique target string in a file.",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {"type": "string", "description": "Relative path to target file."},
                    "target": {"type": "string", "description": "Exact text to find and replace."},
                    "replacement": {"type": "string", "description": "New text to insert."}
                },
                "required": ["path", "target", "replacement"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "list_dir",
            "description": "List directory contents.",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {"type": "string", "description": "Relative directory path.", "default": "."},
                    "recursive": {"type": "boolean", "description": "Whether to list recursively.", "default": False}
                }
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "run_command",
            "description": "Run shell command in workspace and get stdout/stderr.",
            "parameters": {
                "type": "object",
                "properties": {
                    "command": {"type": "string", "description": "Terminal command to run."},
                    "timeout": {"type": "integer", "description": "Timeout in seconds.", "default": 120}
                },
                "required": ["command"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "grep_search",
            "description": "Search for pattern across project files.",
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {"type": "string", "description": "Search term or regex."},
                    "path": {"type": "string", "description": "Subdirectory or file to search.", "default": "."},
                    "is_regex": {"type": "boolean", "description": "Whether query is a regex.", "default": False}
                },
                "required": ["query"]
            }
        }
    }
]

SYSTEM_PROMPT = """You are an expert autonomous AI software engineer and coding agent.
You have direct tool access to inspect, modify, and execute commands in the repository.

Guidelines:
1. Always inspect relevant files before modifying them.
2. Make minimal, precise changes directly fulfilling user requests.
3. Validate modifications by running builds or checks when applicable (e.g. run_command 'npm run build' or 'npx tsc -b').
4. Do not invent files, APIs, or commands.
5. Answer concisely once the task is completed.
"""

def execute_tool(name: str, args: dict) -> str:
    func = TOOLS_REGISTRY.get(name)
    if not func:
        return f"Error: Unknown tool '{name}'."
    try:
        return str(func(**args))
    except Exception as exc:
        return f"Error running {name}: {exc}"

def call_wonka_api(base_url: str, api_key: str, model: str, messages: list, tools: list = None) -> dict:
    url = f"{base_url}/chat/completions"
    payload = {
        "model": model,
        "messages": messages,
        "stream": False
    }
    if tools:
        payload["tools"] = tools
        payload["tool_choice"] = "auto"
    
    data = json.dumps(payload).encode("utf-8")
    req = request.Request(
        url,
        data=data,
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
            "Accept": "application/json"
        },
        method="POST"
    )
    try:
        with request.urlopen(req, timeout=90) as resp:
            body = resp.read().decode("utf-8")
            trimmed = body.strip().lower()
            if trimmed.startswith("<!doctype") or trimmed.startswith("<html"):
                raise RuntimeError(
                    f"Server returned an HTML web page instead of a JSON API response from '{url}'.\n"
                    "WonkaChat requires your organization workspace subdomain in WONKA_BASE_URL.\n"
                    "Example: https://<your-organization>.wonka.chat/api/agents/v1"
                )
            return json.loads(body)
    except error.HTTPError as exc:
        err_body = exc.read().decode("utf-8", errors="replace")
        try:
            err_json = json.loads(err_body)
            msg = err_json.get("error", {}).get("message", err_body)
            if "Agent not found" in msg:
                msg += (
                    "\nTip: In WonkaChat, the model parameter is the unique Agent ID.\n"
                    "Go to Agents -> All Agents in WonkaChat, click ⋯ next to your agent, select 'Copy link'.\n"
                    "The URL format is: https://islom-2.wonka.chat/c/new?agent_id=<ID>\n"
                    "Set WONKA_MODEL=<ID> in .env or run with -m <ID>."
                )
            raise RuntimeError(f"HTTP {exc.code}: {msg}")
        except json.JSONDecodeError:
            raise RuntimeError(f"HTTP {exc.code}: {err_body}")
    except RuntimeError:
        raise
    except Exception as exc:
        raise RuntimeError(f"Network error: {exc}")

def extract_fallback_tool_calls(text: str) -> list:
    blocks = re.findall(r"```(?:tool|json)?\s*({[\s\S]*?})\s*```", text)
    calls = []
    for block in blocks:
        try:
            parsed = json.loads(block)
            name = parsed.get("tool") or parsed.get("function") or parsed.get("action")
            args = parsed.get("parameters") or parsed.get("args") or parsed.get("arguments") or {}
            if name in TOOLS_REGISTRY:
                calls.append({"id": f"fallback_{len(calls)}", "function": {"name": name, "arguments": json.dumps(args)}})
        except Exception:
            continue
    return calls

def run_agent_turn(messages: list, base_url: str, api_key: str, model: str, max_steps: int = 25):
    for step in range(1, max_steps + 1):
        print(f"\033[90m[Step {step}/{max_steps}] Requesting completion...\033[0m")
        try:
            resp = call_wonka_api(base_url, api_key, model, messages, OPENAI_TOOLS)
        except RuntimeError as exc:
            print(f"\033[91mAPI Error: {exc}\033[0m")
            return

        choices = resp.get("choices", [])
        if not choices:
            print("\033[91mNo response choices returned.\033[0m")
            return

        choice = choices[0]
        msg = choice.get("message", {})
        messages.append(msg)
        content = msg.get("content") or ""

        tool_calls = msg.get("tool_calls") or []
        if not tool_calls and content:
            fallback = extract_fallback_tool_calls(content)
            if fallback:
                tool_calls = fallback

        if not tool_calls:
            print("\n\033[92m=== Agent Response ===\033[0m")
            print(content.strip())
            return

        if content.strip():
            print(f"\n\033[93m[Thought]\033[0m {content.strip()}")

        for tc in tool_calls:
            fn = tc.get("function", {})
            name = fn.get("name")
            call_id = tc.get("id", "call_default")
            raw_args = fn.get("arguments", "{}")
            try:
                args = json.loads(raw_args) if isinstance(raw_args, str) else raw_args
            except Exception:
                args = {}

            print(f"\033[96m[Tool Call]\033[0m {name}({json.dumps(args, ensure_ascii=False)})")
            result = execute_tool(name, args)
            preview = result[:200] + ("..." if len(result) > 200 else "")
            print(f"\033[94m[Tool Result]\033[0m {preview}")

            messages.append({
                "role": "tool",
                "tool_call_id": call_id,
                "name": name,
                "content": result
            })

def main():
    parser = argparse.ArgumentParser(description="WonkaChat AI Coding Agent CLI")
    parser.add_argument("prompt", nargs="*", help="Optional initial task prompt")
    parser.add_argument("--base-url", default=BASE_URL, help="WonkaChat Base URL")
    parser.add_argument("--api-key", default=API_KEY, help="WonkaChat API Key")
    parser.add_argument("-m", "--model", default=DEFAULT_MODEL, help="Agent ID or model name (e.g. claude-opus-5-5)")
    parser.add_argument("--max-steps", type=int, default=25, help="Max tool execution iterations")
    args = parser.parse_args()

    key = args.api_key
    if not key:
        print("\033[91mError: WONKA_API_KEY is not set.\033[0m")
        print("Please set WONKA_API_KEY in your .env file or pass via --api-key.")
        sys.exit(1)

    print("\033[1;34m========================================\033[0m")
    print("\033[1;34m       WonkaChat Coding Agent CLI       \033[0m")
    print("\033[1;34m========================================\033[0m")
    print(f"Base URL : {args.base_url}")
    print(f"Model    : {args.model}")
    print(f"Workspace: {WORKSPACE_DIR}\n")

    initial_prompt = " ".join(args.prompt).strip()
    history = [{"role": "system", "content": SYSTEM_PROMPT}]

    if initial_prompt:
        history.append({"role": "user", "content": initial_prompt})
        run_agent_turn(history, args.base_url, key, args.model, args.max_steps)
        return

    while True:
        try:
            user_input = input("\033[1;32mUser>\033[0m ").strip()
        except (KeyboardInterrupt, EOFError):
            print("\nExiting.")
            break
        if not user_input:
            continue
        if user_input.lower() in ("exit", "quit"):
            break
        history.append({"role": "user", "content": user_input})
        run_agent_turn(history, args.base_url, key, args.model, args.max_steps)

if __name__ == "__main__":
    main()
