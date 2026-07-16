using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Runtime.InteropServices;
using System.Windows.Forms;

internal static class Program
{
    private const int SW_HIDE = 0;
    private const int SW_SHOW = 5;

    [DllImport("kernel32.dll")]
    private static extern IntPtr GetConsoleWindow();

    [DllImport("user32.dll")]
    private static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);

    [DllImport("user32.dll")]
    private static extern bool SetForegroundWindow(IntPtr hWnd);

    [STAThread]
    private static int Main()
    {
        string root = AppContext.BaseDirectory;
        string bun = Path.Combine(root, "runtime", "bun.exe");
        string entry = Path.Combine(root, "src", "bootstrap.ts");
        string hideRequest = Path.Combine(root, "runtime", ".tray-hide-" + Process.GetCurrentProcess().Id);
        string exitRequest = Path.Combine(root, "runtime", ".tray-exit-" + Process.GetCurrentProcess().Id);

        if (!File.Exists(bun) || !File.Exists(entry))
        {
            Console.Error.WriteLine("Mixin ClawLink runtime files are incomplete. Please extract the whole ZIP before running.");
            return 2;
        }

        var startInfo = new ProcessStartInfo
        {
            FileName = bun,
            Arguments = "\"" + entry + "\"",
            WorkingDirectory = root,
            UseShellExecute = false
        };
        startInfo.EnvironmentVariables["MIXIN_TRAY_HIDE_FILE"] = hideRequest;
        startInfo.EnvironmentVariables["MIXIN_TRAY_EXIT_FILE"] = exitRequest;

        TryDelete(hideRequest);
        TryDelete(exitRequest);

        using (Process process = Process.Start(startInfo))
        {
            if (process == null) return 3;
            IntPtr consoleWindow = GetConsoleWindow();
            DateTime? exitRequestedAt = null;

            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);

            using (var menu = new ContextMenuStrip())
            using (var notify = new NotifyIcon())
            using (var timer = new Timer())
            {
                var showItem = new ToolStripMenuItem("显示 Mixin ClawLink");
                var exitItem = new ToolStripMenuItem("退出");
                menu.Items.Add(showItem);
                menu.Items.Add(new ToolStripSeparator());
                menu.Items.Add(exitItem);

                notify.Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath) ?? SystemIcons.Application;
                notify.Text = "Mixin ClawLink";
                notify.ContextMenuStrip = menu;
                notify.Visible = false;

                Action showConsole = delegate
                {
                    ShowWindow(consoleWindow, SW_SHOW);
                    SetForegroundWindow(consoleWindow);
                    notify.Visible = false;
                };
                Action requestExit = delegate
                {
                    if (!exitRequestedAt.HasValue)
                    {
                        File.WriteAllText(exitRequest, "exit");
                        exitRequestedAt = DateTime.UtcNow;
                    }
                };

                showItem.Click += delegate { showConsole(); };
                notify.DoubleClick += delegate { showConsole(); };
                exitItem.Click += delegate { requestExit(); };

                timer.Interval = 250;
                timer.Tick += delegate
                {
                    if (process.HasExited)
                    {
                        notify.Visible = false;
                        Application.ExitThread();
                        return;
                    }
                    if (File.Exists(hideRequest))
                    {
                        TryDelete(hideRequest);
                        notify.Visible = true;
                        ShowWindow(consoleWindow, SW_HIDE);
                    }
                    if (exitRequestedAt.HasValue && DateTime.UtcNow - exitRequestedAt.Value > TimeSpan.FromSeconds(8))
                    {
                        try { process.Kill(); } catch { }
                    }
                };
                timer.Start();
                Application.Run();
                timer.Stop();
                notify.Visible = false;
            }

            process.WaitForExit();
            TryDelete(hideRequest);
            TryDelete(exitRequest);
            return process.ExitCode;
        }
    }

    private static void TryDelete(string path)
    {
        try { if (File.Exists(path)) File.Delete(path); } catch { }
    }
}
