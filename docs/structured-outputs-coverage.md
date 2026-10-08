# Structured Outputs 覆盖矩阵

每项能力同时具备入口、严格任务协议、持久化、展示、失败恢复和测试才标记通过。本矩阵对应 v3 协议；不实现旧版迁移或兼容。

## 协议与提交边界

- `src/lib/tasks.ts` 注册 16 类任务，`task-runner.ts` 共用真实 AI SDK 的 `Output.object`、`json_schema` 和 `strict: true`。根对象与嵌套对象严格，所有输出字段必填，未知值用可空类型表达。结构和业务错误最多纠正一次；取消、截断及渠道错误保留恢复记录。
- 保留 `master` 的 Responses / Chat Completions 选择、自动探测、模型默认温度与并发测试结果提交。两种协议均接入统一执行器，能力测试覆盖非流式和流式嵌套 schema；Responses 的截断、拒绝、服务端失败和缺少终止事件不提交剧情，也不触发结构纠正。
- `NarrativeReply` 同轮包含正文和 `TurnEffects`。`SourceRef` 定位消息和段落；`new:study` 等请求内临时引用分配为 `<messageId>:entity:study`，随后使用稳定程序 ID。数据由 React 展示。
- `story.ts` 重放有效消息生成当前状态；完整消息、事件账本和状态投影在同一个事务中提交。状态跨轮延续，金额使用最小单位整数，日期由程序运算。
- 每次请求保存冻结事实、输入、schema、部分及完整输出、纠正、usage 和错误。普通续聊及纠正保留可重放前缀；摘要压缩不会修改已提交事实。
- IndexedDB 为 `yanju-v3`，OPFS 为 `yanju-v3/save.json`，存档 `version=3`。导入校验后原子替换并重建投影。原库与原文件保留原位。
- 历史编辑与改写使后续变化失效，原记录保留可见；重说只有成功后替换原分支。任务应用校验篇章版本，重复应用幂等，多窗口冲突拒绝覆盖。

## 测试索引

以下缩写均指仓库中的实际测试：

| 标记 | 文件                                                   | 验证范围                                                           |
| ---- | ------------------------------------------------------ | ------------------------------------------------------------------ |
| S    | `tests/unit/schemas.test.ts`                           | 字段、枚举、非空、字数、数量、部分数据清洗                         |
| P    | `tests/unit/provider.test.ts`                          | SDK 严格参数、渠道能力、纠正、截断、取消                           |
| D    | `tests/unit/story.test.ts`                             | 稳定引用、状态、来源、关系与知情、日期、金额、增量交互、检索       |
| W    | `tests/unit/workflows.test.ts`                         | 所有辅助任务、草稿应用、导入、改写、证据、媒体、本地操作、请求记录 |
| V    | `tests/unit/storage.test.ts`                           | v3 往返、独立新库、事务、编辑失效、幂等与版本冲突                  |
| O    | `tests/unit/opfs.test.ts`                              | OPFS 原子写入、仅 OPFS 恢复、失败重试、同步并发                    |
| C    | `tests/unit/context.test.ts`、`context-prefix.test.ts` | 完整预算、usage 校正、分批压缩回滚、实际请求前缀                   |
| T    | `tests/unit/transport.test.ts`                         | 流式持久化、冻结渠道与状态、取消、重说、冲突恢复                   |
| E    | `tests/e2e/app.spec.ts`                                | 真实 SDK 模拟响应下的桌面与移动端完整产品流程                      |

## 逐项覆盖

入口中的「工作台」指聊天工具栏的「剧情工作台」。`tasks` 保存冻结输入、流式恢复和结果；`requests` 保存每次真实请求，均随 v3 存档导出。

| 阶段 | 能力                  | 入口                      | 任务协议                                              | 持久化                              | 展示                                 | 恢复                                    | 测试      | 状态       |
| ---- | --------------------- | ------------------------- | ----------------------------------------------------- | ----------------------------------- | ------------------------------------ | --------------------------------------- | --------- | ---------- |
| 1    | 统一任务执行          | 聊天、工作台、渠道管理    | 16 类独立 schema 与输入类型                           | tasks、requests、messages           | 类型化部分及完整结果                 | 一次纠正、停止、重试                    | S/P/W/T/E | 待最终验收 |
| 1    | 渠道能力测试          | 渠道管理→测试渠道         | ChannelCapability：嵌套、数组、枚举、数字、布尔、null | channels、requests                  | 测试状态及失败原因                   | 支持确认后使用、可重测                  | P/E       | 待最终验收 |
| 1    | v3 存档与工作数据库   | 存档管理→导入/导出        | SaveFile.version=3                                    | yanju-v3、OPFS                      | 同步与授权状态                       | 原子事务、同步重试、仅 OPFS 恢复        | V/O/E     | 待最终验收 |
| 1    | 请求记录与重放        | 工作台→任务→请求记录      | RequestRecord                                         | requests、冻结前缀                  | 状态、用量、错误、JSON 导出          | 保存每次纠正与部分结果                  | W/C/T/E   | 待最终验收 |
| 1    | 请求预算              | 聊天用量、渠道容量设置    | 输入+schema+输出预留                                  | channels 校正、archives.summary     | 估算和实际用量                       | 分批压缩回滚、保留原文                  | C/T/E     | 待最终验收 |
| 2    | 正文、翻译和段落引用  | 聊天→叙事                 | NarrativeReply.blocks                                 | messages                            | 段落及翻译、可定位锚点               | 清洗部分内容、一次纠正                  | S/P/T/E   | 待最终验收 |
| 2    | 场景和角色引用        | 聊天、工作台→档案         | scene、speakerRef、effects.entities                   | messages、storyStates、storyEvents  | 场景、说话人与实体档案               | 引用校验、新实体分配稳定 ID             | D/T/E     | 待最终验收 |
| 2    | 角色持续状态          | 工作台→档案→状态          | effects.states                                        | storyStates、storyEvents            | 跨轮最新状态和来源                   | 事务提交、历史重放                      | D/V/E     | 待最终验收 |
| 2    | 关系和知情范围        | 工作台→档案→关系/知情     | effects.relationships、knowledge                      | storyStates、storyEvents            | 关系图、人物知情事实                 | 实体类型和来源校验                      | D/W/E     | 待最终验收 |
| 2    | 剧情事件              | 工作台→档案→时间线        | effects.events                                        | storyEvents、storyStates            | 人物、地点、剧情时间和来源           | 无效或部分消息不提交事件                | D/V/W/E   | 待最终验收 |
| 2    | 承诺与目标            | 工作台→档案→目标          | effects.goals                                         | storyStates、storyEvents            | open/done/cancelled、期限            | 稳定记录更新、重建进度                  | D/W/E     | 待最终验收 |
| 2    | 剧情日期与倒计时      | 聊天→日记、工作台时钟     | effects.clock                                         | storyStates、messages.diary         | 剧情日期、未知日期、程序倒计时       | 严格日期与跨月闰年运算                  | D/S/E     | 待最终验收 |
| 3    | 长期事实和偏好        | 工作台→档案→记忆          | effects.memories                                      | storyStates、storyEvents            | 活跃事实、偏好和原文来源             | 撤回事实、编辑失效、压缩不改事实        | D/V/C/E   | 待最终验收 |
| 3    | 上下文压缩            | 自动压缩、聊天→压缩上下文 | CompressionResult                                     | archives.summary                    | 原消息保留、用量更新                 | 一次纠正、分批原子更新、取消回滚        | S/P/C/T/E | 待最终验收 |
| 3    | 世界与 NPC 档案       | 工作台→档案→实体          | 固定实体+effects.entities                             | storyStates、原始设定               | 世界、角色、地点与筛选               | 固定来源打开世界资料、动态来源定位      | D/W/E     | 待最终验收 |
| 3    | 关系图和时间线        | 工作台→档案               | relationships、events                                 | storyStates                         | 图形关系、按时间事件浏览             | 分批展开、原消息定位                    | D/E       | 待最终验收 |
| 3    | 自然语言剧情检索      | 工作台搜索、创作→搜索     | StorySearch                                           | tasks、requests                     | 人物/地点/时间/类别/关键词本地结果   | 查询重试、失效数据排除、来源链接        | D/W/E     | 待最终验收 |
| 4    | 叙事手机模块          | 聊天→手机                 | NarrativeReply.phone                                  | messages、storyStates               | 原有备忘/推荐/购买/联系人要求        | 完整数量和字数校验                      | S/D/E     | 待最终验收 |
| 4    | 独立手机聊天          | 工作台→交互→手机          | PhoneReply                                            | interaction 消息、稳定会话 ID       | 原文和一条联系人回复、会话历史       | 取消保留输入、重试、原子追加            | D/W/E     | 待最终验收 |
| 4    | 备忘录和购买记录      | 工作台→交互→备忘/购买     | NarrativeReply.phone                                  | 稳定条目 ID、storyStates            | 条目、日期、币种金额、来源           | 历史重建与来源定位                      | D/S/E     | 待最终验收 |
| 4    | 日记与日历            | 工作台→交互→日记          | NarrativeReply.diary、clock                           | storyStates.diaries                 | 日期筛选、日历、未知日期             | 日期校验、重新投影                      | D/E       | 待最终验收 |
| 4    | 论坛新帖              | 聊天论坛模式、交互→新帖   | ForumReply：恰好 50 条回答                            | messages、稳定帖子和回答 ID         | 正文、50 条分批展开                  | 数量校验、取消与重试                    | S/D/W/E   | 待最终验收 |
| 4    | 论坛增量回复          | 回答→回复、交互→论坛      | ForumAppend                                           | 用户原文+一条 NPC interaction       | 关联目标、持续累积、帖子历史         | 目标校验、取消保留输入、重复提交幂等    | D/W/E     | 待最终验收 |
| 5    | 人设草稿              | 工作台→创作→人设          | PersonaDraft                                          | tasks、personas                     | 五个可编辑字段、保存后可选择         | 编辑后重新校验、冻结历史发送者          | W/E       | 待最终验收 |
| 5    | 开场生成              | 工作台→创作→开场          | NarrativeReply                                        | 核心消息和剧情事务                  | 完整叙事及各模块                     | 核心流式、取消、纠正、重试              | S/P/T/E   | 待最终验收 |
| 5    | 续写方向和剧情分支    | 工作台→创作→续写建议      | StoryContinuation：3 个唯一选项                       | tasks、用户选择后的新叙事           | 方向、行动、场景；选择后推进         | 应用前版本校验、生成失败可恢复          | W/T/E     | 待最终验收 |
| 5    | 篇章名称与简介        | 工作台→创作→篇章信息      | ArchiveMetadata                                       | tasks、archives                     | 可编辑名称、简介和关键词             | 校验后保存、过期版本拒绝                | W/E       | 待最终验收 |
| 5    | 自然语言本地操作      | 工作台→创作→自然语言操作  | CommandIntent 枚举和参数                              | tasks、相关本地设置                 | 意图及执行入口                       | 当前目标校验、失效目标拒绝              | W/E       | 待最终验收 |
| 6    | 按模块/段落局部改写   | 工作台→创作→局部改写      | NarrativeRewrite                                      | tasks、原子替换 messages            | 完整预览、修改段落清单               | ID/正文/翻译/关联字段复验，失败保留原文 | S/D/W/E   | 待最终验收 |
| 6    | 人设及剧情一致性检查  | 工作台→创作→一致性检查    | StoryConsistency                                      | tasks                               | 问题类型、严重程度、位置、证据、建议 | 证据须属于引用消息与指定段落            | W/E       | 待最终验收 |
| 6    | 历史编辑和重说        | 聊天→编辑/重说            | 原任务 schema 与交互判别类型                          | messages、storyEvents、storyStates  | 失效标记、保留旧记录                 | 编辑重建状态；重说成功替换、失败保留    | V/W/T/E   | 待最终验收 |
| 7    | 粘贴和 UTF-8 文本提取 | 工作台→资料               | ContentExtraction                                     | tasks、原文 material 消息及 effects | 提取内容和未识别项预览               | 应用前引用校验、原文保留、重试          | W/E       | 待最终验收 |
| 7    | 角色和世界 JSON 导入  | 工作台→资料→导入文件      | ContentExtraction                                     | tasks、来源及稳定实体               | 实体、关系、事实预览后保存           | 应用存档拒绝进入资料入口                | W/E       | 待最终验收 |
| 7    | 章节整理              | 工作台→创作→章节整理      | StoryChapters                                         | tasks                               | 原文顺序章节、摘要与来源             | 禁止未知/重复/逆序消息引用              | W/E       | 待最终验收 |
| 7    | 剧情 Markdown 导出    | 工作台→资料、章节结果     | 有效原文+StoryChapters                                | 下载 Markdown                       | 原文、翻译、论坛、交互与章节         | 仅导出有效完整记录，保留本地来源        | W/E       | 待最终验收 |
| 7    | 现有曲库配乐          | 工作台→媒体、原音乐面板   | MediaCue.trackId                                      | tasks、settings.autoMusic           | 推荐曲目、点击播放、自动配乐         | 已有曲目校验、播放失败提示              | W/E       | 待最终验收 |
| 7    | 背景与语音描述        | 工作台→媒体               | MediaCue                                              | 可编辑 tasks.output、JSON 下载      | 背景和逐段语音描述                   | 保存复验目标与段落，空内容禁止导出      | W/E       | 待最终验收 |

## 最终本地验收

待执行完整 `pnpm verify`，成功后更新逐项状态与结果。GitHub Actions 仅负责合并到 `master` 后的现有 Pages 构建与发布。
