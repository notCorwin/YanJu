# Structured Outputs 覆盖矩阵

每项能力同时具备入口、严格任务协议、持久化、展示、失败恢复和测试才标记通过。本矩阵对应 v4 协议；不实现旧版迁移或兼容。

## 协议与提交边界

- `src/lib/tasks.ts` 注册 16 类任务，`task-runner.ts` 共用真实 AI SDK 的 `generateText` / `streamText`，依次使用 Structured Outputs、JSON mode 和提示词 JSON。根对象与嵌套对象严格，所有输出字段必填，未知值用可空类型表达。所有模式本地校验，先修复 JSON 语法、明确类型与可空字段，仍不合格时附加具体字段路径与约束重新生成一次；取消、截断及渠道错误保留恢复记录。
- Provider 与模型统一从 Models.dev 获取，包含所有文本输入输出模型，以 `@ai-sdk/openai-compatible` 为主并覆盖全部官方语言模型 SDK 入口和模型级 SDK/API/协议覆盖。浏览器直接调用服务商，GitHub Pages 托管静态产物；Vertex Edge、MaaS、AWS SigV4/Mantle、Azure Foundry 保留各自认证与路由。社区 SDK 与自建兼容实现已移除。
- 七种端点（Chat Completions、Completions、Responses、Messages、Generate Content、Interactions、Google OpenAI Chat）与所有官方原生 SDK 均接入统一执行器，能力测试分别记录非流式和流式的实际模式，覆盖嵌套 schema 与本地修复；保留自动探测、模型默认温度与并发测试结果提交。Responses 的截断、拒绝、服务端失败和缺少终止事件不提交剧情，也不触发结构纠正。移除输出上限设置及输出预留预算；Anthropic 的必填容量使用 Models.dev 的模型完整输出容量，Vertex MaaS 的 SDK 默认输出限制也被移除。
- `NarrativeReply` 同轮包含正文和 `TurnEffects`。`SourceRef` 定位消息和段落；`new:study` 等请求内临时引用分配为 `<messageId>:entity:study`，随后使用稳定程序 ID。数据由 React 展示。
- `story.ts` 重放有效消息生成当前状态；完整消息、事件账本和状态投影在同一个事务中提交。状态跨轮延续，金额使用最小单位整数，日期由程序运算。
- 每次请求保存冻结事实、输入、schema、部分及完整输出、纠正、usage 和错误。普通续聊及纠正保留可重放前缀；摘要压缩不会修改已提交事实。
- IndexedDB 为 `yanju-v4`，OPFS 为 `yanju-v4/save.json`，存档 `version=4`。导入校验后原子替换并重建投影。原库与原文件保留原位。
- 历史编辑、改写和重说成功后建立新路线，原路线未来保留；失败不切换游玩节点。任务应用校验篇章版本，重复应用幂等，多窗口冲突拒绝覆盖。
- `GameSession` 保存游玩节点，`Branch` 保留路线最新节点；`HistoryNode` 引用不可变消息、任务、篇章设定和完整状态快照。节点与投影在同一事务提交，草稿与中断回合另存恢复状态。每条路线的最近 20 个自动存档只限制快捷列表，全部历史仍可回退。
- 分享包仅携带剧情资料；导入重映射引用并创建独立篇章。删除路线保留手动及快速存档，指定开局和恢复草稿参与历史清理的引用保留。OPFS 不可用时仍可使用全部本地存档与路线功能。

## 测试索引

以下缩写均指仓库中的实际测试：

| 标记 | 文件                                                                                                                               | 验证范围                                                                                                                                                      |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S    | `tests/unit/schemas.test.ts`                                                                                                       | 字段、枚举、非空、字数、数量、部分数据清洗                                                                                                                    |
| P    | `tests/unit/provider.test.ts`、`responses.test.ts`、`native-providers.test.ts`、`model-catalog.test.ts`、`output-fallback.test.ts` | Models.dev 全部文本模型与覆盖项、官方 SDK 请求、七端点与三种 JSON 模式及本地修复、浏览器认证与 Gateway 路由、双协议能力、纠正、截断、取消、Responses 生命周期 |
| D    | `tests/unit/story.test.ts`                                                                                                         | 稳定引用、状态、来源、关系与知情、日期、金额、增量交互、检索                                                                                                  |
| W    | `tests/unit/workflows.test.ts`                                                                                                     | 所有辅助任务、草稿应用、导入、改写、证据、媒体、本地操作、请求记录、生成期间删除篇章                                                                          |
| V    | `tests/unit/storage.test.ts`、`operations.test.ts`                                                                                 | v4 往返、独立新库、事务、编辑分支、幂等与版本冲突                                                                                                             |
| O    | `tests/unit/opfs.test.ts`、`game-history.test.ts`                                                                                  | OPFS 原子写入、仅 OPFS 恢复、失败重试、同步并发、存档校验、历史回退与分支保留                                                                                 |
| C    | `tests/unit/context.test.ts`、`context-prefix.test.ts`                                                                             | 完整预算、usage 校正、分批压缩回滚、实际请求前缀                                                                                                              |
| T    | `tests/unit/transport.test.ts`                                                                                                     | 流式持久化、冻结渠道与状态、取消、重说、冲突恢复                                                                                                              |
| E    | `tests/e2e/app.spec.ts`、`ui.spec.ts`、`providers.spec.ts`                                                                         | 桌面和移动 Chromium、移动 Safari 的完整流程、原生 SDK 和云认证、手动/快速存档、路线切换与分享往返                                                             |

## 逐项覆盖

入口中的「工作台」指聊天工具栏的「剧情工作台」。`tasks` 保存冻结输入、流式恢复和结果；`requests` 保存每次真实请求，均随 v4 存档导出。

| 阶段 | 能力                  | 入口                           | 任务协议                                              | 持久化                              | 展示                                       | 恢复                                              | 测试      | 状态 |
| ---- | --------------------- | ------------------------------ | ----------------------------------------------------- | ----------------------------------- | ------------------------------------------ | ------------------------------------------------- | --------- | ---- |
| 1    | 统一任务执行          | 聊天、工作台、渠道管理         | 16 类独立 schema 与输入类型                           | tasks、requests、messages           | 类型化部分及完整结果                       | 一次纠正、停止、重试                              | S/P/W/T/E | 通过 |
| 1    | Models.dev 渠道目录   | 渠道管理→Provider/模型下拉列表 | 全部文本模型、能力标记及模型级覆盖                    | channels、浏览器目录缓存            | 原生 SDK、容量和温度能力                   | 刷新目录、离线缓存、三种模式回退与流式/非流式测试 | P/E       | 通过 |
| 1    | 存档与路线            | 存档管理→存档与路线            | GameSession / Branch / HistoryNode / SaveSlot         | IndexedDB、OPFS 不可变版本          | 手动/快速/自动存档、回退、分支、设定、分享 | 完整状态恢复、无限历史、原未来保留、独立导入      | O/V/E     | 通过 |
| 1    | 渠道能力测试          | 渠道管理→测试渠道              | ChannelCapability：嵌套、数组、枚举、数字、布尔、null | channels、requests                  | 测试状态及失败原因                         | 支持确认后使用、可重测                            | P/E       | 通过 |
| 1    | v4 存档与工作数据库   | 存档管理→导入/导出             | SaveFile.version=4                                    | yanju-v4、OPFS                      | 同步与授权状态                             | 原子事务、同步重试、仅 OPFS 恢复                  | V/O/E     | 通过 |
| 1    | 请求记录与重放        | 工作台→任务→请求记录           | RequestRecord                                         | requests、冻结前缀                  | 状态、用量、错误、JSON 导出                | 保存每次纠正与部分结果                            | W/C/T/E   | 通过 |
| 1    | 请求预算              | 聊天用量、Models.dev 模型选择  | 输入+schema，容量来自 Models.dev，无输出预留设置      | channels 校正、archives.summary     | 估算和实际用量                             | 分批压缩回滚、保留原文                            | C/T/E     | 通过 |
| 2    | 正文、翻译和段落引用  | 聊天→叙事                      | NarrativeReply.blocks                                 | messages                            | 段落及翻译、可定位锚点                     | 清洗部分内容、一次纠正                            | S/P/T/E   | 通过 |
| 2    | 场景和角色引用        | 聊天、工作台→档案              | scene、speakerRef、effects.entities                   | messages、storyStates、storyEvents  | 场景、说话人与实体档案                     | 引用校验、新实体分配稳定 ID                       | D/T/E     | 通过 |
| 2    | 角色持续状态          | 工作台→档案→状态               | effects.states                                        | storyStates、storyEvents            | 跨轮最新状态和来源                         | 事务提交、历史重放                                | D/V/E     | 通过 |
| 2    | 关系和知情范围        | 工作台→档案→关系/知情          | effects.relationships、knowledge                      | storyStates、storyEvents            | 关系图、人物知情事实                       | 实体类型和来源校验                                | D/W/E     | 通过 |
| 2    | 剧情事件              | 工作台→档案→时间线             | effects.events                                        | storyEvents、storyStates            | 人物、地点、剧情时间和来源                 | 无效或部分消息不提交事件                          | D/V/W/E   | 通过 |
| 2    | 承诺与目标            | 工作台→档案→目标               | effects.goals                                         | storyStates、storyEvents            | open/done/cancelled、期限                  | 稳定记录更新、重建进度                            | D/W/E     | 通过 |
| 2    | 剧情日期与倒计时      | 聊天→日记、工作台时钟          | effects.clock                                         | storyStates、messages.diary         | 剧情日期、未知日期、程序倒计时             | 严格日期与跨月闰年运算                            | D/S/E     | 通过 |
| 3    | 长期事实和偏好        | 工作台→档案→记忆               | effects.memories                                      | storyStates、storyEvents            | 活跃事实、偏好和原文来源                   | 撤回事实、编辑失效、压缩不改事实                  | D/V/C/E   | 通过 |
| 3    | 上下文压缩            | 自动压缩、聊天→压缩上下文      | CompressionResult                                     | archives.summary                    | 原消息保留、用量更新                       | 一次纠正、分批原子更新、取消回滚                  | S/P/C/T/E | 通过 |
| 3    | 世界与 NPC 档案       | 工作台→档案→实体               | 固定实体+effects.entities                             | storyStates、原始设定               | 世界、角色、地点与筛选                     | 固定来源打开世界资料、动态来源定位                | D/W/E     | 通过 |
| 3    | 关系图和时间线        | 工作台→档案                    | relationships、events                                 | storyStates                         | 图形关系、按时间事件浏览                   | 分批展开、原消息定位                              | D/E       | 通过 |
| 3    | 自然语言剧情检索      | 工作台搜索、创作→搜索          | StorySearch                                           | tasks、requests                     | 人物/地点/时间/类别/关键词本地结果         | 查询重试、失效数据排除、来源链接                  | D/W/E     | 通过 |
| 4    | 叙事手机模块          | 聊天→手机                      | NarrativeReply.phone                                  | messages、storyStates               | 原有备忘/推荐/购买/联系人要求              | 完整数量和字数校验                                | S/D/E     | 通过 |
| 4    | 独立手机聊天          | 工作台→交互→手机               | PhoneReply                                            | interaction 消息、稳定会话 ID       | 原文和一条联系人回复、会话历史             | 取消保留输入、重试、原子追加                      | D/W/E     | 通过 |
| 4    | 备忘录和购买记录      | 工作台→交互→备忘/购买          | NarrativeReply.phone                                  | 稳定条目 ID、storyStates            | 条目、日期、币种金额、来源                 | 历史重建与来源定位                                | D/S/E     | 通过 |
| 4    | 日记与日历            | 工作台→交互→日记               | NarrativeReply.diary、clock                           | storyStates.diaries                 | 日期筛选、日历、未知日期                   | 日期校验、重新投影                                | D/E       | 通过 |
| 4    | 论坛新帖              | 聊天论坛模式、交互→新帖        | ForumReply：恰好 50 条回答                            | messages、稳定帖子和回答 ID         | 正文、50 条分批展开                        | 数量校验、取消与重试                              | S/D/W/E   | 通过 |
| 4    | 论坛增量回复          | 回答→回复、交互→论坛           | ForumAppend                                           | 用户原文+一条 NPC interaction       | 关联目标、持续累积、帖子历史               | 目标校验、取消保留输入、重复提交幂等              | D/W/E     | 通过 |
| 5    | 人设草稿              | 工作台→创作→人设               | PersonaDraft                                          | tasks、personas                     | 五个可编辑字段、保存后可选择               | 编辑后重新校验、冻结历史发送者                    | W/E       | 通过 |
| 5    | 开场生成              | 工作台→创作→开场               | NarrativeReply                                        | 核心消息和剧情事务                  | 完整叙事及各模块                           | 核心流式、取消、纠正、重试                        | S/P/T/E   | 通过 |
| 5    | 续写方向和剧情分支    | 工作台→创作→续写建议           | StoryContinuation：3 个唯一选项                       | tasks、用户选择后的新叙事           | 方向、行动、场景；选择后推进               | 应用前版本校验、生成失败可恢复                    | W/T/E     | 通过 |
| 5    | 篇章名称与简介        | 工作台→创作→篇章信息           | ArchiveMetadata                                       | tasks、archives                     | 可编辑名称、简介和关键词                   | 校验后保存、过期版本拒绝                          | W/E       | 通过 |
| 5    | 自然语言本地操作      | 工作台→创作→自然语言操作       | CommandIntent 枚举和参数                              | tasks、相关本地设置                 | 意图及执行入口                             | 当前目标校验、失效目标拒绝                        | W/E       | 通过 |
| 6    | 按模块/段落局部改写   | 工作台→创作→局部改写           | NarrativeRewrite                                      | tasks、原子替换 messages            | 完整预览、修改段落清单                     | ID/正文/翻译/关联字段复验，失败保留原文           | S/D/W/E   | 通过 |
| 6    | 人设及剧情一致性检查  | 工作台→创作→一致性检查         | StoryConsistency                                      | tasks                               | 问题类型、严重程度、位置、证据、建议       | 证据须属于引用消息与指定段落                      | W/E       | 通过 |
| 6    | 历史编辑和重说        | 聊天→编辑/重说                 | 原任务 schema 与交互判别类型                          | messages、storyEvents、storyStates  | 路线与不可变历史                           | 成功后创建路线，失败保留原进度                    | V/W/T/E   | 通过 |
| 6    | 单条消息删除          | 消息操作→删除消息              | 当前路线的选中消息                                    | messages、storyStates、历史节点     | 其他原文与序号保持，摘要失效并重建状态     | 取消保留、并发校验、备份分享及存档恢复            | V/E       | 通过 |
| 7    | 粘贴和 UTF-8 文本提取 | 工作台→资料                    | ContentExtraction                                     | tasks、原文 material 消息及 effects | 提取内容和未识别项预览                     | 应用前引用校验、原文保留、重试                    | W/E       | 通过 |
| 7    | 角色和世界 JSON 导入  | 工作台→资料→导入文件           | ContentExtraction                                     | tasks、来源及稳定实体               | 实体、关系、事实预览后保存                 | 应用存档拒绝进入资料入口                          | W/E       | 通过 |
| 7    | 章节整理              | 工作台→创作→章节整理           | StoryChapters                                         | tasks                               | 原文顺序章节、摘要与来源                   | 完整覆盖有效消息，禁止遗漏/重复/逆序引用          | W/E       | 通过 |
| 7    | 剧情 Markdown 导出    | 工作台→资料、章节结果          | 有效原文+StoryChapters                                | 下载 Markdown                       | 原文、翻译、论坛、交互与章节               | 仅导出有效完整记录，保留本地来源                  | W/E       | 通过 |
| 7    | 现有曲库配乐          | 工作台→媒体、原音乐面板        | MediaCue.trackId                                      | tasks、settings.autoMusic           | 推荐曲目、点击播放、自动配乐               | 已有曲目校验、播放失败提示                        | W/E       | 通过 |
| 7    | 背景与语音描述        | 工作台→媒体                    | MediaCue                                              | 可编辑 tasks.output、JSON 下载      | 背景和逐段语音描述                         | 保存复验目标与段落，空内容禁止导出                | W/E       | 通过 |

## 本地验收记录

### 全站视觉与引导验收

`tests/e2e/ui.spec.ts` 在桌面 Chrome、移动 Chromium 和移动 Safari 中覆盖以下交互；视觉参数统一来自 `src/styles/tokens.css`，组件继续复用 shadcn/ui。

- 首页首次进入依次经过 `#/setup/channels` 与 `#/setup/persona`：渠道测试并启用后才能继续，使用保存的人设后打开当前篇章。页面退出与浏览器返回均保护未保存修改；已有渠道继续当前篇章，聊天深链支持离线阅读。
- 封面入口立即可用，网络字体尚未响应时仍可进入应用；系统减少动态效果后，动画缩短且已有字体、字号和背景设置继续生效。
- 渠道默认折叠并支持独立展开、自定义名称与未保存修改保护；切换模型保留自定义名称。聊天顶部四个常用入口保持同一行，其他管理入口收在应用菜单；普通输入与长草稿均限制高度，短窗口、横屏和长文使用可展开的编辑器，阅读区至少占视口的 85%。流式完成保留同一消息的动画、已展开回答及焦点；结构化分区展开后内容可见。
- 世界与音乐由聊天顶部统一入口按需打开，首页保留播放器入口；面板保留标签、世界折叠、音量和循环状态；唱片跟随真实播放与暂停，收起浮窗和切换页面后音频继续播放，加载取消与失败重试沿用原流程。

2026-10-09 全站美化与引导的完整 `pnpm verify` 通过：17 个文件中的 238 个单元测试、170 个生产预览流程、Token 检查、ESLint、TypeScript 与生产构建全部成功。最终窄屏排版和浮窗位置调整另通过三套浏览器中的 36 项界面回归；推送前继续由仓库钩子执行完整验证。

2026-10-08 合并最新主分支前，完整 `pnpm verify` 通过：Design Token 检查、ESLint、TypeScript、10 个文件中的 141 个单元测试、52 个桌面与移动端 Playwright 流程及生产构建全部成功。37 项能力均已完成入口、协议、持久化、展示、恢复和测试。

请求验证使用真实 SDK 与模拟渠道，覆盖 Responses 和 Chat Completions；本地测试未调用生产模型，接入渠道时使用应用内能力测试确认。生成期间删除篇章不会重新写回任务，收到的结果仍保存在可导出的请求记录中，v4 存档继续支持完整往返。

GitHub Actions 仅负责合并到 `master` 后的现有 Pages 构建与发布。

## 审核回归

- 保存未启用的人设只提交人设和任务，不改变篇章版本、摘要或状态投影，同版本的其他任务仍可应用。
- 分支选择检查冻结版本，完整叙事成功提交后才标记已应用；发送被拒绝或生成失败时保留未应用状态。
- 章节整理必须按原顺序覆盖全部有效消息，Markdown 导出再次校验覆盖，过期结果提示重新整理。
- 无变化的改写在生成和应用时均拒绝，保留原摘要及后续剧情；仅修改关联模块的有效改写仍可应用。
- 工作台任务运行期间，即使面板关闭，聊天发送、编辑、重说、压缩及清空仍保持锁定，完成后恢复。
- 来源定位完成后仅移除对应消息和段落参数，继续生成不会重复跳转或夺走输入焦点。

## 主分支整合验收范围

- v4 增量 OPFS 索引及消息文件、事务内同步日志、全局导入锁和篇章操作锁。
- 来源定位支持分页历史；分区/JSON 编辑、单条展示恢复、分叉导航、单篇章导出和引用重映射后合并导入。
- 统一任务保留超时、首包、耗时、HTTP 状态和请求编号；完整渠道能力测试覆盖叙事、50 条回答及摘要。
- 使用最新稳定依赖、Node.js 26 和 pnpm 12；生产预览覆盖桌面 Chrome、移动 Chromium 和移动 Safari。
- 保留主分支的字段错误、未保存修改保护、回焦、移动输入、阅读位置和窄屏大字号界面；v4 分区编辑支持可空字段和剧情变化，独立论坛回复仍关联稳定回答 ID 并保存用户原文。
- 流式完成保留正在阅读的焦点，点击发送时才聚焦输入框；展开的论坛回答及其按钮焦点不会因最终提交丢失。

2026-10-08 整合主分支 `14255ec` 后，完整 `pnpm verify` 通过：11 个文件中的 164 个单元测试、105 个桌面 Chrome／移动 Chromium／移动 Safari 生产预览流程、Token 检查、ESLint、TypeScript 与生产构建全部成功。

2026-10-08 整合主分支 `518b728` 的界面更新后，完整 `pnpm verify` 再次通过：164 个单元测试、129 个桌面 Chrome／移动 Chromium／移动 Safari 生产预览流程、Token 检查、ESLint、TypeScript 与生产构建全部成功，包含 6 项审核回归及新增界面验收。

整合 `d555de` 的阅读焦点修复后，来源定位、续写重选和流式回答展开的 9 项回归在三套浏览器配置中通过；最终推送继续由仓库钩子执行完整 `pnpm verify`。

2026-10-09，存档重构整合主分支 `8370000` 后，本地验收通过：17 个文件中的 249 个单元测试、173 个桌面 Chrome／Firefox／移动 Chromium／移动 Safari 生产预览流程、Token 检查、ESLint、TypeScript 和生产构建。新增验收覆盖超过 20 个自动存档的历史回退、完整状态与草稿恢复、保留原未来、历史编辑和重说、生成与后台摘要取消、操作编号与节点校验、已删除路线的手动存档恢复、分享去除渠道资料、独立导入、全量备份及合并引用重映射。GitHub Actions 继续只负责 CD。
