# dsh 浏览器操作插件（dsh-browser）

English | [中文](README.zh.md)

让 dsh 的模型**直接读取并操作你在浏览器里打开的页面**：抓取页面内容、点击元素、填写表单、滚动与导航——全部在你自己的浏览器里执行，登录态、会话与 Cookie 完整保留。侧边栏面板是与模型对话的配套入口。

纯文本设计：DeepSeek 模型无视觉，页面以结构化文本呈现（带编号的交互元素清单），模型用编号精确定位并操作任意元素，整条管线**全程无截图**。

本仓库遵循 dsh-external 内测生态惯例：**只含插件本身，不含 DeepSeek Harness SDK 源码**；SDK 包全部以 `peerDependencies` 声明，运行时由宿主 Harness workspace 提供。

## 核心能力

| 能力 | 工具 | 说明 |
|---|---|---|
| 读取页面 | `browser_snapshot` | 结构化文本快照：标题/URL/正文/编号交互清单/表单字段（敏感值掩码）；`delta: true` 只返回变化 |
| 点击元素 | `browser_click` | 按编号点击链接/按钮/复选框等 |
| 填写表单 | `browser_type` | 输入文本（React/Vue 受控组件兼容），`replace` 清空重填 |
| 按键 | `browser_press` | 键盘事件（Enter/Tab/Escape/方向键…） |
| 滚动 | `browser_scroll` | 视口滚动（up/down/top/bottom） |
| 页面导航 | `browser_navigate` / `browser_back` / `browser_forward` / `browser_reload` | 当前标签页内导航，保留登录态 |
| 读取区域 | `browser_get_text` | 懒加载内容 / 局部文本 |
| 等待稳定 | `browser_wait` | 页面加载与渲染稳定检测 |

## 组成

```
packages/browser/bridge-browser/   桥插件：token 认证 WS 通道 + browser_* 工具 + 线协议
extensions/dsh-browser/            Chrome MV3 扩展：content script 在真实页面执行动作 + 侧边栏对话界面
examples/browser-bridge.cordis.yml overlay 示例
```

## 为什么这样设计

- **操作真实浏览器，而非无头浏览器**：页面就是用户正打开的那个，登录态/会话/Cookie 全保留——这是独立 Playwright 浏览器（如 `dsh-tool-browser`）做不到的。
- **纯文本适配无视觉模型**：编号元素清单 + 跨快照稳定编号（模型可以说"点 7 号"）+ delta 增量（省 token）+ 敏感值掩码。
- **隐私边界**：密码/卡号字段的值只以 `••••` 呈现，绝不离开页面。
- **安全**：桥通道 token 认证（首帧 `hello`、常量时间比对）；特权网关方法对非回环来源一律拒绝；扩展只操作活动标签页。

## 安装与使用（零配置）

**第一步：启动 dsh**（在宿主 SDK checkout 下，本仓库是其中的 `dsh-browser/` 子目录）：

```sh
# 让 `dsh` 命令指向包含本插件的宿主 checkout（launcher 读 ~/.dsh/source/current）
ln -sfn <宿主 checkout> ~/.dsh/source/current

# 启动（3080 若已被其他 dsh web 占用，换一个端口）
cd <宿主 checkout>/dsh-browser
dsh web --config examples/browser-bridge.cordis.yml --port 3081
```

**第二步：安装扩展（一条命令）**：

```sh
./dsh-browser/scripts/install.sh
```

脚本会构建插件与扩展、复制到 `~/.dsh/browser-extension`、打开 `chrome://extensions`；按提示开启开发者模式并加载该目录即可。工具栏出现 DeepSeek 鲸鱼图标，点击打开侧边栏。

**无需任何配置**：扩展自动探测本机 dsh 并连接（`/ext/bridge-config` 发现 + 回环免 token）。token/地址只在远程部署（`--host 0.0.0.0`）时才需要手动填写。

## 构建顺序与宿主前提

- 插件包需在宿主使用前构建：`pnpm --filter @deepseek-ai/dsh-bridge-browser run build`（或在 `dsh-browser/packages/browser/bridge-browser` 下 `pnpm run build`），产出 `lib/` 供 Loader 加载。
- 宿主 checkout 的可用性以 `dsh-browser/` 存在为前提（`apps/cli` 通过 `workspace:^` 引用插件包）；不需要插件时删除/移走 `dsh-browser/` 并移除符号链接即可。

## 开发模型

插件包在**宿主 SDK workspace** 内开发测试（peer 依赖模型）：宿主 `pnpm-workspace.yaml` 通过 `packages/browser/bridge-browser` 符号链接把本仓库的插件包挂载为成员（符号链接悬空时宿主不受影响）。扩展是完全独立的 Vite 项目，在自身 workspace 内安装。

```sh
# 插件包（经宿主 workspace）
pnpm --filter @deepseek-ai/dsh-bridge-browser run typecheck   # tsc -b（extends 宿主 tsconfig.base）
pnpm --filter @deepseek-ai/dsh-bridge-browser run test        # vitest（paths 指向宿主源码）

# 扩展（自身 workspace）
cd extensions/dsh-browser && pnpm install && pnpm run test && pnpm run build
```

## 安全

- 桥路径在 `/api` 信任栅栏之外，自带 bearer token 认证
- 特权网关方法（`settings.*`/`credentials.*`/`host.open*`）对非回环来源一律拒绝
- 单活动连接；纯文本管线（无截图）；密码/卡号值永不回传
- 只操作活动标签页，绝不静默切页
