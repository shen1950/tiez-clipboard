# PixPin 截图自动收录修复（2026-09-09）

## 现象与定位

PixPin 开启「贴图并复制到剪贴板」后，TieZ 要等 Ctrl+V 或 Win+V 才收录图片。
原监听器直接在 WM_CLIPBOARDUPDATE 的窗口回调内读取剪贴板，且读取前按序号跳过事件；读取失败也提前写入序号和空内容哈希，没有自动补读。
这些行为与延迟渲染及短暂剪贴板占用不兼容。PixPin 本机实际截图仍需部署后人工复测，不能仅凭单元测试宣称已复现其全部行为。

微软文档说明延迟渲染可能在数据实际生成后才递增序号：
https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-getclipboardsequencenumber

## 修复

- 窗口回调仅向容量为 1 的通道发送通知；单独的工作线程串行读取，合并通知突发。
- 原生通知即使序号未变也触发读取，成功读取后按实际内容去重。
- 无可读取内容时最多补读 6 次，间隔 50/100/200/400/800/1000 毫秒，每次重新创建读取缓存。
- 每 500 毫秒检查序号作为漏通知兜底；序号不变且没有待重试任务时不读取图片。
- 读取失败不写入内容去重状态；只有自定义 PNG/GIF 等格式的内容也不再被空哈希错误跳过。
- 保留原有截图工具等待策略、暂停监听和自复制过滤逻辑。

修改涉及 services/clipboard_listener.rs、services/clipboard_worker.rs、services/clipboard/mod.rs 和 services/mod.rs。
另修正两个原有测试编译障碍：clipboard/utils.rs 的重复 tests 模块名称，以及 database.rs 的测试数据缺少 deleted_at 字段。此前 OpenCode 的其他修改保留。

## 验证

- Rust 剪贴板相关测试：55/55 通过，含本次新增的三个工作线程回归测试。
- Windows DIB 掩码测试：2/2 通过。
- 前端 utils 测试：18/18 通过。
- TypeScript 检查及 Vite 构建通过。
- git diff --check 通过。

## 本机构建

正在使用的原程序是 D:\System and Memory\TieZ\tiez-app.exe（0.3.3），本目录源码为 0.3.4。
数据重定向位于 %APPDATA%\com.tiez.app\datapath.txt，指向 D:\System and Memory\TieZ\com.tiez.app。
本机构建使用 SystemMomory/build-cache/local-build.json 保持 identifier=com.tiez.app，避免改用源码默认的 com.tiez 而打开另一套数据。

原 Rust 注册表缓存已缺失，恢复到了 SystemMomory/build-cache/cargo，未修改用户全局 Cargo 配置。
前端 vitest 原本未安装；本地补齐，同时将 @tauri-apps/api、plugin-updater 和 plugin-dialog 分别对齐到 2.10.1、2.10.1、2.6.0（没有改写 package.json 或 package-lock.json）。

```powershell
$env:CARGO_HOME = 'D:\System and Memory\SystemMomory\build-cache\cargo'
$env:CARGO_NET_OFFLINE = 'true'
$env:CARGO_PROFILE_RELEASE_LTO = 'false'
$env:CARGO_PROFILE_RELEASE_CODEGEN_UNITS = '16'
npm run tauri:build -- --no-bundle --config 'D:\System and Memory\SystemMomory\build-cache\local-build.json'
```

手工复测：使用 PixPin 截图或贴图并复制，先不要粘贴、打开 Win+V 或唤起 TieZ，等待自动收录；再连续截图确认都能收录，并检查普通文本复制正常。

## 本机部署结果

2026-09-09 14:31（北京时间）已替换并重启 D:\System and Memory\TieZ\tiez-app.exe，版本 0.3.4。
正式 release 构建通过；SHA-256：C0FD56DF61B0FF17D0EB871C4A5B4166827815D518B575C49A28599D80EB254E。
新进程启动日志确认 background reads、bounded retries、sequence fallback 已启用。

备份目录：D:\System and Memory\TieZ\backup-pixpin-20260909-1430，包含原版 tiez-app.exe 和通过 SQLite backup API 创建并完整性校验通过的 clipboard.db。
部署前后历史记录均为 1439 条；数据库 quick_check=ok。
此前源码自带的数据库迁移将 schema 从 9 更新到 11，原数据目录保持不变。
本机 PixPin 截图最终体验已请求用户复测，尚未收到结果。
