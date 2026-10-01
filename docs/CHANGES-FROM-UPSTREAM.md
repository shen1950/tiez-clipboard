# 相对上游的本地改动一览（fork: shen1950/tiez-clipboard）

> **重编号说明（TieZ-GuLing 版本系列）**：v0.9.0=上游 0.3.4 基线（追溯）；v0.9.5=旧"v0.3.5"本地增强集（追溯）；**v1.0.0=一体版**；**v1.0.1=分离版**（设置独立窗口，本文档多数条目所属）。不再与上游 0.3.x 混用。

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

- 回收站浮层与卡片不再写死样式，改用全局主题 token（`--bg-window`、`--modal-border`、`--modal-radius`、`--card-radius` 等），深浅色与云母（Mica）等主题下自动同步变化；圆角统一 `min(var(--modal-radius), 8px)`，与主界面卡片一致；卡片不带投影——回收站遮罩比标准弹窗更淡，大软阴影投在浅遮罩上显得浑浊，分层交给遮罩、模糊和细边框完成。
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

## 9. SQLite FTS5 全文搜索（2026-09-29，借鉴 KwikPaste）

**内容**：

- 迁移 11 → 12：新增外部内容 FTS5 虚拟表 `clipboard_fts`（`content='clipboard_history'`、`content_rowid='id'`、`tokenize='trigram'`），索引 `content`/`source_app`/`tags` 三列；配套 AFTER INSERT/DELETE/UPDATE 触发器保持同步；迁移末尾 `rebuild` 回填既有行。
- `search()` 重构为三条路径：≥3 字符走 FTS5 trigram（中文子串友好，`MATCH '"term"'` 字面子串语义）；FTS 报错或命中为空时回退 `LIKE`（防止索引异常导致"搜不到"）；`tag_only` 与 1–2 字符短词仍走 `LIKE`。非 portable 构建保留敏感/加密条目的解密扫描补全。
- 迁移做成幂等：先 `DROP TRIGGER/TABLE IF EXISTS` 再重建，可修复早期半迁移状态。

**原因**：上游搜索是 `content/source_app/tag` 三列 `LIKE '%q%'` 全表扫描，且查询会读取每行的 `html_content`（富文本快照，本机 26MB）溢出页，随历史增长线性变慢。FTS5 trigram 索引把搜索从全表扫描降为索引查找，且只索引文本三列（本机 content 合计仅 0.1MB），索引体积可忽略。

**注意**：外部内容 FTS5 的 `rebuild` 按**列名**回读源表，FTS 表列名必须与 `clipboard_history` 一致（曾误用 `tags_text` 导致 `rebuild` 报 `no such column` 而静默失败、索引为空）。已加回归测试 `fts_rebuild_backfills_from_existing_rows` 覆盖。

## 10. 列表/搜索响应瘦身：html_content 按需加载（2026-09-29）

**内容**：

- `get_history`、`search`、`get_recycle_bin_items`、`get_entries_by_tag` 的 SELECT 不再返回 `html_content`（置 `None`）。
- 新增命令 `get_entry_html(id)`：先查 SessionHistory 再回库，按 id 取单条 html。
- 前端 `ClipboardItem` 对可见的 `rich_text` 条目懒加载 html（`itemHtml = item.html_content ?? lazyHtml`），虚拟列表只挂载少量可见项，滚动即按需拉取。
- 复制/粘贴不受影响：`copy_to_clipboard`/`get_clipboard_content` 在 `id != 0` 时本就从后端按 id 回取完整内容与 html。

**原因**：`html_content` 是内存与 IPC 的主要负担（本机 26MB html vs 0.1MB 文本），而列表只需渲染文本预览。改为按需加载后，列表/搜索查询不再搬运整块 HTML，Rust 主进程与 WebView 堆的峰值随之下降——对齐 KwikPaste「主进程恒定、按需流式取数」的结构优势。富文本快照预览仍保留，仅在条目进入视口时异步生成。

## 11. 设置界面独立窗口，与剪贴板页面彻底分离（2026-09-29）

**内容**：

- 新增 `SettingsWindow`（`src/features/settings/components/SettingsWindow.tsx`），经 `main.tsx` 的 `?window=settings` 路由挂载，复用 `useAppState` + 全套 settings hooks（init/post-init/apply/sync/bootstrap/hotkey/app-actions）自持状态。
- 新增 `openSettingsWindow()`（`settingsWindowControls.ts`）：用 `WebviewWindow` 创建/复用 label 为 `settings` 的独立窗口（860×640、可缩放、无边框透明、居中）；`tauri.conf.json` capability 的 windows 列表加入 `settings` 并补 `core:window:allow-close`。
- 主窗口 `AppHeader` 齿轮按钮改为 `openSettingsWindow()`；`AppMainContent` 移除 SettingsPanel 分支，文件传输聊天（chatMode）独立于设置渲染；`App.tsx` 移除 `useSettingsPanelProps`/`useHotkeyConfig`/`toggleGroup` 等仅供设置的接线。
- 跨窗口同步：设置窗口变更后防抖 `emit("settings-changed")`（复用 `useSettingsInit` 既有监听），主窗口收到即从后端 `get_settings` 重载并应用；窗口关闭/刷新时 `beforeunload` 再兜底广播一次。设置内的「打开文件传输」经 `open-file-transfer` 事件让主窗口 `focus_clipboard_window` 并进入聊天。
- `set_theme(window: WebviewWindow)` 本就作用于调用窗口，故设置窗口独立获得云母/亚克力与原生圆角，无需额外处理。

**原因**：上游设置是 352px 窄剪贴板窗内切换的视图，长表单局促、且设置态与剪贴板态耦合在一个 React 树里。独立窗口让设置拥有完整桌面窗口尺寸、与剪贴板生命周期解耦（对齐 KwikPaste 的 Alt+X 独立偏好窗口），主窗口回归纯剪贴板职责。

---

## 12. 重复内容合并三模式、搜索栏标签颜色对齐、音量刻度修复（2026-10-01，v1.0.4）

**内容**：

- 「重复内容合并」由开关改为三选一（`app.duplicate_mode`，同时兼容写旧键 `app.deduplicate`）：
  - `delete_old`：删除旧记录（含标签与附件文件），新捕获作为全新记录置顶；
  - `touch_old`：不新增记录，仅刷新旧记录的时间戳与使用次数，内容、标签、置顶状态、来源应用全部原样保留；
  - `off`：不合并，两条都保留。
  - 迁移：旧开关「开」→ `touch_old`、「关」→ `off`，首次启动时写回 settings 表。
- 修复原「开启」状态的数据丢失：旧实现的去重 UPDATE 路径会用新捕获（空标签）覆盖 `tags` 列并清空 `entry_tags` 关联，导致旧记录标签、来源信息丢失；现 `touch_old` 仅 `touch_entry_with_conn`（timestamp + use_count），不再触碰其他字段。
- 去重匹配排除回收站记录：`existing_id` 命中后经 `get_entry_by_id_with_conn` 校验 `deleted_at IS NULL`，避免把软删除记录"复活"。
- 搜索栏下拉的可选标签改为优先使用标签管理保存的颜色（`tagColors[tag] || getTagColor(tag, theme)`），与条目栏、标签管理、回收站一致（`AppHeader.tsx`）。
- 音量刻度修复：`useSettingsPostInit` 把旧版 0-100 刻度的音量值归一化到 0-1（>1 除以 100），0 保持静音不再回落到 1.0；`useSoundEffects` 直接使用 0-1 刻度。

**原因**：原开关只有"删旧插新/不动"两态，删旧路径会连带丢掉用户标记；拆成三模式让"保留标记"成为显式可选项。搜索栏此前只读自动生成色，未读 `tag_colors` 保存值，造成同一标签三处颜色不一致。


## 已知限制与未完成项（发布时保留原样，未改动）

1. **自动更新器仍指向上游**：updater endpoint 与签名公钥均为原作者的（`tiez.name666.top`）。本 fork 的构建收到更新提示时实际会拉到上游版本——升级即回到未改版代码。fork 用户建议在设置中关闭自动更新，或自行替换 endpoint。
2. **到期清理不删附件文件**：`cleanup_expired` 未传 data_dir，过期自动清理只删数据库记录，数据目录下的图片附件会成为孤儿文件（手动"清空回收站"则会连附件一起删）。
3. **过期清理仅启动时执行**：`cleanup_expired_recycle_bin` 命令已注册但前端无调用方，应用长期不重启时过期项不会被清。
4. **Toast 操作按钮基建暂无调用方**：撤销按钮方案最终被回收站替代，`undo`/`moved_to_recycle_bin` 文案与 action 按钮属预留代码；英文文案有一处笔误（"cannot be und undo."）。
5. **软删除不写同步墓碑**：本地删除的内容在其他设备保留，直到在回收站永久删除。与上游"删除即同步"语义不同，多设备用户需知悉。

## 构建方式

见 [pixpin-clipboard-fix-2026-09-09.md](./pixpin-clipboard-fix-2026-09-09.md) 的"本机构建"一节（CARGO_HOME 重定向、离线构建、`--no-bundle`）。标准构建直接 `npm run tauri:build` 即可。

> **警告（2026-09-29 踩坑）**：不要用裸 `cargo build --release` 产出部署 exe。Tauri v2 的 dev/prod 判定依赖 tauri CLI 注入的 `TAURI_ENV_*` 环境变量（本仓库 `[features]` 未声明 `custom-protocol`），裸 cargo 构建会被当作 dev 模式，运行时去连 `devUrl`（localhost:1420），dev server 未起时窗口显示 `ERR_CONNECTION_REFUSED` 错误页。必须走 `npm run tauri:build -- --no-bundle --config <local-build.json>`。
