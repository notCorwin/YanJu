# 盐焗 · YanJu

一个以宴雎角色资料为背景的叙事聊天应用。保留人设、多个模型渠道、场景、状态、手机、日记、论坛、音乐和本地存档，使用严格结构化输出与 React 组件呈现内容。

在线应用：[notcorwin.github.io/YanJu](https://notcorwin.github.io/YanJu/)

## 本地开发

需要 Node.js 22.12+ 和 pnpm 10.28.2。

```sh
pnpm install --frozen-lockfile
pnpm dev
```

访问终端显示的 `/YanJu/` 地址。应用是纯静态 SPA，不需要后端或构建时 API Key。

首次使用时打开「渠道管理」，填写 OpenAI-compatible Base URL、Key 和模型，按实际模型容量设置上下文及输出上限，运行「测试渠道」，通过后点「使用此渠道」。请求由浏览器直接发送，渠道必须允许站点来源的 CORS 请求和 Authorization、Content-Type 请求头，并支持 `response_format: json_schema` 与 `strict: true`。不支持时显示错误，不降级到 JSON Mode。

## 技术与设计

- Vite 8、React 19、TypeScript、Tailwind CSS 4、shadcn/ui、AI SDK 7、Zod、Dexie。
- `src/styles/tokens.css` 是颜色、字体、字号、间距、圆角、边框、阴影与动效的唯一来源，映射到 Tailwind 语义工具类。外观设置只修改根 Token。`pnpm check:tokens` 阻止组件新增裸视觉值，包含 shadcn 源码。
- 使用官方 shadcn MessageScroller / Message / Bubble，Field / InputGroup，Card / Accordion / Dialog / Sheet。共享组件和变体统一视觉与触控尺寸。
- 角色、人设规则、文风、开场白、世界和常用指令保存在 `src/content`。文本不再嵌入脚本边界。原文件 `盐焗.html` 保留供旧版行为和数据格式参考，不参与生产构建。
- Hash 路由 `#/chat/<archiveId>` 支持存档链接及刷新；链接载入当前浏览器已有的存档，跨浏览器需要先导入存档。

## 回复协议

`src/lib/schemas.ts` 定义三个独立严格根对象：

| 请求              | 内容                                                             |
| ----------------- | ---------------------------------------------------------------- |
| NarrativeReply    | 场景和中英引语、叙述、方言与普通话翻译、状态、手机、日记与倒计时 |
| ForumReply        | 帖子与完整 50 条回答，支持发布和回复                             |
| CompressionResult | 人物关系、时间地点、关键事件、决定和未完成事项                   |

浏览器 ChatTransport 连接 `useChat` 与 `streamText` / `Output.object`。部分对象以带固定 ID 的类型化 UIMessage 数据部件逐步更新，完整对象经过结构与条数、字数、非空校验后标记完成。数据型助手消息会序列化回模型上下文，避免连续对话遗失助手内容。

结构或内容校验失败最多追加一次同 schema 纠正；网络、渠道不支持、取消及输出截断不自动重发。部分回复定期保存，停止时提交恢复记录。失败与取消可重试；重说只有在成功后才原子替换原分支。模型输出不包含界面代码；旧 HTML/XML 仅在迁移导入时转换为惰性数据。

## 上下文与存档

默认渠道容量为 32,768 tokens，可按模型实际容量修改。估算计入角色资料、人设、schema、摘要和有效历史，以中英文混合的保守估算及服务商实际 usage 校正；界面分别显示当前估算和上次实际输入/输出。

发送前与完成后检查输入预算，达到 85% 或输出预留不足时自动压缩，以 70% 以下为目标。默认保留最近 4 轮完整对话及当前输入；必要时减少到至少最新完整一轮及当前输入。较大历史按预算分批生成同渠道严格摘要。覆盖边界与会话版本一并校验，全部成功后一次性更新。无法容纳固定设定和最新输入时，提示调整容量或输出预算，保留原记录。

压缩不删除消息。编辑已覆盖消息和从覆盖位置重说会使摘要失效，从原文重建。压缩失败/取消保留原摘要与全部原文，并提供重试操作。已取消或失败的部分助手回复不作为完成的模型历史发送。

IndexedDB 存放消息、存档、渠道、人设、外观和摘要。首次启动会检测同源 `yanju_*` localStorage 并迁移，保留旧数据以便恢复。其他来源可通过旧 JSON 导入。导出统一为版本 2，同时支持导入版本 1 和版本 2，包含渠道 Key、消息时间、草稿、原始旧内容、外观与摘要边界。导入替换前校验文件并显示确认操作。

## 本地验收

```sh
pnpm exec playwright install chromium
pnpm verify
```

`verify` 顺序执行 Token 检查、ESLint、TypeScript、Vitest、桌面/移动端 Playwright 和生产构建。测试使用模拟模型与真实 SDK 协议，不需要真实密钥。真实渠道由用户配置后在应用内执行能力测试。

重点覆盖严格参数、缺字段、非空和数量、部分对象更新、一次纠正、取消/截断/重试、渠道及存档切换、85% 边界、分批压缩回滚、摘要失效、旧存档转换、v2 往返、中文输入法、移动触控、刷新及资源加载。

## 发布

本地验收通过后提交并推送 `master`。`.github/workflows/deploy.yml` 仅负责 CD：安装锁定依赖、构建、上传 Pages artifact 并发布。CI 检查在本地完成。

GitHub 仓库须为公开的 `notCorwin/YanJu`，Pages 的 Build and deployment / Source 设为 GitHub Actions。Vite `base` 已设为 `/YanJu/`。音乐与网络字体由原有公开资源/字体服务提供；未加载字体时会使用本地衬线字体。
