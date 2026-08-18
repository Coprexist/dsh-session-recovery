# GitHub 发布与 Awesome 列表收录操作清单

本文记录 `dsh-session-recovery` 从本地到 GitHub、再到 [Awesome DSH Plugin 列表](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) 的完整操作步骤。

> ⚠️ 安全红线：仓库中**绝不包含**任何真实服务器地址、SSH 凭据、用户名、端口等敏感信息。提交前用 `git grep` 自查。

---

## 1. 推送到 GitHub

### 1.1 创建远程仓库（一次）

1. 打开 https://github.com/new
2. Repository name：`dsh-session-recovery`
3. Visibility：**Public**（Awesome 列表要求公开）
4. **不要**勾选 Add README / Add .gitignore / Add license（本地已备齐，勾了会冲突）
5. Description（可选）：`Recover deleted or corrupted dsh session logs (session.jsonl.zstd) and memory (memory.db) from the raw disk — battle-tested recovery toolkit for DeepSeek Harness.`
6. Create repository

### 1.2 推送（新机器首次）

```powershell
cd F:\Zhang\dsh-session-recovery
git remote add origin https://github.com/Coprexist/dsh-session-recovery.git
git push -u origin main
```

### 1.3 日常提交

```powershell
cd F:\Zhang\dsh-session-recovery
# 提交前自查敏感信息（应无输出）
git grep -n -E "密码|password|<你的密码>|101\.|<SSH端口>|@1[0-9]{2}\." HEAD 2>$null

git add -A
git commit -m "描述改动"
git push
```

---

## 2. 加 topic（GitHub 网页）

仓库页 → 右侧 **About** → ⚙️ → Topics 填入（逗号分隔）：

```
dsh-plugin, dsh, deepseek-harness, session-recovery, data-recovery, zstd, sqlite
```

> **`dsh-plugin` 是 Awesome 列表的硬性自动检查项，必须加。**

---

## 3. 提交到 Awesome DSH Plugin 列表（PR）

### 3.1 门槛（自动检查）

- 仓库 **≥ 1 天** 且 **≥ 10 个 commit**
- package.json 声明 **`dsh.bundle`** manifest（本仓库已有 ✅）
- 带 **`dsh-plugin`** topic（见第 2 步）

未达标时，等几天 + 继续提交改进（如新增脚本、修文档、示例），凑够 commit 再提。

### 3.2 操作步骤（fork + 生成 + PR）

1. 打开 [awesome-dsh-plugin/awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) → **Fork**
2. 克隆你的 fork（Windows 或 NAS 均可，需要 git + Node 24）：

   ```bash
   git clone https://github.com/<你的用户名>/awesome-dsh-plugin.git
   cd awesome-dsh-plugin
   ```

3. 新建文件 `data/plugins/Coprexist__dsh-session-recovery.yml`，内容用本仓库 [`docs/awesome-entry.yml`](../docs/awesome-entry.yml)（注意 `category: session` 是**单数**，官方合法值见 awesome 仓库的 contributing.md）

4. 重新生成两个 README（该列表是**生成式维护**，README 勿手改）：

   ```bash
   npm ci
   node scripts/generate-readme.mjs
   ```

5. 提交并推送：

   ```bash
   git add data/plugins/Coprexist__dsh-session-recovery.yml README.md README.zh.md
   git commit -m "Add Coprexist/dsh-session-recovery"
   git push
   ```

6. 回 GitHub 网页：你的 fork 页 → **Contribute → Open pull request**，base 选 `awesome-dsh-plugin:main`，等维护者审核（可能要求微调描述/分类，正常现象）。

---

## 4. 本仓库脚本速查

| 脚本 | 用途 |
|---|---|
| `scripts/scan-zstd.js` | 全盘扫描 zstd 会话帧（只读块设备），输出事件 JSONL |
| `scripts/split-sessions.js` | 按 turn 重置 / 时间边界把混合事件拆成多个会话 |
| `scripts/rebuild-session.js` | 重建官方格式 `session.jsonl.zstd`（重编号 + 修引用 + surfaceOp + 逐行 checksum zstd） |
| `scripts/repair-session.js` | 修复重建后无法续接的会话（inbox splice / tool 配对） |
| `scripts/make-test-fixture.js` | 生成带损伤的样本会话，离线测试修复逻辑 |
| `scripts/recover-memory.js` | 定位 + 抢救 `memory.db`（SQLite `.recover`） |
| `lib/index.js`（插件） | 装为 dsh 插件后注册 `/session-repair` 命令，web 界面直接用 |

详细恢复流程见 [RECOVERY.md](../RECOVERY.md)。
