# dsh 浏览器操作扩展（Chrome MV3）

[English](README.md) | 中文

dsh 的**浏览器操作端**：让模型直接读取并操作你在浏览器里打开的页面——抓取内容、点击元素、填写表单、滚动与导航，全部在真实页面执行、登录态保留。侧边栏面板是与模型对话的入口。

**纯文本模式**：DeepSeek 模型不支持图片输入，页面以结构化文本呈现（带编号的交互元素清单），模型用编号精确操作任意元素；整条管线**刻意不产生任何图像**。

## 模型能做什么

| 能力 | 动作 | 说明 |
|---|---|---|
| 读取页面 | `browser_snapshot` | 标题/URL/正文/编号交互清单/表单字段（敏感值掩码）；`delta: true` 只返回变化，省 token |
| 点击元素 | `browser_click` | 按编号点击（链接/按钮/复选框…），React/Vue 组件兼容 |
| 填写表单 | `browser_type` | 输入文本，`replace` 清空重填 |
| 按键 | `browser_press` | Enter/Tab/Escape/方向键等 |
| 滚动 | `browser_scroll` | 视口滚动（up/down/top/bottom） |
| 导航 | `browser_navigate` / `back` / `forward` / `reload` | 当前标签页内跳转，登录态保留 |
| 读区域 | `browser_get_text` | 懒加载内容 / 局部文本 |
| 等待 | `browser_wait` | 页面加载与渲染稳定检测 |

## 架构

```
side panel (React) ◄─port─► background SW ◄─WS─► dsh bridge plugin
                                 │
                  tabs.sendMessage (DSH_ACTION)
                                 ▼
                        content script (snapshot/actions/privacy)
```

- **background**（`src/background/`）：桥连接（token 认证 + 指数退避重连 + 保活）、网关 RPC 客户端、**工具分发到活动标签页**。
- **content script**（`src/content/`）：纯文本快照（可读性主文 + 编号交互清单 + 表单字段）、**稳定编号**（`data-dsh-el`）、delta 变化、点击/输入/按键/滚动/导航动作、敏感字段掩码。
- **panel**（`src/panel/`）：React 对话界面（会话列表/历史/实时事件/设置），消息以 Markdown 渲染（标题/列表/代码块/表格等，已消毒）。
- **协议**：`@deepseek-ai/dsh-bridge-browser` 插件的 `protocol.ts` 是唯一事实源，两端共享（tsconfig paths 指向插件源码）。

## 构建

```sh
pnpm install                 # in this directory (standalone workspace)
pnpm run build               # outputs dist/
pnpm run test                # unit tests
```

## 安装与使用

1. **启动 dsh 并挂载桥插件**（在宿主 SDK checkout）：

   ```sh
   dsh web --config <dsh-browser>/examples/browser-bridge.cordis.yml
   ```

   启动日志会打印 `browser bridge: new token generated and persisted at ~/.dsh/ext-bridge-token`。

2. **加载扩展**：Chrome → `chrome://extensions` → 开发者模式 → 加载已解压的扩展程序 → 选择本目录 `dist/`。

3. **配置**：点击扩展图标打开侧边栏 → 设置 → 填入 Token（从启动日志或 `~/.dsh/ext-bridge-token` 获取）→ 保存并连接。

4. **使用**：在侧边栏对话。模型会通过 `browser_snapshot` 读取当前页面（带编号的交互清单），用 `browser_click`/`browser_type`/`browser_scroll` 等直接操作页面元素。工具栏的"读取页面"按钮一键让模型先看当前页。

## 纯文本优化（为什么这样做）

- **快照即视图**：模型对页面的全部认知 = 结构化文本（标题/URL/正文/编号元素/表单），预算 12k 字符（插件可配，经 `hello.ok` 协商给扩展）。
- **稳定编号**：元素编号跨快照保持（WeakMap + `data-dsh-el`），模型可以说"点 7 号"；页面大改时显式提示"编号已重排"。
- **delta 模式**：`browser_snapshot({delta:true})` 只返回变化元素的编号，省 token。
- **隐私**：密码/卡号字段的值永远以 `••••` 呈现，绝不回传；可访问名称从不使用敏感字段的当前值。

## 权限说明

`sidePanel`（侧边栏）、`storage`（设置）、`tabs` + `activeTab` + `scripting`（向活动标签页注入/发消息）、`alarms`（SW 保活）、`http/https`（内容脚本注入所有页面）。只操作**活动标签页**，绝不静默切页。

## 已知限制

- 同时只有一个扩展连接桥（后连顶替先连）。
- 跨源 iframe 只计数不可操作。
- 验证码/纯图片按钮无法处理——工具结果会标注"存在无文本可访问名的元素"，提示用户手动完成该步。
- 令牌无自动轮换。
- `browser_press` 的合成按键不触发浏览器原生默认行为（Tab 焦点移动、方向键、Enter 激活等），仅用于框架内的键盘事件；依赖原生行为的场景请手动操作。
- `browser_wait` 以加载完成 + 固定静默窗口为准，不观察持续 DOM 更新（连续刷新的 SPA 可能被报为稳定）。
