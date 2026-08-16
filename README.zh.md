# dsh-session-recovery

![DeepSeek Harness](https://img.shields.io/badge/DeepSeek%20Harness-dsh-4B32C3) ![Node](https://img.shields.io/badge/Node-24%2B-339933) ![License](https://img.shields.io/badge/License-MIT-blue)

[English](README.md) | 中文

> 从原始磁盘直接恢复被删除或损坏的 DeepSeek Harness（dsh）会话记录（`session.jsonl.zstd`）与记忆库（`memory.db`）——实战验证过的恢复手册 + 可复用脚本。

在 `rm -rf ~/.dsh` 误删或文件损坏后，通过扫描原始块设备，找回磁盘上幸存的数据，重建 dsh 的会话日志与记忆库。

## ✨ 功能特性

- **记忆库恢复** — 用 `SQLite format 3` 文件头特征定位 `memory.db`，dump 后以 SQLite 官方 `.recover` 模式抢救数据（跳过损坏页、保留可读记录）。
- **会话恢复** — 扫描磁盘上的 zstd 帧魔数（`0xFD2FB528`），按磁盘偏移聚类，在 `turn` 重置处拆分多个会话，重建官方格式的 `session.jsonl.zstd` 文件。
- **自动修复** — 重编号 `seq` 为连续、深度修复 `sourceEventSeqs`/`messageSeqs` 引用、归一化 `surfaceOp`，使重建日志通过 DSH 的校验。
- **安全** — 脚本只读块设备、写入你指定的目录，绝不修改原始磁盘。

## 🚀 快速开始

```bash
# 1. 停掉一切写盘的东西（systemd 服务、dsh 本身）
systemctl stop dsh-web

# 2. 恢复记忆库（SQLite）
node scripts/recover-memory.js /dev/<设备> /tmp/recovered/

# 3. 扫描磁盘上的会话帧
node scripts/scan-zstd.js /dev/<设备> > /tmp/session-events.jsonl

# 4. 重建会话文件（官方格式）
node scripts/rebuild-session.js \
  --input /tmp/sess-A.jsonl \
  --id session-xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx \
  --created-at 1786705157736 \
  --cwd /path/to/workspace \
  --out-dir ~/.dsh/sessions/--workspace-encoded--/
```

完整的分步手册（含 DSH 校验规则与所有可能遇到的报错）见 [RECOVERY.md](RECOVERY.md)。

## 📦 作为 dsh 插件安装

> **说明**：本仓库核心是恢复工具集（脚本 + 手册），同时提供插件包装，可通过 `dsh plugin add` 安装，在 harness 中暴露恢复/扫描工具。

```bash
dsh plugin --profile web add dsh-session-recovery
```

需要 Node 24+（使用 `node:sqlite`、`node:zlib`）。

## 📖 背景知识

DeepSeek Harness 的数据存放在 `~/.dsh` 下：

- 会话：`~/.dsh/sessions/<workspace-encoded>/<session-id>/session.jsonl.zstd`
- 记忆库（dsh-mneme）：`~/.dsh/memory/memory.db`
- 工作区注册表：`~/.dsh/storages/workspace.json`

会话日志是 **zstd 帧的拼接流——每一行 JSONL 一个独立帧**（见 [dsh-session-persistence-jsonl](https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/session/session-persistence-jsonl)）。这种逐行分帧的结构正是"部分恢复"可行的原因：即使部分帧被覆盖，周围的完整帧仍能独立解码。

## 🗂️ 仓库结构

```
├── RECOVERY.md            # 完整恢复手册（中文，实战验证）
├── docs/
│   ├── awesome-entry.yml  # 已按格式写好的 Awesome DSH Plugin 列表条目
│   └── GITHUB-PUBLISH.md  # 发布与 PR 操作清单
├── scripts/
│   ├── scan-zstd.js       # 磁盘扫描：定位并聚类 zstd 会话帧
│   ├── split-sessions.js  # 把混合恢复事件按会话拆分成多个文件
│   ├── rebuild-session.js # 重建官方格式 session.jsonl.zstd
│   └── recover-memory.js  # 定位并抢救 memory.db（SQLite .recover）
└── package.json           # dsh 插件 manifest（dsh.bundle）
```

## 🔖 Topics

`dsh` · `deepseek-harness` · `session-recovery` · `data-recovery` · `forensics` · `zstd` · `sqlite`

## 📄 License

MIT
