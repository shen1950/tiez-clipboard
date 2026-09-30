# Windows 安装版构建

默认交付 Setup 安装程序：

```powershell
npm run tauri:build
```

Tauri 自动合并 `src-tauri/tauri.windows.conf.json`，生成
`src-tauri/target/release/bundle/nsis/TieZ_<版本>_x64-setup.exe`。
也可显式运行 `npm run tauri:build:setup`。

- 使用原有产品名 TieZ 和应用标识 com.tiez.app，沿用安装登记及数据目录。
- 当前用户安装，支持选择目录、开始菜单/桌面快捷方式、升级和卸载。
- 包含 WebView2 引导程序；电脑未安装运行环境时需要联网下载。
- 本机定制构建不生成需要上游私钥的更新签名文件；后续更新交付新的 Setup。
- `target/release/tiez-app.exe` 是构建中间产物，不应作为默认交付文件。
- 只有明确需要单文件时才使用 `npm run tauri:build:portable`。

安装或升级前备份旧程序和数据库。不要修改 identifier 或主动删除用户数据目录。

参考：[Tauri Windows Installer](https://v2.tauri.app/distribute/windows-installer/)。
