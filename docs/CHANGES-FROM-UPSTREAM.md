# 相对上游的本地改动一览（fork: shen1950/tiez-clipboard）

- **上游仓库**：[jimuzhe/tiez-clipboard](https://github.com/jimuzhe/tiez-clipboard)（原作者 LongDz / jimuzhe）
- **基线**：上游 master `40f7305`（v0.3.4 之后、含 beta release workflow 的提交）
- **本 fork 版本**：0.3.5（Windows 本地增强集）
- **平台**：仅在本机 Windows 11 上开发与验证；macOS 相关脚本原样保留，未测试

本文档汇总本 fork 相对上游的全部实质性改动及其原因。两块较大的修复另有详细档案：
[PixPin 截图收录修复](./pixpin-clipboard-fix-2026-09-09.md)、[WebDAV 同步配额爆满修复](./webdav-tmp-garbage-fix-2026-09-13.md)。

---

## 1. 回收站（软删除）功能

**内容**：删除剪贴板条目不再直接销毁，而是进入回收站，可恢复、单条永久删除或清空。

- 数据层：schema 10 → 11，`clipboard_history` 新增 `deleted_at INTEGER` 列及索引；`ClipboardEntry` 增加 `deleted_at` 字段。
- 仓储层：`clipboard_repo.rs` 新增 7 个方法（soft_delete / restore / permanent_delete / get_recycle_bin_items / cleanup_expired / empty_recycle_bin / get_recycle_bin_count）；所有活跃列表、搜索、按类型/按标签查询均过滤 `deleted_at IS NULL`。`clear()`（清空历史）由"硬删除 + 墓碑 + VACUUM"改为仅软删除。
- 命令层：新增 `recycle_bin_cmd.rs`（7 个命令，注册进 main.rs）；`delete_clipboard_entry` 从 history_cmd.rs 迁出并改为软删除。
- 启动兜底：setup.rs 启动时按 `recycle_bin_retention_days`（默认 7 天）清理过期项。
- 前端：新增 `RecycleBinPanel` 浮层（portal 渲染，恢复/永久删/清空带确认、显示剩余保留天数和标签）；AppHeader 增加回收站入口按钮；设置页新增"回收站保留期限"下拉（3/5/7/14/30 天）；三语文案各加 15 个 key。
- 云同步语义：软删除只发 `clipboard-removed` 本地事件、**不**触发云同步；只有永久删除/清空/到期清理才请求同步。有意为之——误删恢复期间不影响其他设备。

**原因**：剪贴板工具最怕"手滑删除找不回"。上游的删除是不可逆的，且"清空历史"还会 VACUUM 整库。软删除给误操作留退路，保留期到期自动清理保证数据库不无限膨胀。

## 2. PixPin 等截图工具的图片收录修复

**内容**：剪贴板监听重构——窗口回调只发通知，专职工作线程串行读取；对延迟渲染/延迟序号场景做 6 次指数退避补读（50ms→1s）；500ms 序号轮询兜底；读取失败不再污染去重状态。

**原因**：PixPin 截图后图片不进历史，必须手动唤起应用才被收录。根因是上游在 WM_CLIPBOARDUPDATE 回调内同步读剪贴板、且按序号跳过事件，与截图工具的延迟渲染不兼容（详见专项文档，含测试与部署验证记录）。

## 3. WebDAV 同步：临时文件垃圾与配额爆满修复

**内容**：

- 上传临时文件（`.uploading.*.tmp`）失败后立即 DELETE 清理；新增每 24 小时的 GC 扫描，回收超 24 小时的遗留临时文件（单轮上限 500 个 DELETE）。
- 507（存储配额满）进入 30 分钟冷却退避，避免失败重试恶性循环。
- 快照推送前对全部条目做 blob 化处理（图片/大文本只保留哈希引用），快照体积从可达上百 MB 降到数 MB 级。

**原因**：上游的快照是全量 base64 内嵌历史，45 秒超时下极易半途中断，遗留等量级临时文件；失败又不清理、不退避，最终把 WebDAV 配额打满形成恶性循环。本机 Koofr 曾堆积 407 项 / 7.9 GB 垃圾（详见专项文档）。

## 4. 回收站主题适配与窗口圆角修复（2026-09-28）

**内容**：

- 回收站浮层与卡片不再写死样式，改用全局主题 token（`--bg-window`、`--modal-border`、`--modal-radius`、`--modal-shadow`、`--card-radius` 等），深浅色与云母（Mica）等主题下自动同步变化；圆角统一 `min(var(--modal-radius), 8px)`，与主界面卡片一致。
- 遮罩层改为 portal 挂到 `#root`、由主窗口统一裁切，自身不再带圆角。
- Win11（build ≥ 22000）且 DWM 已应用原生圆角时，Rust 侧给文档根节点打 `data-native-rounded-window` 标记（`ui_cmd.rs`），CSS 据此在回收站遮罩显示期间去掉 root/body/#root 的第二层 CSS 圆角。

**原因**：回收站初版永远是一套默认 3D 复古样式，与常用主题格格不入；随后发现两层圆角叠加——Windows 原生 DWM 已按物理窗口裁了一层圆角，WebView 内的 CSS 又按缩放后尺寸裁了一层更大的，遮罩显示时四角露出白色弧形缝隙。修复后遮罩铺满窗口、由 DWM 原生圆角统一裁切，缝隙消除。

## 5. 图片预览与 asset protocol scope 修复

**内容**：

- 新增 `image_preview.rs`：历史/搜索/标签查询返回前逐条预检图片文件存在性并授予 asset scope，失败则置 `file_preview_exists=false`；文件存在性检查从仓储层上移到命令层。
- `file_cmd.rs`：收藏表情图片逐一注册进 `asset_protocol_scope`；setup.rs 启动时按 `app.emoji_favorites` 重新补授（scope 授权不持久化）。
- EmojiPanel：收藏表情加载失败不再自动从收藏里删除该文件，改为显示非破坏性的占位。
- ClipboardItem：图片加载占位改由 React state 驱动，与后端预检结果对齐。

**原因**：本机把数据目录重定向到自定义路径后，默认 asset scope 不覆盖该目录，webview 加载 `asset://` 图片一律 403。顺带修掉两个衍生问题：临时性加载失败会静默删掉用户收藏（破坏性行为）；DOM 直改的占位会被 React 重渲染覆盖。

## 6. 标签列表改为从数据库取全量

**内容**：标签筛选下拉/逐条标签建议的来源，从"由当前已加载的 history 推导"改为调用 `get_all_tags_info` 从数据库取全量，并在 `clipboard-changed`/`clipboard-removed` 事件时刷新。

**原因**：历史是分页/虚拟滚动的，未加载条目的标签在筛选器里凭空消失；软删除条目的标签也会从列表中脱落。全量取数保证筛选器始终覆盖所有标签。

## 7. 前端稳健性小修

- VirtualClipboardList 给 Virtuoso 加 `computeItemKey`（按条目 id 而非索引做 key），删除/排序后行内状态不再串位。
- 删除操作加 `deletingIds` 防重复点击；删除成功不再弹 toast（回收站兜底）；错误提示改用本地化 key。
- Toast 组件支持可选操作按钮（`action`），为后续"撤销"类交互预留。
- logger.rs 补 `warn!` 宏；database.rs 测试建表 DDL 补 `deleted_at` 列等测试修复。

## 8. 版本与标识符

- 版本号 0.3.4 → 0.3.5（package.json / Cargo.toml / tauri.conf.json）。
- tauri identifier `com.tiez` → `com.tiez.app`：**对齐本机既有安装的数据目录**（历史数据都在 `%APPDATA%\com.tiez.app`）。全新安装的用户如需沿用上游 identifier，可改回。

---

## 已知限制与未完成项（发布时保留原样，未改动）

1. **自动更新器仍指向上游**：updater endpoint 与签名公钥均为原作者的（`tiez.name666.top`）。本 fork 的构建收到更新提示时实际会拉到上游版本——升级即回到未改版代码。fork 用户建议在设置中关闭自动更新，或自行替换 endpoint。
2. **到期清理不删附件文件**：`cleanup_expired` 未传 data_dir，过期自动清理只删数据库记录，数据目录下的图片附件会成为孤儿文件（手动"清空回收站"则会连附件一起删）。
3. **过期清理仅启动时执行**：`cleanup_expired_recycle_bin` 命令已注册但前端无调用方，应用长期不重启时过期项不会被清。
4. **Toast 操作按钮基建暂无调用方**：撤销按钮方案最终被回收站替代，`undo`/`moved_to_recycle_bin` 文案与 action 按钮属预留代码；英文文案有一处笔误（"cannot be und undo."）。
5. **软删除不写同步墓碑**：本地删除的内容在其他设备保留，直到在回收站永久删除。与上游"删除即同步"语义不同，多设备用户需知悉。

## 构建方式

见 [pixpin-clipboard-fix-2026-09-09.md](./pixpin-clipboard-fix-2026-09-09.md) 的"本机构建"一节（CARGO_HOME 重定向、离线构建、`--no-bundle`）。标准构建直接 `npm run tauri:build` 即可。
