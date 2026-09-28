# dsh-remote-status

DeepSeek Harness 插件：**侧边栏底部「本地 / 远程」状态芯片**，跟随当前显示的会话显示 `本地` 或 `远程 · 机器名`。

## 功能

- **状态芯片**（侧边栏底部）：
  - 当前会话在远程镜像中 → `⇄ 远程 · 机器名`（橙色圆点，收起态为 ⇄ 图标）；
  - 本地会话 → `◉ 本地`（绿色圆点）；
  - 悬停显示诊断信息：会话模式、会话机器、最近刷新、最近错误等；
  - 本地会话的悬停**不显示**任何远程机器信息。
- **只显示，不改名**：插件不会给工作区标题追加任何机器标记，也不改动任何工作区数据。
- **秒级响应**：事件订阅（会话/面板变化 → 150ms 防抖刷新）+ 1s 轮询兜底，切换目录立即见变化；
- **正确跟随选择**：DSH 2.0.15 通过 `retainedBy.mainView` 与 `layout.panelInfo` 确认正在显示的会话，不取列表第一项；切换过程会忽略过期请求。
- **容错降级**：同一会话接口失败保留其已知状态并显示 `⚠`；切换会话后失败显示“状态待确认”，不沿用上一目录的机器名；未选择会话时明确显示“未选择会话”。

## 数据来源

本插件是纯 UI 指示器，**不注册任何工具**，只读取 dsh-remote 生态的共享数据源：

- `$DSH_HOME/remote-workspaces/machines.json` — 机器注册表（`currentId`、机器 `name`/`host`）；
- `$DSH_HOME/remote-workspaces/<host-dir>/<name>/.dsh-remote-meta.json` — 镜像路径与机器身份（`remotePath`、`host`、`username`、`port`）。

机器名按当前会话 cwd 所在镜像记录的 `host/username/port` 精确匹配，不用全局 `currentId` 推测目录归属；匹配不唯一时不猜测。

自带宿主路由（`/dsh-remote-status/status|machines|resolve-mirror`，Web 与桌面 IPC 双通道注册），因此**不依赖 dsh-remote 插件本身**也可工作；但镜像/机器数据需要由 dsh-remote（或兼容插件）创建。

## 插件结构

```
dsh-remote-status/
├── lib/
│   ├── index.js          # 宿主：JSON 路由（status / machines / resolve-mirror）
│   ├── http-transport.js # Web 服务器 / Connection IPC 双通道路由注册
│   └── client.js         # 客户端：状态芯片（浏览器端）
├── cordis.patch.yml      # bundle 补丁（插入插件行）
└── package.json
```

## 开发

```bash
node --check lib/client.js
node --check lib/index.js
node verify/verify-dsh-remote-pill.cjs      # 客户端状态芯片、切换与多机器回归
node verify/verify-host-session-lookup.cjs  # 宿主 zstd session header cwd 回退
node verify/verify-main-view.cjs            # 新版 mainView、面板与请求乱序回归
```

测试加载真实客户端与宿主路由、使用受控桩数据验证逻辑，不等同于桌面界面的视觉验证。升级插件后需重启 DSH Desktop 加载新代码。

## License

MIT
