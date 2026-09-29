# TieZ-GuLing

**STAY FAST. STAY SYNCED. — A local-first clipboard manager for Windows / macOS (personal optimization line of TieZ)**

[English](./README.md) | [简体中文](./README.zh-CN.md)

> Independently versioned since 1.0.0; no longer tracks upstream TieZ 0.3.x.
> Data identifier stays `com.tiez.app`, so existing TieZ history carries over seamlessly.

## Version series

| GuLing version | Maps to | Settings form |
| :--- | :--- | :--- |
| v0.9.0 | Upstream TieZ 0.3.4 (fork baseline, retroactive tag) | integrated |
| v0.9.5 | Legacy "v0.3.5" local enhancement set: recycle bin / PixPin capture / WebDAV fixes (retroactive tag) | integrated (overlay recycle bin) |
| v1.0.0 | First official release: FTS5 search + on-demand HTML + full-screen recycle bin | integrated |
| **v1.0.1** | Based on 1.0.0: settings in a standalone desktop window | **standalone (this version)** |

This branch / this Release is **v1.0.1 (standalone settings window)**. Prefer the single-window integrated form? Get [v1.0.0](../../releases/tag/v1.0.0).

---

## Features

### Core
- Tauri 2 + Rust core; everything stays on-device
- SQLite **FTS5 (trigram)** full-text search: CJK-substring friendly, sub-millisecond at thousands of rows; filter by source app / tags
- Captures text / rich text (HTML) / images / file paths; rich-text HTML is lazy-loaded per visible item
- Auto-capture for PixPin-style "pin & copy" screenshots (delayed-render compatible with bounded retries)
- Mica / Acrylic materials, dark & light, 4+ themes plus a custom theme store, edge docking

### Standalone settings window (this release)
- Settings live in their own desktop window (860×640, resizable, draggable to any monitor); the main window is clipboard-only
- Live cross-window sync via the `settings-changed` event
- The settings window gets the same mica/acrylic material and native rounded corners

### Management
- **Recycle bin**: deletes are soft, retention configurable (3–30 days), restore / permanent delete / empty
- Multi-color tags, pinning, favorites, notes, emoji library
- Privacy: sensitive-content masking in previews, optional at-rest encryption
- AI actions (translate / polish / summarize with self-configured model profiles)

### Sync & network
- **WebDAV cross-device sync** (temp-file GC, quota-full cooldown, blob-ified snapshots)
- MQTT verification-code sync; LAN file-transfer chat page

### Paste workflows
- Sequential paste queue, rich-paste hotkey, quick-paste modifier
- Default hotkey Alt+C (rebindable; can take over Win+V)

### Theme gallery

| Frosted Glass | Notebook | Sticky Note | 3D |
| :---: | :---: | :---: | :---: |
| ![glass](docs/images/毛玻璃.png) | ![book](docs/images/书.png) | ![note](docs/images/便利贴.png) | ![3d](docs/images/3d.png) |

---

## Download & run

- Grab `TieZ-GuLing-1.0.1-win-x64.exe` (run directly) or the `.zip` (with README) from Releases.
- Data lives in `%APPDATA%\com.tiez.app` by default; for portable data put a `datapath.txt` next to the exe containing an absolute path.
- Unsigned build: choose "More info → Run anyway" on SmartScreen.
- The built-in updater points at upstream and is inert in this fork; update manually from Releases.

## Build

```bash
npm install
npm run tauri:build -- --no-bundle --config <your-identifier.json>
```

> Always build through `tauri:build` (or with the Tauri CLI env vars). A bare `cargo build --release`
> produces a dev-mode exe that tries to reach the dev server (ERR_CONNECTION_REFUSED window).

## Changelog vs upstream 0.3.4

See [docs/CHANGES-FROM-UPSTREAM.md](./docs/CHANGES-FROM-UPSTREAM.md) (recycle bin, FTS5, on-demand HTML,
standalone settings window, PixPin capture fix, WebDAV fixes, re-versioning note, …).

## License & credits

GPL-3.0. Based on [TieZ (jimuzhe/tiez-clipboard)](https://github.com/jimuzhe/tiez-clipboard) — thanks to the original author.
Architecture lineage: EcoPaste family (Tauri 2 + React 19); FTS5 / standalone-settings ideas also informed by KwikPaste.
