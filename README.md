# dsh-remote-status

DeepSeek Harness 插件：**侧边栏底部「本地 / 远程」状态芯片** + **远程镜像工作区标题自动标记**（`目录名 ⇄ 机器名`）。

## 功能

- **状态芯片**（侧边栏底部）：
  - 当前会话在远程镜像中 → `⇄ 远程 · 机器名`（橙色圆点，收起态为 ⇄ 图标）；
  - 本地会话 → `◉ 本地`（绿色圆点）；
  - 悬停显示诊断信息：workspaces/sessions 服务状态、会话模式、当前机器、最近刷新、最近错误等；
  - 本地会话的悬停**不显示**任何远程机器信息。
- **工作区标题标记**：远程镜像工作区（`$DSH_HOME/remote-workspaces/...`，含 `.dsh-remote-meta.json`）若仍是默认命名，自动改名为 `目录名 ⇄ 机器名`；自定义标题不碰；幂等（已标记的不再重复改）。
- **秒级响应**：事件订阅（会话/工作区变化 → 150ms 防抖刷新）+ 1s 轮询兜底，切换目录立即见变化；
- **容错降级**：接口失败保留 last-known 并显示 `⚠`；workspaces 服务缺失不崩溃。

## 数据来源

本插件是纯 UI 指示器，**不注册任何工具**，只读取 dsh-remote 生态的共享数据源：

- `$DSH_HOME/remote-workspaces/machines.json` — 机器注册表（`currentId`、机器 `name`/`host`）；
- `$DSH_HOME/remote-workspaces/<host-dir>/<name>/.dsh-remote-meta.json` — 镜像映射（`remotePath`）。

自带宿主路由（`/dsh-remote-status/status|machines|resolve-mirror`，Web 与桌面 IPC 双通道注册），因此**不依赖 dsh-remote 插件本身**也可工作；但镜像/机器数据需要由 dsh-remote（或兼容插件）创建。

## 安装

```bash
# 本地源码安装（开发/自用）
dsh plugin add "file:<仓库路径>/dsh-remote-status" --profile desktop

# 或改 profile 的 package.json（等价手动方式）：
#   dependencies 增加 "dsh-remote-status": "file:<仓库路径>/dsh-remote-status"
#   dsh.profile.bundles 数组增加 "dsh-remote-status"
```

安装后重启 DSH Desktop 即可。

## 插件结构

```
dsh-remote-status/
├── lib/
│   ├── index.js          # 宿主：3 个 JSON 路由（读 machines.json + 镜像 meta）
│   ├── http-transport.js # Web 服务器 / Connection IPC 双通道路由注册
│   └── client.js         # 客户端：状态芯片 + 标题标记（浏览器端）
├── cordis.patch.yml      # bundle 补丁（插入插件行）
└── package.json
```

## 开发

```bash
node --check lib/client.js lib/index.js
node verify/verify-dsh-remote-pill.cjs   # 集成测试（模拟宿主 + 真实 client.js）
```

## License

MIT