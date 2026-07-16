# Mixin ClawLink 1.0 — Windows x64

这是 Windows x64 one-dir 发行包。ZIP 已包含 Bun 运行时和生产依赖，无需另行安装 Bun 或执行 `bun install`；为避免重复携带约 253 MB 的 CLI，Claude Agent 使用用户本机已安装的 Claude Code。

## 使用方法

1. 将 ZIP 完整解压到一个可写目录，不要直接在压缩包内运行。
2. 双击 `MixinClawLink.exe`；如被本机安全策略拦截，可改用 `start.cmd`。
3. 首次启动时，在 TUI 配置工作台填写量子密信智能助理的 `APP_ID`、`APP_SECRET` 等配置。
4. 按 `Ctrl+S` 保存并启动。

运行中按 `Ctrl+B` 可隐藏控制台并转入 Windows 系统托盘；双击托盘图标或右键“显示”可恢复，右键“退出”会优雅停止 Bot。托盘功能仅在通过 `MixinClawLink.exe` 启动时可用。

程序会在解压目录中创建 `.env`、`data`、`logs` 和 `workspace`。发布包不包含发布者的配置、凭据、日志或会话数据。

Claude Agent 使用本机用户级 Claude Code 配置；如使用第三方模型后端，请按主 README 配置 `~/.claude/settings.json`。

支持平台：Windows 10/11 x64。
