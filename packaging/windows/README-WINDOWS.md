# Mixin ClawLink 1.0 — Windows x64

这是 Windows x64 one-dir 发行包，不是单文件 EXE。ZIP 已包含 Bun 运行时和生产依赖，无需另行安装 Bun 或执行 `bun install`。

## 使用方法

1. 将 ZIP 完整解压到一个可写目录，不要直接在压缩包内运行。
2. 双击 `start.cmd`。
3. 首次启动时，在 TUI 配置工作台填写量子密信智能助理的 `APP_ID`、`APP_SECRET` 等配置。
4. 按 `Ctrl+S` 保存并启动。

程序会在解压目录中创建 `.env`、`data`、`logs` 和 `workspace`。发布包不包含发布者的配置、凭据、日志或会话数据。

Claude Agent 使用本机用户级 Claude Code 配置；如使用第三方模型后端，请按主 README 配置 `~/.claude/settings.json`。

支持平台：Windows 10/11 x64。
