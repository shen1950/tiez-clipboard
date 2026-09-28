# WebDAV 同步配额爆满修复（2026-09-13）

## 现象与根因

同步状态报 `webdav PUT sync head failed: 507 Insufficient Storage`，Koofr 的
`tiez-sync/devices/` 目录堆积 407 项 / 7.9 GB，其中 406 个是
`e33d920e.json.uploading.<设备ID>.<时间戳>.tmp` 遗留临时文件。

根因（上游 0.3.3/0.3.4 即存在）：

1. `upload_webdav_bytes_resource` 上传临时文件失败（超时/网络错误/507）时直接
   `?` 返回，临时文件永久遗留；MOVE 失败路径的清理也忽略结果；全代码库没有
   任何 `.uploading.*.tmp` 垃圾回收。
2. 设备快照是全量历史，且图片以 base64 data URL 内嵌（`process_items_blobs_before_push`
   只对增量 ops 生效，`upload_webdav_snapshot` 直接传原始 items）。本地附件
   142 MB（401 个文件），base64 后单次快照可达几十上百 MB，45 秒超时下极易
   半途中断，留下等量级的半截文件。
3. 失败不更新 `last_snapshot_push_at`，自动同步（曾为开启状态，间隔 120s）不断
   重试，每次泄漏一个新临时文件；配额耗尽后所有 PUT 返回 507，Koofr 仍会创建
   0 字节资源，垃圾持续累积，形成恶性循环。

## 修复（src-tauri/src/services/cloud_sync.rs，版本 0.3.5）

- **修复1**：临时文件 PUT 失败后立即 `DELETE` 清理（`upload_webdav_bytes_resource`）。
- **修复2**：新增 `maybe_cleanup_webdav_tmp_garbage`：每 24 小时（设置键
  `cloud_sync_webdav_last_tmp_cleanup_at`）PROPFIND 根目录、devices、ops、
  settings 及 blob 缓存涉及的前缀目录，删除文件名内嵌时间戳超过 24 小时的
  `.uploading.*.tmp`；单轮上限 500 个 DELETE；失败不阻塞同步且不推进时间戳，
  下一轮自动重试。
- **修复3**：507 进入 30 分钟冷却（`WEBDAV_STORAGE_FULL_COOLDOWN_MS`），状态
  文案改为通用 "WebDAV cooldown (rate limit or storage full)"。
- **修复4**：快照推送前对全部条目执行与 ops 相同的 blob 化处理（图片/大文本只
  保留哈希引用）；接收端 `enrich_item_blobs_after_pull` 原生支持解析，协议兼容。
  blob 缓存在快照 PUT 之前落盘，避免重复上传。
- 顺带修正 `database.rs` 测试建表 DDL 缺少 `deleted_at` 列导致的运行时失败
  （回收站迁移 11 之后该 SELECT 包含 deleted_at）。

## 测试与构建

- cargo test：64 通过 / 2 失败。两个失败均为 `window_manager` 多显示器坐标断言，
  依赖测试机显示器布局，属既有问题，与本次改动无关。
- 本机构建命令同 pixpin-clipboard-fix-2026-09-09.md（CARGO_HOME 重定向至
  SystemMomory/build-cache/cargo，离线，--no-bundle --config local-build.json，
  identifier 保持 com.tiez.app）。

## 部署结果

- 2026-09-13 18:22（北京时间）替换并重启 `D:\System and Memory\TieZ\tiez-app.exe`，
  版本 0.3.5。
- SHA-256：CC52CD8A3A9F79D053BAE8B72962CC1523EB48A7C8E4303587734EF755A44DCE
- 备份目录：`D:\System and Memory\TieZ\backup-webdav-tmpfix-20260913-181810`
  （0.3.4 版 tiez-app.exe + SQLite backup API 导出的 clipboard.db，integrity_check=ok）。
- 部署时发现旧进程仍在运行（tasklist 输出异常未检出，由 exe 文件锁发现），
  taskkill 终止 PID 28012 后替换。

## 验证

用户已先手动清空 Koofr `tiez-sync/devices/` 全部内容（含 1 个有效快照，属可再生的
派生数据，本地历史完好）。

验证时发现 `cloud_sync_auto=false`：该状态下启动不自动同步，仅手动"立即同步"
触发。为验证临时将 `cloud_sync_auto` 置为 true 并写入一条剪贴板文本触发同步，
**验证完成后已恢复为 false**（原值）。

结果（UTC 时间戳取自 settings 表）：

- `cloud_sync_webdav_last_snapshot_push_at` = 09-13 10:32 —— 快照推送成功（首次
  blob 化快照，配额已释放故无 507）。
- `cloud_sync_webdav_last_head_rebuild_at` = 09-13 10:32。
- `cloud_sync_webdav_last_tmp_cleanup_at` = 09-13 10:36 —— 首轮 GC 扫描 260 个
  目录（256 个 blob 前缀 + 4 个常规目录）约 5 分钟，日志确认：
  `webdav tmp cleanup removed 233 stale uploading temp file(s)`（devices 之外
  目录的遗留垃圾被自动回收）。
- 剪贴板监听正常（验证文本即时入库）。

## 后续建议

- 如需恢复自动同步，在设置中打开即可；间隔 120s 下每轮同步只做 head/ops 检查，
  快照推送 12h 一次且仅数 MB 以内，GC 每 24h 一次。
- 快照为可再生数据；设备目录再次清空不会丢本地历史。
- 上游仓库建议提交：临时文件清理 + 快照 blob 化 + 507 退避（本次改动均在
  工作区未提交，与回收站等本地改造一致）。
