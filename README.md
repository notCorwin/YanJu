# 宴雎

一个以宴雎角色资料为背景的叙事聊天应用。保留人设、多个模型渠道、场景、状态、手机、日记、论坛、音乐和本地存档，使用严格结构化输出与 React 组件呈现内容。

在线应用：[notcorwin.github.io/YanJu](https://notcorwin.github.io/YanJu/)

## 本地开发

需要 Node.js 26.11.1+ 和 pnpm 12.10.1；`.nvmrc` 与部署环境使用相同版本。

```sh
pnpm install --frozen-lockfile
pnpm dev
```

访问终端显示的 `/YanJu/` 地址。应用是纯静态 SPA，不需要后端或构建时 API Key。

首次使用时打开「渠道管理」，从下拉列表选择 Provider 和模型，填写 API Key，按需设置 Temperature，运行「测试渠道」，通过后点「使用此渠道」。服务商、模型、SDK、API 地址、输入与上下文容量及温度能力均来自 [Models.dev](https://models.dev/)。只列出该 Provider 明确标记 `structured_output: true` 的文本模型；支持模型级 SDK、API 和协议覆盖，不提供自定义 Provider、模型或地址。目录可刷新，浏览器缓存用于网络不可用时恢复最后一次成功加载的数据。

请求全部由浏览器直接发送，GitHub Pages 只托管静态文件。以 Vercel AI SDK 的 `Output.object` 为统一执行入口，覆盖当前 Models.dev 的全部 SDK 类型，官方与社区 SDK 按需加载。Vertex 使用 Edge 入口；SAP orchestration v2、GitLab Duo direct access 和 QVAC external HTTP 使用同协议的浏览器适配，支持非流式与流式结构化生成。Cloudflare Gateway 使用其 SDK 的 Unified 路由，保留完整 Provider/model ID。没有符合条件模型的 SDK 暂不显示在目录中。

OpenAI SDK 渠道可通过下拉列表选择自动探测、Responses 或 Chat Completions；自动探测优先 Responses。其他 SDK 使用服务商原生协议。测试检查非流式和流式的嵌套严格 schema；正式请求使用通过测试的协议，失败不降级到 JSON Mode。Responses 请求设置 `store: false`，上下文由本地完整管理。

Provider 必须通过 CORS 允许本站来源以及其认证和内容请求头；浏览器也必须允许访问目标网络。纯前端无法绕过服务商拒绝的 CORS。SDK 覆盖和协议测试不代表任意账户、地区或网络下的服务必然可用；真实连接由用户凭据、服务商授权和应用内测试共同确认。

仅需要单个 Key 的服务商直接粘贴 Key。需要云账户信息的服务商在同一 API Key 字段粘贴凭据 JSON，认证字段使用 Models.dev 的 `env` 名称，或以下服务商导出的凭据结构；不增加自定义地址设置：

| Provider                 | API Key 凭据内容                                                                                                                                                                                                      |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Azure                    | `AZURE_API_KEY` 与 `AZURE_RESOURCE_NAME`；部署名称不等于模型 ID 时，在凭据内提供 `deployments` 的模型 ID 到部署 ID 映射                                                                                               |
| Azure Cognitive Services | `AZURE_COGNITIVE_SERVICES_API_KEY` 与 `AZURE_COGNITIVE_SERVICES_RESOURCE_NAME`                                                                                                                                        |
| Vertex                   | Gemini 支持 Express API Key；标准模式、Claude 和 MaaS 可粘贴完整 service-account JSON（`project_id`、`client_email`、`private_key`）；凭据可带 `GOOGLE_VERTEX_LOCATION`，默认 `global`，MaaS 地址从项目与区域自动展开 |
| Bedrock（含 Mantle）     | Bedrock API Key，或 `AWS_ACCESS_KEY_ID`、`AWS_SECRET_ACCESS_KEY`、可选 `AWS_SESSION_TOKEN`；`AWS_REGION` 默认 `us-east-1`                                                                                             |
| SAP AI Core              | 导出的 service-key JSON（`clientid`、`clientsecret`、`url`、`serviceurls.AI_API_URL`），自动查询运行中的 orchestration 部署；资源组默认 `default`                                                                     |
| watsonx                  | `WATSONX_AI_APIKEY` 与 `WATSONX_AI_PROJECT_ID`                                                                                                                                                                        |
| Cloudflare AI Gateway    | `CLOUDFLARE_API_TOKEN`、`CLOUDFLARE_ACCOUNT_ID`、`CLOUDFLARE_GATEWAY_ID`；上游认证在 Gateway 配置                                                                                                                     |
| 地址含资源占位符的服务商 | JSON 中包含 Models.dev 所列 Key 与地址中的资源字段，例如 `SNOWFLAKE_ACCOUNT`、`SNOWFLAKE_CORTEX_PAT`                                                                                                                  |

QVAC 使用 SDK 的 external HTTP 默认地址 `http://127.0.0.1:11435/v1`，本机服务须在该端口运行并允许 Pages 来源访问。浏览器不能启动其 Node.js CLI 或读取本机凭据文件路径；服务账户请粘贴 JSON 内容。

## 技术与设计

- Vite 8、React 19、TypeScript 7、Tailwind CSS 4、shadcn/ui、AI SDK 7、Zod、Dexie。TypeScript 7 原生编译器与 ESLint 所需的 TypeScript 6 API 按[官方并行配置](https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/#running-side-by-side-with-typescript-6-0)安装。
- `src/styles/tokens.css` 是颜色、字体、字号、间距、圆角、边框、阴影与动效的唯一来源，映射到 Tailwind 语义工具类。外观设置只修改根 Token。`pnpm check:tokens` 阻止组件新增裸视觉值，包含 shadcn 源码。
- 使用官方 shadcn MessageScroller / Message / Bubble，Field / InputGroup，Card / Accordion / Dialog / Sheet。共享组件和变体统一视觉与触控尺寸。
- 角色、人设规则、文风、开场白、世界和常用指令保存在 `src/content`。文本不再嵌入脚本边界。源代码按应用、渠道、人设、聊天、外观、存档和世界功能拆分，存储逻辑集中在 `src/lib/storage`。
- Hash 路由 `#/chat/<archiveId>` 支持存档链接及刷新；链接载入当前浏览器已有的存档，跨浏览器需要先导入存档。

渠道与人设编辑器支持字段级提示、未保存修改保护和关闭后的键盘回焦，桌面、窄屏及横屏共用同一套组件与视觉 Token。结构化回复可按正文、场景、状态、手机、日记或论坛分区编辑，也保留原始 JSON 编辑。存档支持搜索和创建时命名；聊天和指令草稿自动保存，移动端 Enter 换行、点击发送，桌面 Enter 发送、Shift + Enter 换行。

## 回复协议

`src/lib/tasks.ts` 注册全部任务，核心回复 schema 位于 `src/lib/schemas.ts`。每个任务使用独立严格根对象：

| 请求              | 内容                                                             |
| ----------------- | ---------------------------------------------------------------- |
| NarrativeReply    | 场景和中英引语、叙述、方言与普通话翻译、状态、手机、日记与倒计时 |
| ForumReply        | 帖子与完整 50 条回答，新帖完整生成，后续回复增量追加             |
| CompressionResult | 人物关系、时间地点、关键事件、决定和未完成事项                   |
| ChannelCapability | 嵌套对象、数组、枚举、数值、布尔与可空字段的渠道能力测试         |

叙事同轮生成 `TurnEffects`：实体、状态、关系、知情范围、事件、长期事实与偏好、目标和剧情时钟。既有实体使用程序 ID，`new:` 临时引用由程序分配稳定 ID；事实携带消息和段落来源。完整回复、事件记录和当前状态在同一个 IndexedDB 事务中保存。剧情日期及倒计时由程序计算，未知日期显示「未知」。金额采用币种最小单位整数。

其余 12 类按需任务分别处理手机回复、论坛回复、搜索条件、人设草稿、名称与简介、续写分支、改写、一致性检查、资料提取、章节、媒体描述和本地操作意图。输入冻结为明确的类型契约，输出使用独立严格 schema。所有任务共用执行器、预算、一次纠正、请求记录和恢复方式。

浏览器 ChatTransport 连接 `useChat` 与 `streamText` / `Output.object`。部分对象以带固定 ID 的类型化 UIMessage 数据部件逐步更新，完整对象经过结构与条数、字数、非空校验后标记完成。数据型助手消息会序列化回模型上下文，避免连续对话遗失助手内容。

结构或内容校验失败最多追加一次同 schema 纠正；网络、渠道不支持、取消及输出截断不自动重发。部分回复定期保存，停止时提交恢复记录。失败与取消可重试；重说只有在成功后才原子替换原分支。模型输出不包含界面代码。新版使用独立的数据协议。

## 上下文与存档

上下文和输入容量从 Models.dev 读取。应用不提供或保存输出上限，聊天、工作台任务、纠正和摘要请求均不设置可选输出限制。Anthropic API 必填 `max_tokens`，由 Models.dev 公布的模型完整输出容量填充，避免 SDK 的较小默认值；实际容量仍由服务商决定。估算计入角色资料、人设、schema、摘要、冻结事实与状态和有效历史，以中英文混合的保守估算及服务商实际 usage 校正；界面分别显示当前估算和上次实际输入/输出。

发送前与完成后检查输入预算，达到 85% 时自动压缩，以 70% 以下为目标。默认保留最近 4 轮完整对话及当前输入；必要时减少到至少最新完整一轮及当前输入。较大历史按输入预算分批生成同渠道严格摘要。覆盖边界与会话版本一并校验，全部成功后一次性更新。无法容纳固定设定和最新输入时，提示选择容量更大的模型或缩短输入，保留原记录。

压缩不删除消息。编辑已覆盖消息和从覆盖位置重说会使摘要失效，从原文重建。压缩失败/取消保留原摘要与全部原文，并提供重试操作。已取消或失败的部分助手回复不作为完成的模型历史发送。

在渠道、模型、人设、回复协议及摘要保持不变时，普通续聊只在已发送上下文末尾追加消息。校验纠正请求中的追加消息随助手记录持久化，刷新或导入存档后继续重放；失败的部分回复仍不作为完成历史。压缩会重建摘要和历史前缀，这是正常的上下文重置边界；同一摘要下的后续对话继续追加。编辑、重说以及切换渠道、人设或回复协议也会改变上下文，服务端缓存命中还取决于渠道支持、缓存有效期和路由，不能保证每次请求都命中。

IndexedDB 作为工作数据库保存消息、存档、渠道、人设、外观和摘要；所有提交通过事务内变更日志自动同步到 OPFS；`yanju-v3/save.json` 保存索引，消息使用不可变文件增量保存，背景图片独立保存。写入通过 `createWritable()` / `close()` 原子替换，支持 Web Locks 的浏览器按同源锁串行同步。完整回复、失败恢复记录和停止生成都会等待最终同步；完成后的自动压缩在后台继续，不阻塞存档载入、导出及下一轮聊天。工作数据库为空时，启动优先校验并恢复 OPFS 存档，保留同浏览器渠道测试状态；不可解析的旧文件在写入新存档前保留到 `save-recovery.json`。

应用会请求 `navigator.storage.persist()`，授权结果由浏览器决定；OPFS 文件可跨刷新和浏览器重启保存，但未获持久存储授权时仍可能被浏览器清理。存档面板显示同步和授权状态。OPFS 不受支持或同步失败时，保留 IndexedDB 读写、载入、导出和聊天功能，并在面板提供说明及失败重试。清除站点数据会同时移除 OPFS 和 IndexedDB；需要跨浏览器恢复时请先导出文件。

「存档管理 → Checkpoint」将独立完整快照保存到 `yanju-v3/checkpoints/<UUID>.json`，包含剧情、任务、请求、人设、渠道凭据、草稿与外观。支持创建、导出、导入、恢复和删除。导入先校验，再使用新 ID 存入 OPFS，保留当前工作进度；恢复确认后原子替换工作资料、同步自动存档并重新载入草稿，渠道须重新测试。删除只移除选中的 Checkpoint。Checkpoint 不回退到其他存储；不支持 OPFS 的浏览器仍可使用原有 JSON 存档导入导出。

新版只使用 `yanju-v3` 数据库与版本 3 存档，不读取旧库或 localStorage，不导入 v1/v2 应用存档，原资料保留在原位置。v3 包含消息、冻结请求、剧情事件、状态投影、任务结果、渠道 Key、外观及摘要边界。导入替换前校验完整数据并显示确认操作。

编辑历史消息会使后续剧情失效并重建状态；失效记录仍可查看，但不进入有效上下文。局部改写返回完整替换对象及修改段落清单，保留原段落 ID，合并后的正文、翻译、状态和引用全部重新校验。重说失败保留原分支，成功后先将原分支保存为独立篇章，再原子替换受影响分支。可从指定消息创建分支，单独导出篇章或合并导入；编号冲突时重映射消息、实体及来源引用。

支持 Web Locks 的浏览器通过篇章锁防止多窗口同时生成、编辑或删除；其他浏览器使用可续期的数据库租约。导入持有全局锁，避免旧窗口排队写入恢复后的同名篇章。聊天默认显示最近 60 条消息，可按需加载更早内容。消息支持分区编辑和 JSON 编辑；局部展示错误可恢复、编辑与导出。请求可配置首包及后续内容等待上限，并保留耗时、HTTP 状态与请求编号。渠道的「完整协议测试」运行完整叙事、50 条论坛回答及压缩样例，测试结果不写入剧情。

## 剧情工作台

聊天工具栏的「剧情工作台」提供六个入口，桌面和移动端共用：

- **档案**：实体与世界、NPC、状态、关系图、知情范围、事件时间线、事实与偏好、承诺。搜索结果及档案来源可定位到原消息和段落。
- **交互**：独立联系人会话、备忘录、购买记录、日记日历和论坛历史。独立手机输入按原文保存并追加一条联系人回复；论坛首次生成 50 条回答，后续每次追加用户原文和一条关联 NPC 回复，数量持续累积并分批展开。
- **创作**：可编辑保存的人设、完整开场、三个续写方向、用户选择的剧情分支、篇章名称与简介、局部改写、一致性检查、章节整理和自然语言操作。操作先显示意图，再执行查询、切换模式、选择曲目、打开档案或会话。
- **资料**：粘贴文本，或导入 UTF-8 文本、Markdown、角色与世界 JSON；提取实体、关系、事实和未识别内容，预览后保存。应用存档通过存档管理导入，只接受 v3。
- **媒体**：从现有曲库推荐配乐，点击或开启自动配乐后播放。背景与语音描述可编辑保存并导出 JSON；剧情可直接导出 Markdown，也可先整理章节。
- **任务**：查看流式结果、错误和部分内容，重试未完成任务；导出包含冻结消息、严格 schema、实际用量和错误的请求记录。请求记录不包含认证头或渠道 Key。

逐项入口、协议、持久化、展示、恢复与测试见 [覆盖矩阵](docs/structured-outputs-coverage.md)。

## 本地验收

```sh
pnpm exec playwright install chromium webkit
pnpm setup:hooks
pnpm verify
```

`verify` 顺序执行 Token 检查、ESLint、TypeScript、Vitest、生产构建及桌面 Chrome、移动 Chromium、移动 Safari Playwright。测试使用模拟模型与真实 SDK 协议，不需要真实密钥。真实渠道由用户配置后在应用内执行能力测试。

`pnpm verify` 的 Playwright 启动当前工作目录的独立生产预览服务，不复用已有服务，避免多个 worktree 之间误测其他版本。`pnpm setup:hooks` 安装推送前钩子，每次推送执行完整本地验收。默认使用 5173 端口；端口已被占用时，可用 `YANJU_E2E_PORT=5174 pnpm verify` 指定其他端口。

重点覆盖严格参数、缺字段、非空和数量、部分对象更新、一次纠正、取消/截断/重试、稳定引用与事实来源、知情范围、日期与金额、事务回滚、重复提交、多窗口冲突、编辑失效与重说、冻结前缀、分批压缩、旧版拒绝、v3 往返及 OPFS 恢复。桌面和移动端流程覆盖论坛追加、独立手机、来源定位、人设编辑、分支选择、改写、导入预览、媒体与请求记录导出。

UI 回归还覆盖字段错误与未保存修改、焦点恢复、可点击的标签页、分区编辑、长草稿与最大字号、320px 窄屏及横屏、流式结束后的阅读状态、存档搜索与失效链接、音乐加载失败与音量状态，以及网络字体未响应时的正常使用。

## 发布

本地验收通过后提交并推送功能分支，通过面向 `master` 的 PR 发布。`.github/workflows/deploy.yml` 仅负责 CD：安装锁定依赖、构建、上传 Pages artifact 并发布。CI 检查在本地完成。

GitHub 仓库须为公开的 `notCorwin/YanJu`，Pages 的 Build and deployment / Source 设为 GitHub Actions。Vite `base` 已设为 `/YanJu/`。音乐与网络字体由原有公开资源/字体服务提供；网络字体异步加载，未加载时使用本地衬线字体，保留界面显示和操作。

背景上传、替换和移除显示保存状态。图片随 OPFS 检查点和 v3 JSON 存档一并保存；界面使用可释放的 Blob URL 预览。
