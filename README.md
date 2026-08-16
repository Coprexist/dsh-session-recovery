# dsh-session-recovery

![DeepSeek Harness](https://img.shields.io/badge/DeepSeek%20Harness-dsh-4B32C3) ![Node](https://img.shields.io/badge/Node-24%2B-339933) ![License](https://img.shields.io/badge/License-MIT-blue)

> Recover deleted or corrupted DeepSeek Harness (dsh) sessions (`session.jsonl.zstd`) and memory (`memory.db`) straight from the raw disk — a battle-tested recovery manual plus reusable scripts.

Recover dsh conversation logs and memory database after `rm -rf ~/.dsh` or file corruption, by scanning the raw block device for surviving data.

## ✨ Features

- **Memory recovery** — locate `memory.db` via the `SQLite format 3` header signature, dump it, and rescue rows with SQLite's official `.recover` (skips corrupt pages, keeps readable data).
- **Session recovery** — scan the disk for zstd frame magic (`0xFD2FB528`), cluster frames by disk offset, split multiple sessions at `turn` resets, and rebuild official-format `session.jsonl.zstd` files.
- **Automatic repair** — renumbers `seq` to be contiguous, deep-fixes `sourceEventSeqs`/`messageSeqs` references, and normalizes `surfaceOp` so the rebuilt log passes DSH's validation.
- **Safe** — scripts only read the block device and write to a directory you choose; the original disk is never modified.

## 🚀 Quick Start

```bash
# 1. Stop everything that writes to disk (systemd services, dsh itself)
systemctl stop dsh-web

# 2. Recover memory (SQLite)
node scripts/recover-memory.js /dev/<dev> /tmp/recovered/

# 3. Scan disk for session frames
node scripts/scan-zstd.js /dev/<dev> > /tmp/session-events.jsonl

# 4. Rebuild a session file (official format)
node scripts/rebuild-session.js \
  --input /tmp/sess-A.jsonl \
  --id session-xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx \
  --created-at 1786705157736 \
  --cwd /path/to/workspace \
  --out-dir ~/.dsh/sessions/--workspace-encoded--/
```

See [RECOVERY.md](RECOVERY.md) for the full step-by-step manual (Chinese), including the DSH validation rules and every error you may hit.

## 📦 Install as a dsh plugin

> **Note**: this repo is primarily a recovery toolkit (scripts + manual). A plugin wrapper is provided so it can also be added via `dsh plugin add`, exposing recovery/scan tools as agent tools in your harness.

```bash
dsh plugin --profile web add dsh-session-recovery
```

Requires Node 24+ (uses `node:sqlite`, `node:zlib`).

## 📖 Background

DeepSeek Harness stores its data under `~/.dsh`:

- Sessions: `~/.dsh/sessions/<workspace-encoded>/<session-id>/session.jsonl.zstd`
- Memory (dsh-mneme): `~/.dsh/memory/memory.db`
- Workspace registry: `~/.dsh/storages/workspace.json`

The session log is a **concatenated stream of zstd frames — one frame per JSONL line** (see [dsh-session-persistence-jsonl](https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/session/session-persistence-jsonl)). This per-line framing is what makes partial recovery possible: even if some frames are overwritten, the intact frames around them can still be decoded independently.

## 🗂️ Repository Layout

```
├── RECOVERY.md            # Full recovery manual (Chinese, battle-tested)
├── scripts/
│   ├── scan-zstd.js       # Disk scan: find & cluster zstd session frames
│   ├── rebuild-session.js # Rebuild official-format session.jsonl.zstd
│   └── recover-memory.js  # Locate & rescue memory.db (SQLite .recover)
└── package.json           # dsh plugin manifest (dsh.bundle)
```

## 🔖 Topics

`dsh` · `deepseek-harness` · `session-recovery` · `data-recovery` · `forensics` · `zstd` · `sqlite`

## 📄 License

MIT
