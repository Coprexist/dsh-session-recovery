# dsh-session-recovery

> 从被删除/损坏的磁盘中恢复 DeepSeek Harness（dsh）的会话记录（session.jsonl.zstd）与记忆库（memory.db）——实战验证过的完整恢复手册 + 可复用脚本。

DeepSeek Harness 的数据（会话日志、记忆库、配置）默认存放在 `~/.dsh` 下：

- 会话记录：`~/.dsh/sessions/<workspace-encoded>/<session-id>/session.jsonl.zstd`
- 记忆库（dsh-mneme）：`~/.dsh/memory/memory.db`
- 工作区注册表：`~/.dsh/storages/workspace.json`

如果 `~/.dsh` 被误删（例如被建议执行 `rm -rf ~/.dsh`），只要**删除后没有大量写入新数据**，这些文件的内容大概率仍残留在磁盘上，可以按本文恢复。

---

## 目录

- [1. 停止写入（最重要）](#1-停止写入最重要)
- [2. 恢复记忆库 memory.db（SQLite）](#2-恢复记忆库-memorydb-sqlite)
- [3. 恢复会话 session.jsonl.zstd（zstd 帧）](#3-恢复会话-sessionjsonlzstd-zstd-帧)
- [4. 重建会话文件（官方格式）](#4-重建会话文件官方格式)
- [5. 注册工作区与会话](#5-注册工作区与会话)
- [6. 常见坑与校验规则](#6-常见坑与校验规则)
- [脚本说明](#脚本说明)
- [License](#license)

---

## 1. 停止写入（最重要）

**删除后立刻停止一切写盘操作**：不要安装软件、不要创建文件、不要重启服务（systemd 自动重启也会写盘）。

```bash
# 停掉可能自动重启 dsh 的服务（如果有）
systemctl stop dsh-web 2>/dev/null
# 之后恢复过程中不要再启动它
```

确认磁盘分区和可用工具：

```bash
df -T /            # 看根分区文件系统类型（ext4 可恢复）
which zstd node    # 需要 zstd 和 Node 24+（node:sqlite / node:zlib）
```

---

## 2. 恢复记忆库 memory.db（SQLite）

SQLite 数据库文件头固定为 `SQLite format 3` 这 16 个字节，直接扫描块设备定位：

```bash
# 1. 定位所有 SQLite 文件头（记下偏移量）
grep -abo 'SQLite format 3' /dev/<dev> | head -30

# 2. 对每个偏移，dump 一段数据（示例：偏移 274395136，dump 20MB）
dd if=/dev/<dev> of=cand.db bs=4096 skip=$((274395136/4096)) count=5120 status=none

# 3. 用 Node 验证是不是 dsh-mneme 的库（有 memories 表）
node -e '
const {DatabaseSync}=require("node:sqlite");
try {
  const db=new DatabaseSync("cand.db",{readOnly:true});
  const t=db.prepare("SELECT name FROM sqlite_master WHERE type=\"table\"").all().map(r=>r.name);
  console.log("tables:", t.join(", "));
} catch(e) { console.log("ERR:", e.message); }
'

# 4. 是 memory.db 就用 sqlite3 的 .recover 抢救数据（跳过坏页，保留好页）
sqlite3 cand.db ".recover" > /tmp/recovered.sql 2>/tmp/recover_err.txt
grep -c "INSERT INTO" /tmp/recovered.sql   # 看救回多少条记录

# 5. 重建干净的库并灌入
sqlite3 /tmp/memory-rebuilt.db ".read /tmp/recovered.sql"
sqlite3 /tmp/memory-rebuilt.db "SELECT COUNT(*) FROM memories;"   # 应>0

# 6. 装回
mkdir -p ~/.dsh/memory
cp /tmp/memory-rebuilt.db ~/.dsh/memory/memory.db
chmod 600 ~/.dsh/memory/memory.db
```

> 参考：[SQLite 官方 .recover 命令](https://sqlite.org/cli.html#recover)（跳过损坏页、保留可读数据）。

---

## 3. 恢复会话 session.jsonl.zstd（zstd 帧）

### 3.1 理解格式（关键）

dsh 的会话文件格式（见 [dsh-session-persistence-jsonl 源码](https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/session/session-persistence-jsonl)）：

- **每行一个独立 zstd 帧**，帧头魔数 `0xFD2FB528`（字节 `28 b5 2f fd`），带 checksum
- 第一帧是 header 行（`{"type":"session",...}`），之后每个事件一行
- 事件必须满足：`seq === index`（从 0 连续）、`sourceEventSeqs` 引用的事件必须在物理顺序上更早
- 会话边界：`session/end-seed` 事件标记 seed 区；`turn` 重置（turn 从 1 重新数）通常意味着新会话（compaction 后）

### 3.2 扫描块设备找 zstd 帧

```bash
# 用 scripts/scan-zstd.js（Node 直读块设备，全盘扫描 zstd 魔数并聚类）
node scripts/scan-zstd.js /dev/<dev> > /tmp/session-events.jsonl 2>/tmp/scan.log
tail -20 /tmp/scan.log
```

输出 `saved rec-session-N.jsonl` 即为按磁盘偏移聚类出的候选会话事件（每行一条 JSON 事件）。

### 3.3 拆分多个会话（按 turn 重置 / 时间边界）

```bash
# 找 turn 重置点（新会话起点）
grep '"type":"turn/start"' /tmp/session-events.jsonl | node -e '
let s=""; process.stdin.on("data",d=>s+=d).on("end",()=>{
  const turns=[];
  for(const l of s.trim().split("\n")){ try{ const j=JSON.parse(l); turns.push({t:j.data.turn,time:j.time}); }catch(e){} }
  turns.sort((a,b)=>a.time-b.time);
  let prev=null;
  for(const x of turns){ if(prev!==null && x.t<=prev) console.log("TURN RESET:", new Date(x.time).toISOString()); prev=x.t; }
});'
```

以重置时间为边界，把事件拆成多个 `sess-<name>.jsonl`。

---

## 4. 重建会话文件（官方格式）

```bash
# 用 scripts/rebuild-session.js（重编号 seq + 修复引用 + 逐行 zstd + checksum）
node scripts/rebuild-session.js \
  --input /tmp/sess-A.jsonl \
  --id session-xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx \
  --created-at 1786705157736 \
  --cwd /path/to/workspace \
  --out-dir ~/.dsh/sessions/--workspace-encoded--/
```

脚本自动完成：

1. **按 time 排序**（保持事件顺序）
2. **seq 重编号为 0..N-1 连续**（满足 `seq === index`）
3. **深度修复所有 `sourceEventSeqs`/`messageSeqs`**：只保留能映射到更早事件的引用，失效引用丢弃（被覆盖的事件已丢失，无法引用）
4. **修复 `surfaceOp`**：对象形式统一改为字符串 `"append"`（正常事件的 surfaceOp 是字符串）
5. **逐行 zstd 压缩 + checksum**（官方格式）

> 会话目录名必须与 header 里的 `id` 一致：`~/.dsh/sessions/<workspace-encoded>/<session-id>/session.jsonl.zstd`。

---

## 5. 注册工作区与会话

```bash
# 把工作区 + 会话 id 写进 workspace.json
node -e '
const fs=require("fs");
const p=process.env.HOME+"/.dsh/storages/workspace.json";
const j=JSON.parse(fs.readFileSync(p,"utf8"));
const WID="<workspace-uuid>";   // 沿用原有工作区 id，或生成新的
const SIDS=["<session-id-1>","<session-id-2>"];
j.global.workspaceIds=[WID];
j.tables.workspaces[WID]={
  path:"/path/to/workspace",
  title:"My Workspace",
  sessionIds:SIDS,
  createdAt:new Date().toISOString(),
  updatedAt:new Date().toISOString()
};
fs.writeFileSync(p,JSON.stringify(j,null,2));
console.log("workspace registered:", WID);
'

# 重启服务（不要 pkill，用 systemd）
systemctl restart dsh-web
```

浏览器打开 dsh web，工作区里应该能看到恢复的会话。

---

## 6. 常见坑与校验规则

| 报错 | 原因 | 修法 |
|---|---|---|
| `first frame is not exactly one header line` | 整个文件压成了一个 zstd 帧 | 必须**逐行**压缩成多个帧 |
| `seq gap in committed region` | seq 不连续 | 重编号为 0..N-1 连续 |
| `sourceEventSeqs must reference earlier events: X >= current seq Y` | 引用了丢失/未来事件 | 深度遍历删除失效引用（脚本自动做） |
| `surface replace: start seq X not found in surface` | `surfaceOp` 的 replace 引用了丢失事件 | 改成字符串 `"append"` |
| `session event carries an invalid replace surfaceOp` | surfaceOp 写成对象 `{op:"append"}` | 改成字符串 `"append"` |
| `.credentials.yaml is readable beyond its owner` | Windows 拷贝过来权限变 666 | `chmod 600 ~/.dsh/.credentials.yaml` |
| `listen EADDRINUSE` | systemd 自动重启 + 手动启动冲突 | 用 `systemctl restart dsh-web`，别 `pkill` |

**恢复后建议**：

```bash
# 立即备份，防止再次误删
cp -r ~/.dsh ~/.dsh.bak
```

---

## 脚本说明

| 脚本 | 用途 |
|---|---|
| `scripts/scan-zstd.js` | 全盘扫描 zstd 帧，按磁盘偏移聚类，输出候选会话事件 JSONL |
| `scripts/rebuild-session.js` | 重建官方格式会话文件（重编号 + 修引用 + 逐行 zstd） |
| `scripts/recover-memory.sh` | 定位 + dump + 抢救 memory.db（SQLite .recover 流程） |

> 所有脚本只读块设备 / 写输出到指定目录，不修改原始磁盘。

---

## License

MIT
