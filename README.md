<div align="center">

# dsh-session-recovery

**Recover deleted/corrupted DeepSeek Harness sessions & memory from raw disk**

[![DeepSeek Harness](https://img.shields.io/badge/DeepSeek%20Harness-dsh-4B32C3)](https://github.com/deepseek-ai/deepseek-harness)
[![Node](https://img.shields.io/badge/Node-24%2B-339933)](https://nodejs.org)
[![License](https://img.shields.io/badge/License-MIT-blue)](LICENSE)
[![Awesome DSH Plugin](https://awesome-dsh-plugin.com/badge.svg)](https://awesome-dsh-plugin.com)

English · [中文](README.zh.md)

</div>

---

> 🛟 After `rm -rf ~/.dsh` or file corruption, dsh conversation logs (`session.jsonl.zstd`) and memory (`memory.db`) can usually be recovered **straight from the raw block device** — this repo is a battle-tested manual plus the scripts that made it work.

## ✨ Features

| | |
|---|---|
| 🧠 **Memory recovery** | Locate `memory.db` by its `SQLite format 3` header, dump the window, rescue rows via SQLite's official `.recover` (skips corrupt pages, keeps readable data). |
| 💬 **Session recovery** | Scan disk for zstd frame magic `0xFD2FB528`, cluster frames by disk offset, split sessions at `turn` resets, rebuild official-format `session.jsonl.zstd`. |
| 🔧 **Automatic repair** | Renumber `seq` contiguously, deep-fix `sourceEventSeqs`/`messageSeqs`, normalize `surfaceOp` — the rebuilt log passes DSH's validation. |
| 🛡️ **Safe by design** | Scripts only **read** the block device and write to a directory you choose; the original disk is never modified. |

## 🚀 Quick Start

```bash
# 1. Stop everything that writes to disk (systemd services, dsh itself)
systemctl stop dsh-web

# 2. Recover memory (SQLite)
node scripts/recover-memory.js /dev/<dev> /tmp/recovered/

# 3. Scan disk for session frames
node scripts/scan-zstd.js /dev/<dev> > /tmp/session-events.jsonl

# 4. Split mixed events into per-session files
node scripts/split-sessions.js /tmp/session-events.jsonl 2026-08-16T07:05:06Z

# 5. Rebuild a session file (official format)
node scripts/rebuild-session.js \
  --input /tmp/sess-A.jsonl \
  --id session-xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx \
  --created-at 1786705157736 \
  --cwd /path/to/workspace \
  --out-dir ~/.dsh/sessions/--workspace-encoded--/
```

📖 **Full step-by-step manual** (Chinese, with every DSH validation rule and error you may hit): **[RECOVERY.md](RECOVERY.md)**

## 📦 Install as a dsh plugin

> **Note**: primarily a recovery toolkit (scripts + manual); a plugin wrapper is included so it can also be added via `dsh plugin add`.

```bash
dsh plugin --profile web add dsh-session-recovery
```

Requires **Node 24+** (`node:sqlite`, `node:zlib`).

## 📖 Background

DeepSeek Harness stores its data under `~/.dsh`:

```
~/.dsh/
├── sessions/<workspace-encoded>/<session-id>/session.jsonl.zstd   # conversation log
├── memory/memory.db                                               # dsh-mneme memory
└── storages/workspace.json                                        # workspace registry
```

The session log is a **concatenated stream of zstd frames — one frame per JSONL line** ([source](https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/session/session-persistence-jsonl)). That per-line framing is exactly what makes partial recovery possible: even if some frames are overwritten, the intact frames around them still decode independently.

## 🗂️ Repository Layout

```
├── RECOVERY.md            # Full recovery manual (Chinese, battle-tested)
├── docs/
│   ├── awesome-entry.yml  # Ready-to-submit Awesome DSH Plugin list entry
│   └── GITHUB-PUBLISH.md  # Publish & PR checklist
├── scripts/
│   ├── scan-zstd.js       # Disk scan: find & cluster zstd session frames
│   ├── split-sessions.js  # Split mixed recovered events into per-session files
│   ├── rebuild-session.js # Rebuild official-format session.jsonl.zstd
│   └── recover-memory.js  # Locate & rescue memory.db (SQLite .recover)
└── package.json           # dsh plugin manifest (dsh.bundle)
```

## 🔖 Topics

`dsh-plugin` · `dsh` · `deepseek-harness` · `session-recovery` · `data-recovery` · `zstd` · `sqlite`

## 📄 License

[MIT](LICENSE)
