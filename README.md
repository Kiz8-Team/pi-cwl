# pi-cwl

**pi-cwl** is the reference implementation of **Context Window Lifecycle (CWL)**, a context-management scheme that gives long-horizon LLM agents an effectively unbounded working horizon.

It is a fork of the open-source [pi.dev](https://pi.dev/) terminal coding agent, extended with the CWL protocol described in our paper:

> **Beyond Compaction: Structured Context Eviction for Long-Horizon Agents**  
> Andrew Semenov, Svyatoslav Dorofeev — Kiz8  
> _Preprint manuscript, 2026_

We opened this repository before the arXiv paper went public. The arXiv submission has been stalled since April 21 2026, and we decided not to wait any longer to share the paper and reference implementation.

---

## What is CWL?

As a long-running agent session accumulates history, the context window fills. The standard response is **compaction**: pause, summarize the transcript with an LLM, replace the original history with the summary. Compaction is simple but has four structural problems:

- **Unpredictable lossiness** — the summarizer decides what matters, not the task.
- **Structural destruction** — causal chains (tool call → output → decision → action) collapse into prose.
- **Blocking cost** — a full LLM call fires mid-task, under token pressure.
- **Compression-induced hallucination** — summarization under length pressure is a known LLM failure mode.

CWL addresses these by treating the transcript as a **structured record of work** rather than an opaque blob.

### How it works

The agent annotates its trajectory in real time using a single `delimiter` tool. Annotations form a **typed episode graph**:

- **Exploratory episodes** (`expl`) — information gathering: file reads, searches, directory listings. When closed, the agent supplies a one-line description of what was learned.
- **Action episodes** (`act`) — durable work: edits, writes, shell commands. When opened, the agent declares which exploratory episodes it depends on.

When the token budget is exceeded, a **deterministic, model-free eviction policy** walks the graph and strips content in graduated levels — from reasoning traces, to bulk outputs, to intermediate artifacts, to full episode removal — starting with the oldest action episodes (whose effects are already persisted in the environment) and respecting dependency edges so that exploratory context is never dropped while an action that relied on it remains in context.

User turns are never evicted.

### Results

A single agent session completing **89 sequential tasks** across **80 million tokens** with no measurable degradation in task accuracy relative to per-task isolated sessions (68.1% vs 67.5% on Terminal Bench 2.0). Inference cost reduction of 20–70% relative to uncapped sessions due to prefix stability near the token budget ceiling.

---

## Installation

```bash
npm install       # install all dependencies
npm run build     # build all packages and expose `pi` on your global PATH
```

Then run:

```bash
pi
```

### Using the SDK in another project

```bash
# In this repo
npm run build

# In your project
npm link @mariozechner/pi-coding-agent
```

```ts
import { createAgentSession } from "@mariozechner/pi-coding-agent";
```

To switch back to the published npm version:

```bash
npm unlink @mariozechner/pi-coding-agent
npm install
```

### Development commands

```bash
npm run check     # lint, format, and type-check
./test.sh         # run tests (skips LLM-dependent tests without API keys)
./pi-test.sh      # run pi from sources (can be run from any directory)
```

---

## Repository structure

```
packages/
  ai/             # LLM provider abstraction layer
  agent/          # core agent loop
  coding-agent/   # coding-agent extension (tools, CWL integration)
  tui/            # terminal UI
  mom/            # multi-agent orchestration
  pods/           # sandboxed execution environments
  web-ui/         # web interface
```

---

## Citation

Pending