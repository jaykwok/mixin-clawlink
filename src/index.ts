/**
 * 入口：bun src/index.ts
 *
 * 启动即起 TUI（OpenTUI 运维面板 / 首启向导）。TUI 挂在重启循环之外，
 * 软重启（/reboot）只重建 Bot，TUI 不销毁。Ctrl+C 优雅退出；
 * 运行期异常 5 秒后自动重建（便于无人值守的远程部署）。
 */
import { cfg, reload } from "./config.ts";
import { Bot } from "./bot.ts";
import { getLogger, setupLogging } from "./logger.ts";
import { startTui } from "./tui/index.tsx";

const log = getLogger("launcher");

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function main(): Promise<void> {
  setupLogging();
  console.log(`\n  Mixin ClawLink — 量子密信智能助理连接器 — agent=${cfg.AGENT}  env=${cfg.ENV}  (Bun + OpenTUI)\n`);

  let sigint = false;
  let activeBot: Bot | null = null;

  // TUI（运维面板 / 首启向导）。挂在重启循环之外：软重启只重建 Bot，TUI 不销毁。
  const tui = await startTui({
    onQuit: () => { sigint = true; if (activeBot) void activeBot.stop().catch(() => {}); },
  });
  // 外部 SIGINT（kill -INT）兜底；TUI 已接管 Ctrl+C，这里只处理外部信号
  process.on("SIGINT", () => { sigint = true; if (activeBot) void activeBot.stop().catch(() => {}); });

  // 首次运行（凭据缺失）→ TUI 设置向导；填完才进 bot 循环
  if (!cfg.APP_ID || !cfg.APP_SECRET) {
    log.info("首次运行：等待 TUI 设置向导完成…");
    await tui.waitForWizard();
    reload(); // 向导已逐项 reload，这里再保险一次
  }
  if (sigint) { await tui.shutdown(); log.info("已退出"); return; } // 向导里 Ctrl+C 退出

  let notify: string | null = null;
  // 循环条件挂在 sigint 上：Ctrl+C 落在哪一步都行（含 5s 退避、/reboot 的 reload），下次回到顶部即退出。
  while (!sigint) {
    const bot = await Bot.create(notify ? { notifyStart: notify } : undefined);
    notify = null;
    activeBot = bot;
    tui.attachBot(bot);
    let crashed = false;
    try {
      await bot.serve(); // start + 常驻，直到 stop / reboot / 异常
    } catch (e) {
      crashed = true;
      log.error("Bot 运行异常: %s", e instanceof Error ? e.stack : String(e));
    } finally {
      tui.detachBot();
      await bot.stop().catch(() => {}); // 统一收尾，防 ws/agent 关闭抛错冒泡
    }
    if (crashed && !sigint) {
      log.warn("5 秒后重建…");
      await sleep(5000);
      continue;
    }
    if (!bot.rebootRequested || sigint) break;
    notify = bot.rebootByUid; // 让新 bot 启动后给触发者发"重启完成"
    reload();
    log.info("软重启：已重载 .env，重建 Bot…");
  }
  activeBot = null;
  await tui.shutdown();
  log.info("已退出");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
