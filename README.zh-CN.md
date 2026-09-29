# TieZ-GuLing

**STAY FAST. STAY SYNCED. —— 本地优先的 Windows / macOS 剪贴板管理器（TieZ 个人优化线）**

[English](./README.md) | [简体中文](./README.zh-CN.md)

> 自 1.0.0 起独立编号，不再跟随上游 TieZ 0.3.x 版本线；上游仅作为修复参考来源。
> 数据标识符保持 `com.tiez.app`，可直接沿用 TieZ 原版的历史数据。

## 版本系列

| GuLing 版本 | 对应旧编号 | 设置形态 |
| :--- | :--- | :--- |
| v0.9.0 | 上游 TieZ 0.3.4（fork 基线，追溯标记） | 一体 |
| v0.9.5 | 旧"v0.3.5"本地增强集：回收站/PixPin 收录/WebDAV 修复（追溯标记） | 一体（回收站浮层） |
| v1.0.0 | 首个正式版本：FTS5 全文搜索 + html 按需加载 + 回收站全屏视图 | 一体 |
| **v1.0.1** | 基于 1.0.0：设置界面独立桌面窗口 | **分离：设置独立窗口，主窗口专注剪贴板（本版本）** |

本分支/本 Release 为 **v1.0.1 分离版**。偏好单窗口一体形态请使用 [v1.0.0](../../releases/tag/v1.0.0)。

---

## 功能

### 核心体验
- Tauri 2 + Rust 内核，本地存储，剪贴板内容不出机
- SQLite **FTS5(trigram)** 全文搜索：中文子串友好，千条级亚毫秒；可按来源应用、标签过滤
- 采集文本 / 富文本(HTML) / 图片 / 文件路径；富文本 html 按可见项懒加载，列表响应轻量
- PixPin 等截图工具「贴图并复制」自动收录（延迟渲染兼容 + 指数退避补读）
- Mica / Acrylic 材质、深浅色、4+ 主题与自定义主题商店、边缘停靠

### 设置独立窗口（本版特性）
- 设置为独立桌面窗口（860×640，可缩放/拖拽/多显示器放置），主窗口只做剪贴板
- 跨窗口实时同步：设置变更后主窗口经 `settings-changed` 事件自动重载
- 独立窗口同样获得云母/亚克力材质与原生圆角

### 管理增强
- **回收站**：删除进回收站（软删除），保留期可配（3–30 天），误删可恢复、可永久删除/清空
- 多色标签系统、置顶、收藏、备注、emoji 库
- 隐私保护：敏感内容预览打码、可选加密存储
- AI 操作（翻译/润色/摘要，自配模型 profile）

### 网络与同步
- **WebDAV 跨设备同步**（含临时文件 GC、配额满冷却、快照 blob 化）
- MQTT 验证码/消息同步、局域网文件互传聊天页

### 粘贴工作流
- 顺序粘贴队列、富文本粘贴热键、快捷粘贴修饰键
- 默认热键 Alt+C 唤起（可改，可接管 Win+V）

### 主题展示

| 极简毛玻璃 | 笔记本风格 | 便利贴风格 | 3D 动感 |
| :---: | :---: | :---: | :---: |
| ![毛玻璃](docs/images/毛玻璃.png) | ![书](docs/images/书.png) | ![便利贴](docs/images/便利贴.png) | ![3d](docs/images/3d.png) |

---

## 下载与运行

- Release 页下载 `TieZ-GuLing-1.0.1-win-x64.exe`（直接运行）或同名 `.zip`（含使用说明）。
- 数据默认在 `%APPDATA%\com.tiez.app`；便携数据：exe 同目录放 `datapath.txt` 写绝对路径。
- 未签名构建：SmartScreen 提示时选「更多信息 → 仍要运行」。
- 自动更新器指向上游、在本 fork 不生效；请手动跟随本仓库 Release 更新。

## 构建

```bash
npm install
npm run tauri:build -- --no-bundle --config <your-identifier.json>
```

> 注意：必须经 `tauri:build`（或带 Tauri CLI 环境变量）构建；裸 `cargo build --release`
> 会产出连 devServer 的 dev 模式 exe（窗口显示 ERR_CONNECTION_REFUSED）。

## 相对上游 0.3.4 的改动档案

见 [docs/CHANGES-FROM-UPSTREAM.md](./docs/CHANGES-FROM-UPSTREAM.md)（回收站、FTS5、html 按需加载、
设置独立窗口、PixPin 修复、WebDAV 修复、重编号说明等）。

## 许可与致谢

GPL-3.0。基于 [TieZ（jimuzhe/tiez-clipboard）](https://github.com/jimuzhe/tiez-clipboard) 二次开发，感谢原作者；
架构借鉴 EcoPaste 系（Tauri2 + React19）与 KwikPaste 的 FTS5/独立设置窗口思路。
