<div align="center">

# dsh-session-recovery

**从原始磁盘恢复被删除/损坏的 DeepSeek Harness 会话与记忆库**

[![DeepSeek Harness](https://img.shields.io/badge/DeepSeek%20Harness-dsh-4B32C3)](https://github.com/deepseek-ai/deepseek-harness)
[![Node](https://img.shields.io/badge/Node-24%2B-339933)](https://nodejs.org)
[![License](https://img.shields.io/badge/License-MIT-blue)](LICENSE)
[![Awesome DSH Plugin](https://awesome-dsh-plugin.com/badge.svg)](https://awesome-dsh-plugin.com)

[English](README.md) · 中文

</div>

---

> 🛟 在 `rm -rf ~/.dsh` 误删或文件损坏后，dsh 的会话记录（`session.jsonl.zstd`）与记忆库（`memory.db`）通常仍可从**原始块设备**中找回——本仓库是实战验证过的恢复手册与配套脚本。

## ✨ 功能特性

| | |
|---|---|
| 🧠 **记忆库恢复** | 以 `SQLite format 3` 文件头定位 `memory.db`，dump 后用 SQLite 官方 `.recover` 抢救（跳过损坏页、保留可读记录）。 |
| 💬 **会话恢复** | 扫描 zstd 帧魔数 `0xFD2FB528`，按磁盘偏移聚类，在 `turn` 重置处拆分会话，重建官方格式 `session.jsonl.zstd`。 |
| 🔧 **自动修复** | `seq` 重编号连续、深度修复 `sourceEventSeqs`/`messageSeqs`、归一化 `surfaceOp`——重建日志通过 DSH 校验。 |
| 🔁 **续接修复** | 重建文件在*续接*时可能报错（`invalid persisted inbox splice`、`Messages with role 'tool' must be a response to tool_calls`）——`repair-session.js`（或 web 界面的 `/session-repair` 命令）逐条重放 DSH 的 inbox/surface/wire 规则并修复。 |
| 🛡️ **安全设计** | 脚本只**读**块设备、写入你指定目录，绝不修改原始磁盘。 |

## 🚀 快速开始

```bash
# 1. 停掉一切写盘的东西（systemd 服务、dsh 本身）
systemctl stop dsh-web

# 2. 恢复记忆库（SQLite）
node scripts/recover-memory.js /dev/<设备> /tmp/recovered/

# 3. 扫描磁盘上的会话帧
node scripts/scan-zstd.js /dev/<设备> > /tmp/session-events.jsonl

# 4. 把混合事件按会话拆分
node scripts/split-sessions.js /tmp/session-events.jsonl 2026-08-16T07:05:06Z

# 5. 重建会话文件（官方格式）
node scripts/rebuild-session.js \
  --input /tmp/sess-A.jsonl \
  --id session-xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx \
  --created-at 1786705157736 \
  --cwd /path/to/workspace \
  --out-dir ~/.dsh/sessions/--workspace-encoded--/

# 6. 续接前校验/修复（修复 inbox splice 错位、重复/孤儿 tool 结果、悬空 tool 调用）
node scripts/repair-session.js \
  ~/.dsh/sessions/--workspace-encoded--/<session-id>/session.jsonl.zstd --dry-run
node scripts/repair-session.js \
  ~/.dsh/sessions/--workspace-encoded--/<session-id>/session.jsonl.zstd
#   → 生成 session.jsonl.zstd.repaired（+ .bak-<时间戳>），确认后覆盖：
cp ~/.dsh/sessions/--workspace-encoded--/<session-id>/session.jsonl.zstd.repaired \
   ~/.dsh/sessions/--workspace-encoded--/<session-id>/session.jsonl.zstd
```

📖 **完整分步手册**（中文，含 DSH 校验规则与所有可能遇到的报错）：**[RECOVERY.md](RECOVERY.md)**

## 📦 作为 dsh 插件安装

> **说明**：本仓库核心是恢复工具集（脚本 + 手册），同时作为 dsh 插件安装后会向 **web 界面注册 `/session-repair` 命令**。

在包含本仓库的目录（本地安装，无需发布）：

```bash
dsh plugin --profile web add file:/path/to/dsh-session-recovery
systemctl restart dsh-web
```

然后在 web 界面的**任意会话**里输入：

```
/session-repair --dry-run              # 只分析当前会话（不写任何文件）
/session-repair <会话id或路径>          # 修复 → 生成 .repaired + 备份
/session-repair --apply <id>           # 同时覆盖原文件
```

默认只生成新的 `.repaired` 文件 + 备份；`--apply` 才覆盖原文件（对正在运行当前会话会拒绝，需从其他会话执行）。应用后重启 `dsh-web`。

需要 **Node 24+**（`node:sqlite`、`node:zlib`）。

## 📖 背景知识

DeepSeek Harness 的数据存放在 `~/.dsh` 下：

```
~/.dsh/
├── sessions/<workspace-encoded>/<session-id>/session.jsonl.zstd   # 会话记录
├── memory/memory.db                                               # dsh-mneme 记忆库
└── storages/workspace.json                                        # 工作区注册表
```

会话日志是 **zstd 帧的拼接流——每一行 JSONL 一个独立帧**（[源码](https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/session/session-persistence-jsonl)）。这种逐行分帧的结构正是"部分恢复"可行的原因：即使部分帧被覆盖，周围的完整帧仍能独立解码。

## 🗂️ 仓库结构

```
├── RECOVERY.md            # 完整恢复手册（中文，实战验证）
├── cordis.patch.yml       # dsh 插件 patch（注册 /session-repair）
├── docs/
│   ├── awesome-entry.yml  # 已按格式写好的 Awesome DSH Plugin 列表条目
│   └── GITHUB-PUBLISH.md  # 发布与 PR 操作清单
├── lib/
│   ├── index.js           # dsh 插件入口：/session-repair 命令
│   └── repair.js          # 共享修复核心（CLI + 插件共用）
├── scripts/
│   ├── scan-zstd.js       # 磁盘扫描：定位并聚类 zstd 会话帧
│   ├── split-sessions.js  # 把混合恢复事件按会话拆分
│   ├── rebuild-session.js # 重建官方格式 session.jsonl.zstd
│   ├── repair-session.js  # 修复重建后无法续接的会话
│   ├── make-test-fixture.js # 生成带损伤的样本会话，离线测试修复
│   └── recover-memory.js  # 定位并抢救 memory.db（SQLite .recover）
└── package.json           # dsh 插件 manifest（dsh.bundle + main 入口）
```

## 🔖 Topics

`dsh-plugin` · `dsh` · `deepseek-harness` · `session-recovery` · `data-recovery` · `zstd` · `sqlite`

## 📄 License

[MIT](LICENSE)
