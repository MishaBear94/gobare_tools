# 从本地 Pi 到 Gobare 的项目迁移

这份文档描述用户把一个已经停止的本地 Pi coding agent 项目带到 Gobare 后，实际会经历什么。

目标不是导入一份聊天记录，而是把以下进展带到同一个云端项目中：代码与 Git 工作区、Pi 原生对话状态、可见的对话和工具历史，以及用户明确选择迁移的应用环境变量。导入完成后，用户可以在任意设备继续查看、通过 SSH 操作或让 Agent 继续工作。

## 你会得到什么

完成一次导入后，Gobare 会创建一个全新的项目。打开项目时可以直接看到：

- 本地 Pi 当前分支中的用户消息、助手回复和工具活动；
- 已迁移的代码、Git 提交、未提交改动和未跟踪文件；
- 一个可继续的 Pi 原生 checkpoint；
- 导入过程中识别出的运行时准备项，例如依赖安装，但这些操作不会自动执行；
- 仅当你下一次要求 AI 执行新任务时，才需要配置 Gobare 的模型。

不会迁移本机模型密钥、Git/OAuth/SSH 凭证、浏览器登录态、运行中的进程、Docker daemon 或 Pi 正在内存中等待的 follow-up/steering 队列。

## 开始前

在运行导入命令前，确认以下条件：

1. 本地 Pi 已经停止并退出。先完成或取消 pending approval、问题和 follow-up，再退出 Pi。Gobare 不会尝试冻结或控制另一个正在运行的 Pi 进程。
2. 你位于项目目录，或者知道项目目录的绝对路径。
3. 你知道要导入的 Pi session ID，或可提供 session 文件路径。
4. 你已在 Gobare Console 的 `Settings > Developer access` 创建 CLI access token。
5. 你想使用的 Gobare 项目名称尚不存在。同一个 organization 内，名称重复会被拒绝，不会覆盖、合并或自动改名已有项目。

## 旅程一：从 GitHub 安装 Gobare CLI

Gobare CLI 通过 GitHub Release 发布为 Node.js package。它不是独立原生二进制，因此本机需要 Node.js 22 或更高版本。

### 1. 从 Release 下载并校验

打开 [Gobare Tools Releases](https://github.com/MishaBear94/gobare_tools/releases)，下载同一个 release 中的：

- `gobare-tools-<version>.tgz`
- `SHA256SUMS`

在下载目录校验 package：

```bash
# macOS
shasum -a 256 -c SHA256SUMS

# Linux（通常可使用）
sha256sum --check SHA256SUMS
```

校验失败时删除下载文件并重新下载，不要安装。

### 2. 安装与确认版本

最简方式是直接从固定版本的 GitHub Release 安装：

```bash
npm install --global \
  https://github.com/MishaBear94/gobare_tools/releases/download/tools-v0.1.5/gobare-tools-0.1.5.tgz
gobare --help
```

需要先校验下载内容时，使用前一节的手动下载方式：

```bash
npm install --global ./gobare-tools-<version>.tgz
gobare --help
```

若团队要求验证 GitHub build provenance，可在 package 文件所在目录执行：

```bash
gh attestation verify gobare-tools-<version>.tgz \
  --repo MishaBear94/gobare_tools
```

安装完成后，`gobare` 命令可在任意本地项目目录使用。CLI 不会在安装期间读取 Pi session、项目文件或任何 Gobare 凭证。

不要使用 `npm install -g github:MishaBear94/gobare_tools`。那会从 Git source 而不是已构建的 Release package 安装，无法保证拿到 `dist/cli.js`、固定的 package checksum 或 release provenance。

## 旅程二：首次配置本机访问

### 1. 创建 access token

在 Gobare Console 中进入 `Settings > Developer access`，创建一个仅供本机 CLI 使用的 token。为它使用能辨识设备的名称，例如 `Markov MacBook Air`，并设置合适的过期时间。

完整 token 只显示一次。复制后立即在本机配置，不要把它放进 shell history、项目文件或 `.env`。

### 2. 在本机登录

推荐通过标准输入传入 token：

```bash
printf '%s' "$GOBARE_TOKEN" | gobare auth login --token
```

也可以让命令读取交互输入：

```bash
gobare auth login --token
```

完成后检查状态：

```bash
gobare auth status
```

CLI 会优先使用系统安全存储。退出本机登录时执行：

```bash
gobare auth logout
```

这只移除本机保存的引用，不会撤销 Console 中的 token。若设备丢失或不再可信，请在 Console 中撤销该 token。

## 旅程三：导入一个停止的 Pi 项目

假设当前目录就是项目目录，本地 Pi session ID 是 `019f8e39-b987-753c-b759-f85b0ba2b5fb`：

```bash
gobare pi import \
  --session 019f8e39-b987-753c-b759-f85b0ba2b5fb \
  --name "Checkout flow debugging" \
  --workspace .
```

命令会先在本机完成以下工作：

1. 通过 Pi 原生 API 读取已停止的 session，不改写原始 JSONL；
2. 收集可迁移工作区，包括 Git 历史、提交、staged/unstaged 改动和未跟踪文件；
3. 排除 `.env`、模型和云平台密钥、Git 凭证、SSH 私钥、浏览器资料和 Pi 认证状态；
4. 扫描高置信凭证形态。发现凭证时停止，不显示匹配内容；
5. 展示要创建的项目摘要并请求确认；
6. 创建新 Gobare 项目、加密上传 payload，并输出项目 URL。

自动化或 CI 使用非交互参数：

```bash
gobare pi import \
  --session 019f8e39-b987-753c-b759-f85b0ba2b5fb \
  --name "Checkout flow debugging" \
  --workspace . \
  --json --yes
```

`--json` 必须和 `--yes` 一起使用，避免自动化任务在确认提示处停住。

### 可选：先做无副作用预检

想先确认本地 Pi session、工作区和 token 是否可用时：

```bash
gobare pi import \
  --session 019f8e39-b987-753c-b759-f85b0ba2b5fb \
  --name "Checkout flow debugging" \
  --workspace . \
  --dry-run
```

预检不会创建 Gobare 项目、上传文件、创建 retry journal、唤醒云主机或调用模型。

## 旅程四：迁移应用环境变量

默认情况下，`.env` 文件不会迁移。若项目需要应用运行时环境变量，用户必须显式选择：

```bash
gobare pi import \
  --session 019f8e39-b987-753c-b759-f85b0ba2b5fb \
  --name "Checkout flow debugging" \
  --workspace . \
  --include-env
```

这会把允许迁移的应用变量放入该项目专属的 Gobare Environment profile。变量值不会进入 Pi JSONL、Git archive、CLI 输出、浏览器页面或 sandbox workspace。

以下内容不会通过 `--include-env` 迁移：模型/API key、GitHub token、SSH key、OAuth token、integration credential 和其他控制面凭证。它们需要在 Gobare 中重新连接或配置。

如果项目中有 `.env*` 文件但没有传入 `--include-env`，CLI 会停止，而不是假装已完成完整迁移。

## 旅程五：打开 Gobare 后自动恢复

CLI 成功输出项目 URL 后，直接在浏览器打开它。你不需要点击 `Restore project`，也不需要先配置模型。

页面会自动显示恢复进度和耗时：

1. `Restoring workspace`：恢复代码和 Git 工作区；
2. `Restoring Pi checkpoint`：用云端 Pi 原生能力打开导入的 session；
3. `Importing Pi history`：把当前 Pi branch 的用户、助手和工具历史投影到可见对话；
4. `Project restored`：代码、checkpoint 和可见历史均已就绪。

自动恢复不会执行 `install`、build、migration、dev server、Docker build、项目脚本或模型推理。若项目需要依赖安装，页面会将其作为单独、明确批准的准备操作展示。

恢复期间可以保持页面打开。完成后页面会自动刷新对话窗口，不需要浏览器刷新。长对话先显示最近一段，向上滚动可按需加载更早历史。

## 旅程六：恢复后的下一步

### 查看和检查项目

即使没有配置模型，也可以：

- 阅读导入的对话与工具历史；
- 检查文件和 Git 状态；
- 使用已配置的 SSH 能力；
- 配置项目 Environment profile；
- 导出 Pi 原生 session。

### 准备运行环境

如果页面显示运行时准备项，先阅读它将执行的固定命令，再点击 `Prepare`。这是一个单独的、可观察且可取消的操作；它不是导入的一部分，也不会执行任意项目脚本。

### 继续让 Agent 工作

只有在发送下一条新的 AI 任务前，才需要为 Gobare 项目连接模型。连接后直接在项目输入框发送新任务，Agent 会从导入的 Pi native checkpoint 继续，而不是把旧对话重新发送给模型或重放旧工具调用。

## 旅程七：中断、失败与恢复

### 上传中断

网络在上传中断后，不要使用同一个项目名重新创建导入。使用 CLI 输出的 transfer ID：

```bash
gobare pi import resume <transfer-id> --json --yes
```

CLI 会读取本机私有 retry journal，重新验证同一个停止的 Pi session 和工作区，只续传到原项目。若 session、工作区、环境变量或目标 server 已变化，CLI 会停止，要求你用新的项目名称创建新的导入，而不会把变化悄悄混入旧项目。

### 云端恢复失败

如果 workspace、Pi checkpoint 或 history projection 不能完成，项目页显示 `Restore failed` 和 `Retry restore`。点击后会重用已上传的加密 payload 与同一项目，不会要求重新上传、重新选择模型，也不会创建第二个 sandbox、第二份 checkpoint 或重复的对话历史。

不要尝试编辑本地 Pi JSONL、从 Gobare 对话复制粘贴内容，或手动修改云端历史来修复失败。Pi 原生 checkpoint 是唯一的可继续状态。

### 名称冲突

若 CLI 返回 `project_name_exists`，说明该 organization 已有同名 Gobare 项目。选择一个新的项目名称后重新导入；不要尝试导入到已有项目，因为 Gobare 不支持把两份 Pi state 合并到同一个项目。

## 旅程八：将云端 Pi session 带回本机

对于已完成的导入项目，可以导出最新 Pi 原生 checkpoint：

```bash
gobare pi export \
  --project <gobare-project-id> \
  --output ./restored-pi-session.jsonl
```

也可以在自动化场景中使用导入时返回的 transfer ID：

```bash
gobare pi export \
  --transfer <transfer-id> \
  --output ./restored-pi-session.jsonl
```

CLI 默认不会覆盖已有文件，并会通过本机 Pi 原生 `SessionManager.open()` 验证下载结果。确认要替换目标文件时才追加 `--force`。

导出只包含你的 Pi 原生 session checkpoint，不包含 Gobare 的模型凭证、Git/SSH/OAuth/integration 凭证、sandbox token 或浏览器登录态。

## 一条完整示例

```bash
# 1. 在 Console 创建 CLI access token 后，在本机配置它。
printf '%s' "$GOBARE_TOKEN" | gobare auth login --token

# 2. 可选：先做本地预检。
gobare pi import \
  --session 019f8e39-b987-753c-b759-f85b0ba2b5fb \
  --name "Checkout flow debugging" \
  --workspace . \
  --dry-run

# 3. 导入一个已经停止的 Pi 项目，并明确带入应用环境变量。
gobare pi import \
  --session 019f8e39-b987-753c-b759-f85b0ba2b5fb \
  --name "Checkout flow debugging" \
  --workspace . \
  --include-env

# 4. 打开 CLI 输出的 Gobare URL，等待自动恢复完成。
# 5. 在需要下一条 AI 任务时，再在 Gobare 中连接模型并继续。
```

## 用户检查表

- [ ] 本地 Pi 已停止并退出，未迁移的 pending follow-up 已处理。
- [ ] CLI access token 已在本机安全存储。
- [ ] 导入使用了一个新的 Gobare 项目名称。
- [ ] 需要迁移应用变量时使用了 `--include-env`。
- [ ] 已打开 CLI 返回的项目 URL，并等待自动恢复完成。
- [ ] 没有在恢复前配置模型或点击手动恢复按钮。
- [ ] 只在发送下一条新任务前连接模型。
- [ ] 上传中断时使用 `gobare pi import resume <transfer-id>`，而不是重名重新导入。
