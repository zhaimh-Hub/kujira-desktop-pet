// PetHotkey —— 极小的常驻托盘程序（只有一个全局热键 + 托盘图标）
//   作用：按 Ctrl+Alt+空格 随时「喊」大肥鱼出来（没开就启动，已开就叫到前面并展开输入框）
//   编译：<PATH> /target:winexe /out:PetHotkey.exe ^
//           /r:System.Windows.Forms.dll /r:System.Drawing.dll PetHotkey.cs
//   说明：常驻内存约 10 MB，比 Electron 便宜得多；不想常驻就删掉启动文件夹里的快捷方式。
using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Runtime.InteropServices;
using System.Windows.Forms;
using System.Text;

static class Native
{
    [DllImport("user32.dll")] public static extern bool RegisterHotKey(IntPtr hWnd, int id, uint mods, uint vk);
    [DllImport("user32.dll")] public static extern bool UnregisterHotKey(IntPtr hWnd, int id);
}

class HotkeyWindow : NativeWindow
{
    public const int WM_HOTKEY = 0x0312;
    public Action OnHotkey;
    public HotkeyWindow() { var cp = new CreateParams(); cp.Caption = "PetHotkey"; CreateHandle(cp); }
    protected override void WndProc(ref Message m)
    {
        if (m.Msg == WM_HOTKEY && OnHotkey != null) OnHotkey();
        base.WndProc(ref m);
    }
}

class Program
{
    const int HOTKEY_ID = 0xA1;
    const uint MOD_ALT = 0x0001, MOD_CONTROL = 0x0002;
    const uint VK_SPACE = 0x20;

    static readonly string AppDir = AppDomain.CurrentDomain.BaseDirectory;
    static readonly string PetDir = Path.GetFullPath(Path.Combine(AppDir, ".."));
    static readonly string Electron = Path.Combine(PetDir, "node_modules", "electron", "dist", "electron.exe");
    static NotifyIcon tray;
    static string LogPath = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "pethotkey.log");
    static void Log(string m) { try { File.AppendAllText(LogPath, DateTime.Now.ToString("HH:mm:ss") + " " + m + Environment.NewLine, Encoding.UTF8); } catch { } }
    static HotkeyWindow hw;

    [STAThread]
    static void Main()
    {
        Application.EnableVisualStyles();

        hw = new HotkeyWindow();
        hw.OnHotkey = Launch;
        bool ok = Native.RegisterHotKey(hw.Handle, HOTKEY_ID, MOD_CONTROL | MOD_ALT, VK_SPACE);
        Log("start; hotkey registered=" + ok + "; pet=" + PetDir);

        var menu = new ContextMenuStrip();
        menu.Items.Add("叫出大肥鱼（Ctrl+Alt+空格）", null, (s, e) => Launch());
        menu.Items.Add("打开桌宠文件夹", null, (s, e) => Process.Start("explorer.exe", PetDir));
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add("退出（不再常驻）", null, (s, e) => { tray.Visible = false; Application.Exit(); });

        Icon icon = null;
        try { icon = Icon.ExtractAssociatedIcon(Path.Combine(PetDir, "assets", "icon.ico")); } catch { }
        tray = new NotifyIcon
        {
            Icon = icon ?? SystemIcons.Application,
            Text = ok ? "大肥鱼：Ctrl+Alt+空格 叫我" : "大肥鱼（热键被占用）",
            Visible = true,
            ContextMenuStrip = menu,
        };
        tray.DoubleClick += (s, e) => Launch();

        Application.Run(new ApplicationContext());
        Native.UnregisterHotKey(hw.Handle, HOTKEY_ID);
        tray.Dispose();
    }

    static void Launch()
    {
        try
        {
            if (!File.Exists(Electron)) { Log("electron.exe missing: " + Electron); MessageBox.Show("找不到 electron.exe：\n" + Electron, "大肥鱼"); return; }
            var psi = new ProcessStartInfo(Electron, PetDir.Contains(" ") ? "\"" + PetDir + "\"" : PetDir)
            {
                WorkingDirectory = PetDir,
                UseShellExecute = false,
                CreateNoWindow = true,
            };
            psi.EnvironmentVariables.Remove("ELECTRON_RUN_AS_NODE");   // 必须「删掉」而不是设成空串：空串也算已定义，Electron 会当 Node 跑
            Process.Start(psi);
            Log("electron started");
        }
        catch (Exception ex) { MessageBox.Show("启动失败：" + ex.Message, "大肥鱼"); }
    }
}
