# 宴雎

以宴雎角色与世界设定为背景的叙事聊天应用。在浏览器中连接自己的模型渠道，创建人设、推进剧情，并管理人物关系、长期记忆和不同故事分支。

应用是纯静态 SPA：模型请求由浏览器直接发送，聊天、人设和配置保存在当前浏览器，无需部署后端。

[在线体验](https://notcorwin.github.io/YanJu/) · [功能与协议覆盖矩阵](docs/structured-outputs-coverage.md) · [问题反馈](https://github.com/notCorwin/YanJu/issues)

## 主要功能

- **结构化叙事**：流式展示正文、场景、中英引语、方言翻译、角色状态、手机和日记；支持分区编辑与原始 JSON 编辑。
- **多模型渠道**：从 Models.dev 搜索 Provider 和模型，使用官方或社区 SDK 调用服务商，通过严格结构化输出测试后启用。
- **持续的剧情状态**：记录人物、地点、关系、知情范围、事件、事实、偏好和目标，来源可以定位到原消息与段落。
- **创作与交互**：生成人设和开场、选择续写方向、局部改写、检查一致性；支持独立手机聊天和持续追加的论坛回复。
- **存档与恢复**：自动保存、篇章分支、JSON 导入导出、合并导入和独立 Checkpoint；上下文压缩保留全部原始消息。
- **阅读与媒体**：适配桌面和移动端，可调整字体、字号和背景，播放曲库音乐，导出剧情 Markdown、媒体描述及请求记录。

## 开始使用

打开[在线应用](https://notcorwin.github.io/YanJu/)，或按下文启动本地开发服务。

1. 打开「渠道管理」，添加渠道，搜索并选择 Provider 和模型，填写 API Key；模型支持时可设置 Temperature。
2. 点击「测试渠道」。非流式和流式结构化测试均通过后，点击「使用此渠道」。需要进一步验证时，可运行「完整协议测试」。
3. 在「人设管理」中创建或选择人设，再打开「存档管理 → 新建」，为篇章命名并进入聊天。
4. 阅读开场并发送回应，也可切换论坛模式，或打开「剧情工作台」使用创作、检索和交互功能。

桌面端 `Enter` 发送、`Shift + Enter` 换行；移动端 `Enter` 换行，点击按钮发送。聊天与指令草稿会自动保存。

### 渠道配置

Provider、模型、API 地址、上下文容量与温度能力来自 Models.dev。目录只收录该 Provider 明确标记 `structured_output: true`、支持文本输入与输出的模型，不提供自定义 Provider、模型或地址。可手动刷新目录；网络不可用时可使用上次成功加载的浏览器缓存。

OpenAI SDK 渠道支持自动探测、Responses 和 Chat Completions；自动探测优先 Responses。其他 SDK 使用服务商原生协议。正式请求使用测试通过的协议，结构化输出失败不会降级为 JSON Mode。Responses 请求设置 `store: false`，应用在本地管理上下文。

服务商必须允许当前站点来源及认证、内容请求头的 CORS 请求，浏览器也需要能够访问目标网络。SDK 支持和模型目录标记不等于实际账户可用，请以应用内渠道测试结果为准。

通常直接粘贴 API Key 即可。需要多个认证字段的云服务，在同一字段粘贴凭据 JSON，字段名使用渠道提示中的 Models.dev `env` 名称。

<details>
<summary>云服务与本机模型的凭据说明</summary>

| Provider                 | 凭据内容                                                                                                                                                                                  |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Azure                    | `AZURE_API_KEY`、`AZURE_RESOURCE_NAME`；部署名与模型 ID 不同时，增加 `deployments`，将模型 ID 映射到部署 ID。                                                                             |
| Azure Cognitive Services | `AZURE_COGNITIVE_SERVICES_API_KEY`、`AZURE_COGNITIVE_SERVICES_RESOURCE_NAME`。                                                                                                            |
| Vertex                   | Gemini Express 可使用 API Key；标准模式、Claude 和 MaaS 可粘贴完整 service-account JSON，包含 `project_id`、`client_email`、`private_key`。可带 `GOOGLE_VERTEX_LOCATION`，默认 `global`。 |
| Bedrock（含 Mantle）     | Bedrock API Key，或 `AWS_ACCESS_KEY_ID`、`AWS_SECRET_ACCESS_KEY`、可选的 `AWS_SESSION_TOKEN`；`AWS_REGION` 默认 `us-east-1`。                                                             |
| SAP AI Core              | 导出的 service-key JSON：`clientid`、`clientsecret`、`url`、`serviceurls.AI_API_URL`；资源组默认 `default`。                                                                              |
| watsonx                  | `WATSONX_AI_APIKEY`、`WATSONX_AI_PROJECT_ID`。                                                                                                                                            |
| Cloudflare AI Gateway    | `CLOUDFLARE_API_TOKEN`、`CLOUDFLARE_ACCOUNT_ID`、`CLOUDFLARE_GATEWAY_ID`；在 Gateway 中配置上游认证。                                                                                     |
| 地址含资源占位符的服务商 | 包含目录所列认证字段与资源字段，例如 `SNOWFLAKE_ACCOUNT`、`SNOWFLAKE_CORTEX_PAT`。                                                                                                        |

QVAC 使用本机 external HTTP 服务 `http://127.0.0.1:11435/v1`，需先启动该服务并允许应用来源访问。浏览器不会启动 Node.js CLI，也不能读取凭据文件路径；服务账户请粘贴 JSON 内容。

认证与路由的实现见 [provider-model.ts](src/lib/provider-model.ts) 和 [browser-providers.ts](src/lib/browser-providers.ts)。

</details>

## 剧情工作台

进入篇章后，从聊天工具栏打开「剧情工作台」。六个入口共用当前篇章的剧情与历史记录。

| 入口 | 用途                                                                                                         |
| ---- | ------------------------------------------------------------------------------------------------------------ |
| 档案 | 浏览世界与 NPC、人物状态、关系图、知情范围、事件时间线、事实、偏好和目标；搜索并定位原文来源。               |
| 交互 | 与联系人独立聊天，查看备忘录、购买记录和日记日历；创建论坛帖子并继续回复。新帖生成 50 条回答，后续增量追加。 |
| 创作 | 生成人设与开场、篇章名称与简介、三个续写方向，执行局部改写、一致性检查、章节整理和自然语言操作。             |
| 资料 | 粘贴或导入 UTF-8 文本、Markdown、角色与世界 JSON，提取实体、关系和事实，预览后保存。                         |
| 媒体 | 推荐并播放现有曲库音乐，编辑、保存和导出背景与语音描述；导出剧情 Markdown。                                  |
| 任务 | 查看流式结果、部分内容和错误，重试未完成任务，导出冻结输入、schema、用量与错误等请求记录。                   |

例如，在「创作」中选择「续写分支」，输入 `给当前剧情提供3个不同的后续分支。`；生成结果后选择一个方向，才会推进剧情。媒体入口生成的是背景与语音**描述**，可导出 JSON。

各项功能的协议、持久化、恢复行为与测试入口见[覆盖矩阵](docs/structured-outputs-coverage.md)。

## 存档与数据

IndexedDB 是工作数据库，提交后自动同步到 OPFS（浏览器的源私有文件系统）。`yanju-v3/save.json` 保存索引，消息和背景图片分别存储；工作数据库为空时，启动会尝试从 OPFS 恢复。

| 操作                  | 行为                                                                                                  |
| --------------------- | ----------------------------------------------------------------------------------------------------- |
| 导出全部 / 导入       | 导出完整 v3 JSON 存档；导入先校验并确认，再替换当前浏览器的全部资料。                                 |
| 单篇章导出 / 合并导入 | 导出指定篇章，或保留现有资料并合并导入；编号冲突时重映射引用。                                        |
| 分支 / 重说           | 从指定消息创建独立篇章；重说成功后保存原分支并替换，失败保留原分支。                                  |
| Checkpoint            | 在「存档管理 → Checkpoint」创建、导入、导出、恢复或删除完整快照。导入只保存快照，恢复才替换工作资料。 |

- 数据保存在当前浏览器和站点来源下，本地服务与在线应用各有独立存储。跨浏览器或设备继续使用时，先导出再导入；`#/chat/<archiveId>` 链接只打开本地已有篇章。
- 完整存档和 Checkpoint 包含渠道凭据、任务、请求、人设、草稿与外观。请求记录的单独导出不包含认证头或渠道 Key。导入存档或恢复 Checkpoint 后，渠道须重新测试。
- 应用会请求持久存储授权，结果由浏览器决定。清除站点数据会移除 IndexedDB 和 OPFS；未获授权的数据也可能被浏览器清理，请用导出文件保留备份。
- 存档面板显示同步状态并提供失败重试。OPFS 不可用或同步失败时，聊天、IndexedDB 读写和 JSON 导入导出仍可使用；Checkpoint 需要 OPFS。
- 当前仅使用 `yanju-v3` 数据库和版本 3 应用存档，不读取旧库或 localStorage，不导入 v1/v2 应用存档。

## 本地开发

### 环境与启动

需要 **Node.js 26.11.1+** 和 **pnpm 12.10.1**。Node 版本记录在 [.nvmrc](.nvmrc)，包管理器与脚本记录在 [package.json](package.json)。使用 nvm 时可执行 `nvm install`、`nvm use`。

```sh
git clone https://github.com/notCorwin/YanJu.git
cd YanJu

npm install --global pnpm@12.10.1
pnpm install --frozen-lockfile
pnpm dev
```

打开终端显示的地址，默认是 `http://127.0.0.1:5173/YanJu/`。无需 `.env` 或构建时 API Key；运行应用后，在渠道管理中填写自己的凭据。

### 常用命令

| 命令                           | 用途                                              |
| ------------------------------ | ------------------------------------------------- |
| `pnpm dev`                     | 启动开发服务器。                                  |
| `pnpm build`                   | 执行 TypeScript 编译检查，生成 `dist/` 静态产物。 |
| `pnpm preview`                 | 本地预览已有生产构建。                            |
| `pnpm check:tokens`            | 检查组件和样式是否遵循统一 Design Tokens。        |
| `pnpm lint` / `pnpm typecheck` | 运行 ESLint / TypeScript 检查。                   |
| `pnpm test`                    | 运行 Vitest 单元测试。                            |
| `pnpm test:e2e`                | 通过独立开发服务运行 Playwright。                 |
| `pnpm test:e2e:production`     | 通过独立生产预览服务运行 Playwright，需先构建。   |
| `pnpm verify`                  | 顺序执行全部本地验收。                            |

### 技术栈与目录

| 技术                      | 用途                                                            |
| ------------------------- | --------------------------------------------------------------- |
| React 19、Vite 8          | 界面、开发服务与静态构建。                                      |
| TypeScript 7              | 原生编译器负责构建与类型检查；TypeScript 6 API 供 ESLint 使用。 |
| Tailwind CSS 4、shadcn/ui | 基于统一 Design Tokens 的样式与交互组件。                       |
| Vercel AI SDK 7、Zod 4    | 模型调用、流式结构化输出与数据校验。                            |
| Dexie、IndexedDB、OPFS    | 工作数据库、事务与文件存档。                                    |
| Vitest、Playwright        | 单元测试与跨浏览器验收。                                        |

```text
src/
├── app/              # 初始化、工作区与 Hash 路由
├── features/         # 渠道、人设、聊天、外观、存档、世界与音乐
├── components/       # 剧情工作台、结果展示与共享组件
│   └── ui/           # shadcn/ui 组件
├── content/          # 角色、文风、开场、世界、指令与曲库
├── lib/              # 模型、任务协议、上下文与剧情状态
│   └── storage/      # 数据库、事务、消息与导入导出
└── styles/           # Design Tokens 与应用样式
tests/unit/           # 单元测试
tests/e2e/            # 浏览器测试
docs/                 # 功能与协议文档
scripts/              # 本地检查脚本
.githooks/            # 推送前验收
.github/workflows/    # GitHub Pages CD
```

调整角色与内容时，从 [src/content](src/content) 入手：`character.txt` 是角色资料，`narrative-rules.txt` 和 `style.txt` 控制叙事规则与文风，`opening.txt` 是默认开场；`world.json`、`commands.json`、`music.json` 分别提供世界资料、常用指令和曲库。

### 开发约定

- **统一视觉规范**：优先复用 [shadcn/ui 组件](src/components/ui)。[tokens.css](src/styles/tokens.css) 是颜色、字体、间距、圆角、边框、阴影和动效的唯一来源；样式主要通过 Tailwind 语义类实现，外观设置只修改根 Token。
- **严格任务协议**：[tasks.ts](src/lib/tasks.ts) 注册 16 类任务，核心回复 schema 位于 [schemas.ts](src/lib/schemas.ts)。共用执行器、预算、请求记录和恢复流程；结构或内容校验失败最多纠正一次，取消、截断和网络错误不自动重发。
- **完整提交与来源**：完整回复通过校验后，与剧情事件和状态在同一个 IndexedDB 事务中提交。实体使用稳定 ID，事实携带消息及段落来源；历史编辑会使后续剧情失效并重建状态。
- **本地上下文管理**：估算计入设定、人设、schema、摘要和有效历史，并用实际 usage 校正。输入预算达到 85% 时自动压缩，目标为 70% 以下；保留最近完整对话及全部原文，压缩失败保留原摘要。应用不提供可选输出上限设置。
- **技术选型**：使用最新稳定技术栈，依赖以锁文件为准；不要求旧版迁移或向后兼容。新增能力同步维护[覆盖矩阵](docs/structured-outputs-coverage.md)及相应测试。

## 本地验收

首次运行浏览器测试前安装所需引擎，并启用推送前钩子：

```sh
pnpm exec playwright install chromium firefox webkit
pnpm setup:hooks
pnpm verify
```

`verify` 依次运行 Design Token 检查、ESLint、TypeScript、Vitest、生产构建和 Playwright。浏览器测试覆盖桌面 Chrome、移动 Chromium、移动 Safari，并使用 Firefox 验证渠道协议与跨域预检。测试使用模拟模型和真实 SDK 协议，无需真实 API Key。

Playwright 启动当前工作目录的独立服务，不复用已有服务。默认端口为 `5173`，被占用时可指定其他端口：

```sh
YANJU_E2E_PORT=5174 pnpm verify
```

[pre-push 钩子](.githooks/pre-push)在每次推送前执行完整 `pnpm verify`。所有 CI 相关检查在本地执行，GitHub Actions 仅负责 CD。真实账户和网络下的渠道能力，由应用内测试确认。

## 部署

本地验收通过后，提交并推送到主分支 **`master`**。[部署工作流](.github/workflows/deploy.yml)会安装锁定依赖、构建并发布到 GitHub Pages，也支持手动触发。

仓库的 Pages 设置中，将 **Build and deployment → Source** 设为 **GitHub Actions**。[vite.config.ts](vite.config.ts) 的 `base` 为 `/YanJu/`，产物位于 `dist/`；部署到其他路径时须相应调整 `base`。

音乐与网络字体依赖外部资源。字体异步加载，未加载时使用本地衬线字体。

## 维护、贡献与支持

项目由 [notCorwin](https://github.com/notCorwin) 维护，欢迎提交问题和改进建议。

- 查阅[功能与协议覆盖矩阵](docs/structured-outputs-coverage.md)，了解已有能力、恢复边界与测试位置。
- 通过 [GitHub Issues](https://github.com/notCorwin/YanJu/issues)反馈问题，附上复现步骤、浏览器、Provider、模型与错误信息；需要时附去除私人内容的请求记录。
- 贡献修改前启用本地钩子，遵循上述开发约定；相关测试及 `pnpm verify` 通过后提交。仓库维护流程默认直接推送 `master`，外部贡献者可通过 [Pull Request](https://github.com/notCorwin/YanJu/pulls) 提交修改。
