#!/usr/bin/env python3
"""
cwl-view.py — Pi Context Window Lifecycle trace viewer

Usage:
    python3 packages/coding-agent/scripts/cwl-view.py <session-file.json> [options]

Options:
    --view full|active   Which message stream to render (default: active)
    --no-text            Hide text/reasoning body (show headers only)
    --no-tool-output     Hide tool output payloads
    --todo-only          Show only todo delimiters and surrounding steps
    --width N            Terminal width override
"""

import json
import sys
import os
import argparse
import textwrap
from datetime import datetime, timezone

# ── ANSI colour helpers ────────────────────────────────────────────────────────

RESET = "\033[0m"
BOLD = "\033[1m"
DIM = "\033[2m"
ITALIC = "\033[3m"


def _c(code: str, text: str) -> str:
    return f"\033[{code}m{text}{RESET}"


def fg(r, g, b, text):
    return f"\033[38;2;{r};{g};{b}m{text}{RESET}"


def bg(r, g, b, text):
    return f"\033[48;2;{r};{g};{b}m{text}{RESET}"


def bold(t):
    return f"{BOLD}{t}{RESET}"


def dim(t):
    return f"{DIM}{t}{RESET}"


# Palette derived from packages/coding-agent/src/modes/interactive/theme/dark.json
C_SESSION = (216, 119, 87)  # primary
C_USER = (88, 132, 88)  # green
C_ASST = (156, 135, 246)  # chart2
C_STEP = (27, 126, 222)  # ring
C_REASONING = (250, 248, 241)  # cardForeground
C_TEXT = (228, 228, 228)  # popoverForeground
C_TOOL = (178, 86, 48)  # chart5
C_TODO = (216, 119, 87)  # primary
C_CHUNK = (27, 126, 222)  # ring
C_SYSTEM = (183, 181, 166)  # mutedForeground
C_TOKENS = (183, 181, 166)  # mutedForeground
C_CACHE_R = (27, 126, 222)  # ring
C_CACHE_W = (156, 135, 246)  # chart2
C_WARN = (241, 68, 68)  # destructive
C_SNAPSHOT = (81, 80, 74)  # input

# ── Helpers ────────────────────────────────────────────────────────────────────


def ts(ms: int) -> str:
    dt = datetime.fromtimestamp(ms / 1000, tz=timezone.utc).astimezone()
    return dt.strftime("%H:%M:%S.") + f"{(ms % 1000):03d}"


def duration_ms(start_ms: int, end_ms: int) -> str:
    d = end_ms - start_ms
    if d < 1000:
        return f"{d}ms"
    return f"{d / 1000:.2f}s"


def bar(pct: float, width: int = 20, warn_at: float = 80.0) -> str:
    filled = int(width * pct / 100)
    color = C_WARN if pct >= warn_at else (C_CACHE_R if pct < 50 else C_REASONING)
    b = "█" * filled + "░" * (width - filled)
    return fg(*color, b) + dim(f" {pct:.1f}%")


def wrap(text: str, indent: int, width: int) -> str:
    prefix = " " * indent
    return textwrap.fill(
        text, width=width, initial_indent=prefix, subsequent_indent=prefix
    )


def hline(char: str = "─", width: int = 80, color=None) -> str:
    line = char * width
    return fg(*color, line) if color else dim(line)


def tok_str(t: dict) -> str:
    total = t.get("total", 0)
    inp = t.get("input", 0)
    out = t.get("output", 0)
    reas = t.get("reasoning", 0)
    cr = t.get("cache", {}).get("read", 0)
    cw = t.get("cache", {}).get("write", 0)
    parts = [
        fg(*C_TOKENS, f"total={total:,}"),
        dim("  in=") + fg(*C_TOKENS, f"{inp:,}"),
        dim("  out=") + fg(*C_TOKENS, f"{out:,}"),
    ]
    if reas:
        parts.append(dim("  think=") + fg(*C_REASONING, f"{reas:,}"))
    if cr:
        parts.append(dim("  cache_r=") + fg(*C_CACHE_R, f"{cr:,}"))
    if cw:
        parts.append(dim("  cache_w=") + fg(*C_CACHE_W, f"{cw:,}"))
    return "".join(parts)


def todo_icon(status: str) -> str:
    if status == "completed":
        return fg(*C_USER, "✓")
    if status == "in_progress":
        return fg(*C_REASONING, "▶")
    if status == "pending":
        return dim("○")
    return dim("?")


def todo_status(todo: dict) -> str:
    status = todo.get("status", "")
    pri = todo.get("priority", "")
    extra = f"  [{pri}]" if pri else ""
    return f"{todo_icon(status)} {todo.get('content', '')}{dim(extra)}"


def render_paths(paths: list, indent: str = "  "):
    if not paths:
        print(dim(f"{indent}(none)"))
        return
    for item in paths:
        print(dim(f"{indent}- {item}"))


def render_changes(items: list, indent: str = "  "):
    if not items:
        print(dim(f"{indent}(none)"))
        return
    for ch in items:
        frm = ch.get("from") or {}
        to = ch.get("to") or {}
        cid = ch.get("id", "")
        act = ch.get("action", "")
        content = (to or frm).get("content", cid)
        state = ""
        if frm.get("status") or to.get("status"):
            left = frm.get("status", "∅")
            right = to.get("status", "∅")
            state = f" {dim('[' + left + ' → ')}{fg(*C_USER, right)}{dim(']')}"
        print(f"{indent}· {content}{state} {dim(act)}")
        msg = ch.get("msg", "")
        part = ch.get("part", "")
        if msg or part:
            detail = "  ".join(
                x
                for x in [f"msg={msg}" if msg else "", f"part={part}" if part else ""]
                if x
            )
            print(dim(f"{indent}  {detail}"))


def chunk_line(item: dict) -> str:
    chunk = item.get("chunk") or item
    act = item.get("action", "start")
    name = chunk.get("name", "chunk")
    kind = chunk.get("type", "?")
    deps = chunk.get("dependencies") or chunk.get("dependency")
    if isinstance(deps, str):
        deps = [deps]
    dep = ",".join(deps) if deps else ""
    return f"{act} [{kind}] {name}" + (f"  dep={dep}" if dep else "")


def system_message(msg: dict) -> bool:
    info = msg.get("info") or {}
    if info.get("role") != "user":
        return False
    parts = msg.get("parts") or []
    text = [part for part in parts if part.get("type") == "text"]
    if not text:
        return False
    for part in text:
        meta = part.get("metadata") or {}
        if not part.get("synthetic"):
            return False
        if meta.get("cwl") is True:
            continue
        if "<sticky-note>" in part.get("text", ""):
            continue
        return False
    return True


def render_boundaries(items: list, indent: str = "  "):
    if not items:
        print(dim(f"{indent}(none)"))
        return
    for item in items:
        print(f"{indent}· {chunk_line(item)}")
        msg = item.get("msg", "")
        part = item.get("part", "")
        if msg or part:
            detail = "  ".join(
                x
                for x in [f"msg={msg}" if msg else "", f"part={part}" if part else ""]
                if x
            )
            print(dim(f"{indent}  {detail}"))


def cleanup_summary_line(cleanup: dict) -> str:
    removed = cleanup.get("tokensRemoved", 0)
    before = cleanup.get("tokensBefore", 0)
    after = cleanup.get("tokensAfter", 0)
    threshold = cleanup.get("threshold", 0)
    evicted = cleanup.get("evictedChunks", 0)
    paths = cleanup.get("notedFilePaths", 0)
    util = cleanup.get("utilization") or {}
    ub = util.get("before")
    ua = util.get("after")
    util_s = (
        f"  util={ub:.1f}%→{ua:.1f}%"
        if isinstance(ub, (int, float)) and isinstance(ua, (int, float))
        else ""
    )
    return (
        f"removed={removed:,}  tokens={before:,}→{after:,}  threshold={threshold:,}"
        f"  chunks={evicted}  paths={paths}{util_s}"
    )


def render_cleanup(name: str, cleanup: dict | None):
    print(fg(*C_WARN, f"  {name}"))
    if not cleanup:
        print(dim("    (none)"))
        print()
        return

    seq = cleanup.get("sequence")
    time = cleanup.get("time") or ""
    if seq or time:
        bits = []
        if seq:
            bits.append(f"run #{seq}")
        if time:
            bits.append(time)
        print(dim("    " + "  ".join(bits)))

    print(dim("    " + cleanup_summary_line(cleanup)))

    stats = cleanup.get("stats") or {}
    removed = stats.get("removed") or {}
    print(
        dim(
            "    "
            + "  ".join(
                [
                    f"steps={stats.get('steps', 0)}",
                    f"assistant={removed.get('assistantMessages', 0)}",
                    f"tool_calls={removed.get('toolCalls', 0)}",
                    f"tool_results={removed.get('toolResults', 0)}",
                    f"thinking={removed.get('thinkingBlocks', 0)}",
                ]
            )
        )
    )

    step_breakdown = stats.get("stepBreakdown") or {}
    if step_breakdown:
        order = [
            "thinking",
            "search_tools",
            "bash_tools",
            "read_tools",
            "entire_chunk",
        ]
        bits = [
            f"{key}={step_breakdown.get(key, 0)}"
            for key in order
            if step_breakdown.get(key, 0)
        ]
        if bits:
            print(dim("    steps: " + "  ".join(bits)))

    tool_counts = stats.get("toolCallCounts") or {}
    if tool_counts:
        print(dim("    tool calls:"))
        for name, count in sorted(tool_counts.items()):
            print(dim(f"      - {name}: {count}"))

    file_paths = stats.get("filePaths") or []
    if file_paths:
        print(dim(f"    file paths ({len(file_paths)}):"))
        for path in file_paths[:12]:
            print(dim(f"      - {path}"))
        if len(file_paths) > 12:
            print(dim(f"      … +{len(file_paths) - 12} more"))

    chunks = stats.get("chunks") or []
    print(fg(*C_CHUNK, f"    CHUNK DETAILS  ({len(chunks)})"))
    if not chunks:
        print(dim("      (none)"))
        print()
        return

    for chunk in chunks:
        chunk_name = chunk.get("chunkName", "chunk")
        chunk_kind = chunk.get("chunkKind", "?")
        deps = chunk.get("dependencies") or []
        dep_s = f"  dep={','.join(deps)}" if deps else ""
        full = "  fully_removed" if chunk.get("fullyRemoved") else ""
        print(
            f"      · {fg(*C_CHUNK, '[' + str(chunk_kind) + ']')} {chunk_name}{dep_s}{dim(full)}"
        )
        steps = chunk.get("steps") or []
        if not steps:
            print(dim("        (no steps)"))
            continue
        for idx, step in enumerate(steps, start=1):
            label = step.get("step", "?")
            before = step.get("tokensBefore", 0)
            after = step.get("tokensAfter", 0)
            removed_tok = max(0, before - after)
            print(
                dim(
                    f"        [{idx}] {label}  tokens={before:,}→{after:,}"
                    f"  removed={removed_tok:,}"
                )
            )
            print(
                dim(
                    "             "
                    + "  ".join(
                        [
                            f"assistant={step.get('removedAssistantMessages', 0)}",
                            f"tool_calls={step.get('removedToolCalls', 0)}",
                            f"tool_results={step.get('removedToolResults', 0)}",
                            f"thinking={step.get('removedThinkingBlocks', 0)}",
                        ]
                    )
                )
            )
            counts = step.get("toolCallCounts") or {}
            if counts:
                counts_s = ", ".join(
                    f"{tool}={count}" for tool, count in sorted(counts.items())
                )
                print(dim(f"             tools: {counts_s}"))
            removed_paths = step.get("removedFilePaths") or []
            if removed_paths:
                for path in removed_paths[:8]:
                    print(dim(f"             path: {path}"))
                if len(removed_paths) > 8:
                    print(dim(f"             … +{len(removed_paths) - 8} more paths"))
    print()


def render_transcript(trace: list, width: int):
    print(fg(*C_STEP, f"  TRACE TRANSCRIPT  ({len(trace)} entries)"))
    if not trace:
        print(dim("    (none)"))
        print()
        return
    for i, msg in enumerate(trace):
        role = "system" if system_message(msg) else msg.get("role", "?")
        color = C_SYSTEM if role == "system" else (C_USER if role == "user" else C_ASST)
        mid = msg.get("id", "")
        parts = msg.get("parts") or []
        kinds = [
            part.get("type", "?")
            if part.get("type") != "tool"
            else f"tool:{part.get('tool', '?')}"
            for part in parts
        ]
        kinds_str = ", ".join(kinds[:8])
        if len(kinds) > 8:
            kinds_str += f", … +{len(kinds) - 8}"
        print(f"  [{i:02d}] {fg(*color, role):8s} {mid} {dim(kinds_str)}")
        for j, part in enumerate(parts):
            ptype = part.get("type", "")
            if ptype == "text":
                text = part.get("text", "")
                head = text.splitlines()[0] if text else ""
                if len(head) > width - 16:
                    head = head[: width - 19] + "..."
                synthetic = " synthetic" if part.get("synthetic") else ""
                print(dim(f"      [{j:02d}] text{synthetic}: {head}"))
                continue
            if ptype == "reasoning":
                text = part.get("text", "")
                head = text.splitlines()[0] if text else "[encrypted / empty]"
                if len(head) > width - 16:
                    head = head[: width - 19] + "..."
                print(dim(f"      [{j:02d}] reasoning: {head}"))
                continue
            if ptype == "tool":
                state = part.get("state") or {}
                print(
                    dim(
                        f"      [{j:02d}] tool:{part.get('tool', '?')} status={state.get('status', '')}"
                    )
                )
                continue
            print(dim(f"      [{j:02d}] {ptype}"))
    print()


def build_compaction_runs(
    messages: list, evicted: set, changes: list, boundaries: list
):
    by_msg = {}
    for ch in changes:
        mid = ch.get("msg", "")
        if not mid:
            continue
        by_msg.setdefault(mid, []).append(ch)

    by_boundary = {}
    for item in boundaries:
        mid = item.get("msg", "")
        if not mid:
            continue
        by_boundary.setdefault(mid, []).append(item)

    runs = {}
    i = 0
    while i < len(messages):
        mid = messages[i]["info"].get("id", "")
        if mid not in evicted:
            i += 1
            continue
        j = i
        rows = []
        ids = []
        while j < len(messages):
            cur = messages[j]["info"].get("id", "")
            if cur not in evicted:
                break
            ids.append(cur)
            rows.extend(by_msg.get(cur, []))
            j += 1
        marks = []
        for cur in ids:
            marks.extend(by_boundary.get(cur, []))
        runs[i] = {"count": j - i, "ids": ids, "changes": rows, "boundaries": marks}
        i = j
    return runs


def render_compaction_run(run: dict, width: int):
    print()
    print(hline("━", width, C_WARN))
    print(
        fg(*C_WARN, bold("  COMPACTION"))
        + dim(f"  evicted_messages={run['count']}")
        + dim(f"  evicted_todo_changes={len(run['changes'])}")
        + dim(f"  evicted_chunk_boundaries={len(run['boundaries'])}")
    )
    if run["changes"]:
        render_changes(run["changes"], "    ")
    else:
        print(dim("    no todo changes tied to this evicted segment"))
    if run["boundaries"]:
        print()
        render_boundaries(run["boundaries"], "    ")
    else:
        print(dim("    no chunk boundaries tied to this evicted segment"))
    print(hline("━", width, C_WARN))
    print()


# ── Renderers ─────────────────────────────────────────────────────────────────


def render_session_header(data: dict, width: int):
    sid = data["sessionID"]
    model = data["model"]
    usage = data["usage"]
    comp = data["compaction"]

    print(hline("═", width, C_SESSION))
    print(fg(*C_SESSION, bold(f"  SESSION  {sid}")))
    print(hline("═", width, C_SESSION))
    print()

    # Model
    mlim = model["limit"]
    print(
        fg(*C_SESSION, "  MODEL")
        + "  "
        + bold(model["name"])
        + dim(f"  ({model['id']})  provider={model['providerID']}")
    )
    limit_parts = [
        dim("  limits:"),
        f"  context={mlim.get('context', 0):,}",
        f"  input={mlim.get('input', 0):,}",
    ]
    if "output" in mlim:
        limit_parts.append(f"  output={mlim['output']:,}")
    if "reserved" in mlim:
        limit_parts.append(f"  reserved={mlim['reserved']:,}")
    if "usable" in mlim:
        limit_parts.append(fg(*C_WARN, f"  usable={mlim['usable']:,}"))
    print("".join(limit_parts))
    print()

    # Usage
    ex = usage["exact"]
    pct_c = usage["pct"]["context"]
    pct_i = usage["pct"]["input"]
    pct_u = usage["pct"]["usable"]
    print(fg(*C_SESSION, "  USAGE") + f"  source={usage['source']}")
    print(f"  ctx    {bar(pct_c, 30, 80)}  ({ex:,} / {mlim['context']:,})")
    print(f"  input  {bar(pct_i, 30, 80)}  ({ex:,} / {mlim['input']:,})")
    print(f"  usable {bar(pct_u, 30, 80)}  ({ex:,} / {mlim['usable']:,})")
    print()

    # Compaction
    comp_auto = comp.get("auto", False)
    comp_res = comp.get("reserved", 0)
    comp_flag = fg(*C_WARN, "AUTO=ON ") if comp_auto else dim("auto=off")
    print(fg(*C_SESSION, "  COMPACTION") + f"  {comp_flag}  reserved={comp_res:,}")
    cwl_max = comp.get("max") or (data.get("trace") or {}).get("threshold", {}).get(
        "max", 0
    )
    if cwl_max:
        print(dim(f"  cwl_max={cwl_max:,}"))
    print()


def render_last(last: dict, width: int):
    print(hline("─", width, C_STEP))
    print(fg(*C_STEP, "  LATEST STATE"))

    for role, info in last.items():
        if not isinstance(info, dict):
            continue
        status = info.get("status", "")
        t = info.get("time", {}).get("created", 0)
        model = info.get("model", {})
        color = C_USER if role == "user" else C_ASST
        agent = info.get("agent", "")
        variant = info.get("variant", "")
        print(
            f"  {fg(*color, role):20s}  {ts(t)}  {dim(model.get('modelID', ''))}  {dim(agent)}/{dim(variant)}  {dim(status)}"
        )

    print()


def render_todo_delimiter(tool_part: dict, msg_index: int, step_index: int, width: int):
    """Render a todowrite call as a prominent delimiter."""
    state = tool_part.get("state", {})
    inp = state.get("input", {})
    todos = inp.get("todos", [])
    output = state.get("output", "")

    print()
    print(hline("━", width, C_TODO))
    print(
        fg(*C_TODO, bold(f"  TODO CHECKPOINT"))
        + dim(f"  msg[{msg_index}] step[{step_index}]")
        + dim(f"  call={tool_part.get('callID', '')}")
    )
    print()

    STATUS_ICONS = {
        "completed": fg(*C_USER, "✓"),
        "in_progress": fg(*C_REASONING, "▶"),
        "pending": dim("○"),
    }

    for todo in todos:
        icon = STATUS_ICONS.get(todo.get("status", ""), "?")
        pri = todo.get("priority", "")
        content = todo.get("content", "")
        pri_col = C_WARN if pri == "high" else C_TOKENS
        print(f"  {icon}  [{fg(*pri_col, pri):20s}]  {content}")

    if output:
        print()
        for line in output.strip().splitlines():
            print(dim(f"    → {line}"))

    # Show changes if any
    meta = state.get("metadata", {})
    changes = meta.get("changes", [])
    if changes:
        print()
        print(dim(f"  changes:"))
        for ch in changes:
            frm = ch.get("from", {})
            to = ch.get("to", {})
            cid = ch.get("id", "")[:18]
            act = ch.get("action", "")
            if frm.get("status") != to.get("status"):
                print(
                    dim(f"    {act} {cid}  status: {frm.get('status')} → ")
                    + fg(*C_USER, to.get("status", ""))
                )

    print(hline("━", width, C_TODO))
    print()


def render_chunk_delimiter(
    tool_part: dict, msg_index: int, step_index: int, width: int
):
    """Render a delimiter call as a prominent chunk boundary."""
    state = tool_part.get("state", {})
    meta = state.get("metadata", {})
    event = meta.get("event") or {}
    chunk = event.get("chunk") or {}
    act = event.get("action") or state.get("input", {}).get("action", "start")
    name = chunk.get("name", "chunk")
    kind = chunk.get("type", "?")
    deps = chunk.get("dependencies") or chunk.get("dependency")
    if isinstance(deps, str):
        deps = [deps]
    active = meta.get("active")

    print()
    print(hline("━", width, C_CHUNK))
    print(
        fg(*C_CHUNK, bold("  CHUNK BOUNDARY"))
        + dim(f"  msg[{msg_index}] step[{step_index}]")
        + dim(f"  call={tool_part.get('callID', '')}")
    )
    print()
    print(f"  {fg(*C_CHUNK, act.upper()):8s}  {bold(name)}  {dim('type=')}{kind}")
    if deps:
        print(f"  {dim('depends on:')} {fg(*C_CHUNK, ','.join(deps))}")
    if active:
        print(f"  {dim('active now:')} {chunk_line(active)}")

    out = state.get("output", "")
    if out:
        print()
        for line in str(out).strip().splitlines():
            print(dim(f"    → {line}"))

    print(hline("━", width, C_CHUNK))
    print()


def render_tool_call(
    part: dict, msg_index: int, step_index: int, show_output: bool, width: int
) -> bool:
    """Returns True if this tool is rendered elsewhere as a delimiter."""
    tool = part.get("tool", "")
    call_id = part.get("callID", "")
    state = part.get("state", {})
    status = state.get("status", "")
    timing = state.get("time", {})

    if tool in ("todowrite", "delimiter"):
        return True  # caller handles rendering

    # Generic tool
    dur = ""
    if timing.get("start") and timing.get("end"):
        dur = duration_ms(timing["start"], timing["end"])

    status_col = C_USER if status == "completed" else C_WARN
    print(
        fg(*C_TOOL, f"  ┌─ TOOL  {tool}")
        + dim(f"  call={call_id}")
        + fg(*status_col, f"  [{status}]")
        + (dim(f"  {dur}") if dur else "")
    )

    # Input
    inp = state.get("input", {})
    if inp:
        inp_json = json.dumps(inp)
        if len(inp_json) <= width - 12:
            print(dim("  │  in:  ") + fg(*C_TEXT, inp_json))
        else:
            print(dim("  │  in:"))
            for line in json.dumps(inp, indent=2).splitlines():
                print(dim("  │    ") + fg(*C_TEXT, line))

    # Output
    if show_output:
        out = state.get("output", "")
        if out:
            lines = str(out).splitlines()
            max_lines = 30
            print(dim(f"  │  out:"))
            for ln in lines[:max_lines]:
                print(dim("  │    ") + dim(ln))
            if len(lines) > max_lines:
                print(dim(f"  │    … ({len(lines) - max_lines} more lines)"))

    print(fg(*C_TOOL, "  └─"))
    return False


def render_message(
    msg: dict,
    msg_index: int,
    view: str,
    show_text: bool,
    show_tool_output: bool,
    width: int,
    evicted_ids=None,
):
    info = msg["info"]
    parts = msg["parts"]
    role = info.get("role", "?")
    model_id = info.get("modelID", "")
    finish = info.get("finish", "")
    tokens = info.get("tokens", {})
    time_i = info.get("time", {})
    created = time_i.get("created", 0)
    completed = time_i.get("completed", 0)
    msg_id = info.get("id", "")
    parent_id = info.get("parentID", "")

    if system_message(msg):
        role = "system"
        color = C_SYSTEM
    else:
        color = C_USER if role == "user" else C_ASST

    dur = duration_ms(created, completed) if created and completed else ""

    print(hline("─", width))
    hdr = (
        fg(*color, bold(f"  [{msg_index:02d}] {role.upper()}"))
        + dim(f"  {msg_id}")
        + (dim(f"  parent={parent_id}") if parent_id else "")
        + (f"  {dim('model=') + bold(model_id)}" if model_id else "")
    )
    if evicted_ids and msg_id in evicted_ids:
        hdr += f"  {fg(*C_WARN, '[EVICTED]')}"
    print(hdr)

    if created:
        time_line = (
            dim(f"  time:  {ts(created)}")
            + (f" → {ts(completed)}" if completed else "")
            + (f"  {dim(dur)}" if dur else "")
            + (f"  finish={fg(*C_WARN, finish)}" if finish else "")
        )
        print(time_line)

    if tokens:
        print(f"  tok:   {tok_str(tokens)}")

    agent = info.get("agent", "")
    variant = info.get("variant", "")
    if agent or variant:
        print(dim(f"  agent: {agent}  variant={variant}"))

    print()

    step_index = 0
    for part in parts:
        ptype = part.get("type", "")

        if ptype == "step-start":
            snap = part.get("snapshot", "")
            print(
                fg(*C_STEP, f"  ▶ step-start")
                + (dim(f"  snap={snap[:12]}") if snap else "")
            )
            step_index += 1

        elif ptype == "step-finish":
            reason = part.get("reason", "")
            snap = part.get("snapshot", "")
            stok = part.get("tokens", {})
            cost = part.get("cost", None)
            print(
                fg(*C_STEP, f"  ■ step-finish")
                + (f"  reason={fg(*C_WARN, reason)}" if reason else "")
                + (dim(f"  snap={snap[:12]}") if snap else "")
            )
            if stok:
                print(
                    f"     {tok_str(stok)}"
                    + (dim(f"  cost=${cost:.6f}") if cost else "")
                )

        elif ptype == "reasoning":
            text = part.get("text", "")
            t = part.get("time", {})
            dur2 = (
                duration_ms(t["start"], t["end"])
                if t.get("start") and t.get("end")
                else ""
            )
            print(
                fg(*C_REASONING, "  ◈ REASONING") + (dim(f"  [{dur2}]") if dur2 else "")
            )
            if text and show_text:
                wrapped = textwrap.fill(
                    text,
                    width=width - 6,
                    initial_indent="    ",
                    subsequent_indent="    ",
                )
                print(fg(*C_REASONING, wrapped))
            elif not text:
                print(dim("    [encrypted / empty]"))

        elif ptype == "text":
            t = part.get("time", {})
            meta = part.get("metadata", {})
            phase = ""
            for provider_data in meta.values():
                if isinstance(provider_data, dict):
                    phase = provider_data.get("phase", "")
                    break
            dur2 = (
                duration_ms(t["start"], t["end"])
                if t.get("start") and t.get("end")
                else ""
            )
            print(
                fg(*C_TEXT, "  ✎ TEXT")
                + (dim(f"  phase={phase}") if phase else "")
                + (dim(f"  [{dur2}]") if dur2 else "")
            )
            text = part.get("text", "")
            if text and show_text:
                wrapped = textwrap.fill(
                    text,
                    width=width - 6,
                    initial_indent="    ",
                    subsequent_indent="    ",
                )
                print(dim(wrapped))

        elif ptype == "tool":
            tool_name = part.get("tool", "")
            if tool_name == "todowrite":
                render_todo_delimiter(part, msg_index, step_index, width)
            elif tool_name == "delimiter":
                render_chunk_delimiter(part, msg_index, step_index, width)
            else:
                render_tool_call(part, msg_index, step_index, show_tool_output, width)

        else:
            print(dim(f"  ? {ptype}"))


def render_trace(trace: dict, width: int):
    print()
    print(hline("═", width, C_SESSION))
    print(fg(*C_SESSION, "  CWL TRACE"))
    print(hline("─", width))

    threshold = trace.get("threshold") or {}
    print(fg(*C_SESSION, "  THRESHOLD"))
    print(
        f"  default={threshold.get('default', 0):,}  max={threshold.get('max', 0):,}  source={threshold.get('source', '')}"
    )
    print()

    evictions = trace.get("evictions") or {}
    all_gone = evictions.get("msgs") or []
    recent = evictions.get("recent") or []
    todos = trace.get("todos") or {}
    current_todos = todos.get("current") or []
    history_todos = todos.get("history") or []
    recent_todos = todos.get("recent") or []
    evicted_todos = todos.get("evicted") or []
    chunks = trace.get("chunks") or {}
    current_chunks = chunks.get("current") or []
    history_chunks = chunks.get("history") or []
    recent_chunks = chunks.get("recent") or []
    evicted_chunks = chunks.get("evicted") or []

    dropped_label = fg(*C_WARN, f"{len(all_gone)}") if all_gone else dim("0")
    recent_label = (
        (fg(*C_WARN, f"+{len(recent)} new") if recent else dim("")) if all_gone else ""
    )
    print(
        fg(*C_WARN, "  EVICTED MESSAGES") + f"  total={dropped_label}  {recent_label}"
    )
    if all_gone:
        render_paths(all_gone)
    else:
        print(dim("  (none)"))
    print()

    print(fg(*C_WARN, f"  LATEST EVICTION ROUND  ({len(recent)} messages)"))
    if recent:
        render_paths(recent)
    else:
        print(dim("  (none)"))
    print()

    print(fg(*C_TODO, f"  CURRENT TODOS  ({len(current_todos)})"))
    if current_todos:
        for item in current_todos:
            print(f"  {todo_status(item)}")
    else:
        print(dim("  (none)"))
    print()

    print(fg(*C_TODO, f"  TODO HISTORY  ({len(history_todos)})"))
    render_changes(history_todos)
    print()

    print(fg(*C_TODO, f"  LATEST EVICTED TODO CHANGES  ({len(recent_todos)})"))
    render_changes(recent_todos)
    print()

    print(fg(*C_TODO, f"  ALL EVICTED TODO CHANGES  ({len(evicted_todos)})"))
    render_changes(evicted_todos)
    print()

    print(fg(*C_CHUNK, f"  CURRENT CHUNKS  ({len(current_chunks)})"))
    render_boundaries(current_chunks)
    print()

    print(fg(*C_CHUNK, f"  CHUNK HISTORY  ({len(history_chunks)})"))
    render_boundaries(history_chunks)
    print()

    print(fg(*C_CHUNK, f"  LATEST EVICTED CHUNK BOUNDARIES  ({len(recent_chunks)})"))
    render_boundaries(recent_chunks)
    print()

    print(fg(*C_CHUNK, f"  ALL EVICTED CHUNK BOUNDARIES  ({len(evicted_chunks)})"))
    render_boundaries(evicted_chunks)
    print()

    cleanups = trace.get("cleanups") or {}
    cleanup_current = cleanups.get("current")
    cleanup_recent = cleanups.get("recent")
    cleanup_history = cleanups.get("history") or []
    cleanup_totals = cleanups.get("totals") or {}

    render_cleanup("LATEST CWL CLEANUP", cleanup_recent)

    print(fg(*C_WARN, f"  CWL CLEANUP HISTORY  ({len(cleanup_history)} runs)"))
    if cleanup_history:
        for cleanup in cleanup_history:
            seq = cleanup.get("sequence", "?")
            print(f"  [{seq:>2}]  {cleanup_summary_line(cleanup)}")
    else:
        print(dim("  (none)"))
    print()

    print(fg(*C_WARN, "  CWL CLEANUP TOTALS"))
    if cleanup_totals:
        removed = cleanup_totals.get("removed") or {}
        print(
            dim(
                "    "
                + "  ".join(
                    [
                        f"runs={cleanup_totals.get('runs', 0)}",
                        f"evicted_chunks={cleanup_totals.get('evictedChunks', 0)}",
                        f"noted_paths={cleanup_totals.get('notedFilePaths', 0)}",
                        f"tokens_removed={cleanup_totals.get('tokensRemoved', 0):,}",
                        f"steps={cleanup_totals.get('steps', 0)}",
                    ]
                )
            )
        )
        print(
            dim(
                "    removed: "
                + "  ".join(
                    [
                        f"assistant={removed.get('assistantMessages', 0)}",
                        f"tool_calls={removed.get('toolCalls', 0)}",
                        f"tool_results={removed.get('toolResults', 0)}",
                        f"thinking={removed.get('thinkingBlocks', 0)}",
                    ]
                )
            )
        )
        total_steps = cleanup_totals.get("stepBreakdown") or {}
        order = [
            "thinking",
            "search_tools",
            "bash_tools",
            "read_tools",
            "entire_chunk",
        ]
        bits = [f"{key}={total_steps.get(key, 0)}" for key in order if total_steps.get(key, 0)]
        if bits:
            print(dim("    step breakdown: " + "  ".join(bits)))
        total_tools = cleanup_totals.get("toolCallCounts") or {}
        if total_tools:
            counts_s = ", ".join(
                f"{tool}={count}" for tool, count in sorted(total_tools.items())
            )
            print(dim(f"    tool calls: {counts_s}"))
        total_paths = cleanup_totals.get("filePaths") or []
        if total_paths:
            print(dim(f"    file paths ({len(total_paths)}):"))
            for path in total_paths[:12]:
                print(dim(f"      - {path}"))
            if len(total_paths) > 12:
                print(dim(f"      … +{len(total_paths) - 12} more"))
    else:
        print(dim("    (none)"))
    print()

    if cleanup_current is not cleanup_recent:
        render_cleanup("CURRENT CWL CLEANUP", cleanup_current)

    print()
    render_transcript(trace.get("transcript") or [], width)


def render_token_timeline(messages: list, model_limit: dict, width: int):
    usable = model_limit["limit"]["usable"]
    print()
    print(hline("═", width, C_SESSION))
    print(
        fg(*C_SESSION, "  TOKEN TIMELINE  (cumulative context per step, active order)")
    )
    print(hline("─", width))

    bar_w = min(40, width - 40)

    prev_total = 0
    for i, msg in enumerate(messages):
        info = msg["info"]
        tokens = info.get("tokens", {})
        total = tokens.get("total", 0)
        role = info.get("role", "?")
        color = C_USER if role == "user" else C_ASST
        finish = info.get("finish", "")

        if total == 0:
            delta = ""
        else:
            d = total - prev_total
            sign = "+" if d >= 0 else ""
            delta = fg(*C_WARN, f"{sign}{d:,}") if d > 0 else dim(f"{d:,}")
            prev_total = total

        pct = (total / usable * 100) if usable else 0
        used = min(bar_w, int(bar_w * pct / 100))
        b = fg(*color, "█" * used) + dim("░" * (bar_w - used))

        tools = [p["tool"] for p in msg["parts"] if p["type"] == "tool"]
        todo = "✦ TODO" if "todowrite" in tools else ""
        chunk = "✦ CHUNK" if "delimiter" in tools else ""
        other = [t for t in tools if t not in ("todowrite", "delimiter")]
        lead = " ".join(
            x
            for x in [
                fg(*C_TODO, todo) if todo else "",
                fg(*C_CHUNK, chunk) if chunk else "",
            ]
            if x
        )
        tool_hint = (lead + " " if lead else "") + dim(",".join(other))

        role_lbl = fg(*color, f"[{i:02d}] {role[:6]}")
        tok_lbl = f"{total:>8,}" if total else dim(f"{'N/A':>8}")

        print(
            f"  {role_lbl}  {b}  {tok_lbl}  {dim(delta):>12}  {tool_hint}  {dim(finish)}"
        )

    print()


# ── Session picker ────────────────────────────────────────────────────────────

CWL_DIR = os.path.expanduser("~/.pi/agent/cwl")


def find_cwl_dir() -> str | None:
    """Return pi's passive CWL trace directory if it exists."""
    return CWL_DIR if os.path.isdir(CWL_DIR) else None


def pick_session(cwl_dir: str, width: int) -> str | None:
    """List sessions newest-first and let the user pick one interactively."""
    files = sorted(
        [f for f in os.listdir(cwl_dir) if f.endswith(".json")],
        key=lambda f: os.path.getmtime(os.path.join(cwl_dir, f)),
        reverse=True,
    )
    if not files:
        print(fg(*C_WARN, f"  No .json files found in {cwl_dir}"))
        return None

    print(hline("═", width, C_SESSION))
    print(fg(*C_SESSION, bold(f"  CWL SESSIONS  {cwl_dir}")))
    print(hline("─", width))

    entries = []
    for i, fname in enumerate(files):
        path = os.path.join(cwl_dir, fname)
        mtime = os.path.getmtime(path)
        size = os.path.getsize(path)
        dt = datetime.fromtimestamp(mtime).strftime("%Y-%m-%d %H:%M:%S")

        # Quick peek: grab session summary without full parse
        sid, model_id, msg_count, usage_pct = fname.replace(".json", ""), "", "?", ""
        try:
            with open(path) as f:
                d = json.load(f)
            sid = d.get("sessionID", sid)
            model_id = d.get("model", {}).get("id", "")
            msg_count = len(d.get("messages", {}).get("active", []))
            pct_u = d.get("usage", {}).get("pct", {}).get("usable", 0)
            usage_pct = f"{pct_u:.1f}%"
        except Exception:
            pass

        idx_lbl = fg(*C_SESSION, f"  [{i + 1:2d}]")
        time_lbl = dim(dt)
        size_lbl = dim(f"{size / 1024:.1f}KB")
        mod_lbl = bold(model_id) if model_id else ""
        msg_lbl = dim(f"{msg_count} msgs")
        pct_lbl = fg(*C_WARN, usage_pct) if usage_pct else ""
        sid_lbl = dim(sid)

        line = f"{idx_lbl}  {time_lbl}  {size_lbl:>10}  {mod_lbl:20}  {msg_lbl}  {pct_lbl:>8}  {sid_lbl}"
        print(line)
        entries.append(path)

    print(hline("─", width))

    if not sys.stdin.isatty():
        # Non-interactive: just return the newest
        return entries[0]

    try:
        choice = input(f"\n  Select [1-{len(entries)}] (Enter = newest): ").strip()
        if choice == "":
            return entries[0]
        n = int(choice)
        if 1 <= n <= len(entries):
            return entries[n - 1]
        print(fg(*C_WARN, "  Out of range."))
        return None
    except (ValueError, KeyboardInterrupt, EOFError):
        return None


# ── Entry point ────────────────────────────────────────────────────────────────


def main():
    parser = argparse.ArgumentParser(
        description="Pi CWL session trace viewer for passive JSON traces"
    )
    parser.add_argument(
        "file",
        nargs="?",
        default=None,
        help="Path to ~/.pi/agent/cwl/*.json trace file (omit to pick from list)",
    )
    parser.add_argument(
        "--view",
        choices=["full", "active"],
        default="active",
        help="Message stream to render (default: active)",
    )
    parser.add_argument(
        "--no-text", action="store_true", help="Hide text/reasoning bodies"
    )
    parser.add_argument(
        "--no-tool-output", action="store_true", help="Hide tool output payloads"
    )
    parser.add_argument(
        "--todo-only",
        action="store_true",
        help="Show only todo delimiters (skip other parts)",
    )
    parser.add_argument(
        "--timeline-only",
        action="store_true",
        help="Show only the token timeline, no message detail",
    )
    parser.add_argument("--width", type=int, default=0, help="Terminal width override")
    args = parser.parse_args()

    width = args.width or (
        os.get_terminal_size().columns if sys.stdout.isatty() else 100
    )
    width = max(60, min(width, 200))

    path = args.file
    if path is None:
        cwl_dir = find_cwl_dir()
        if cwl_dir is None:
            print(
                fg(
                    *C_WARN,
                    f"  Could not find {CWL_DIR}.",
                )
            )
            sys.exit(1)
        path = pick_session(cwl_dir, width)
        if path is None:
            sys.exit(0)
        print()

    with open(path) as f:
        data = json.load(f)

    show_text = not args.no_text
    show_toolout = not args.no_tool_output

    render_session_header(data, width)

    if "last" in data:
        render_last(data["last"], width)

    if "trace" in data:
        render_trace(data["trace"], width)

    messages = data["messages"][args.view]
    trace = data.get("trace") or {}
    evicted_ids = set((trace.get("evictions") or {}).get("msgs") or [])
    evicted_todos = (trace.get("todos") or {}).get("evicted") or []
    evicted_chunks = (trace.get("chunks") or {}).get("evicted") or []
    runs = (
        build_compaction_runs(messages, evicted_ids, evicted_todos, evicted_chunks)
        if args.view == "full"
        else {}
    )

    render_token_timeline(messages, data["model"], width)

    if args.timeline_only:
        return

    print(hline("═", width, C_SESSION))
    print(fg(*C_SESSION, f"  MESSAGES  view={args.view}  count={len(messages)}"))
    print(hline("═", width, C_SESSION))
    print()

    for i, msg in enumerate(messages):
        if i in runs:
            render_compaction_run(runs[i], width)

        parts = msg["parts"]
        if args.todo_only:
            has_todo = any(
                p.get("type") == "tool" and p.get("tool") == "todowrite" for p in parts
            )
            if not has_todo:
                continue

        render_message(msg, i, args.view, show_text, show_toolout, width, evicted_ids)
        print()

    print(hline("═", width, C_SESSION))
    print(fg(*C_SESSION, f"  END  {data['sessionID']}"))
    print(hline("═", width, C_SESSION))


if __name__ == "__main__":
    main()
