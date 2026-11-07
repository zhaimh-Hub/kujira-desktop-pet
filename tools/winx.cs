// 窗口枚举小工具（供 win.ps1 找「另存为」这类对话框）
// 编译方式：win.ps1 里 Add-Type -Path winx.cs（PowerShell 自己编，无需 csc）
using System;
using System.Text;
using System.Runtime.InteropServices;

public static class WINX
{
    delegate bool EnumProc(IntPtr h, IntPtr p);

    [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr p);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
    [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int cmd);

    static IntPtr FindHandle(string pattern)
    {
        IntPtr hit = IntPtr.Zero;
        EnumWindows((h, p) =>
        {
            if (!IsWindowVisible(h)) return true;
            var sb = new StringBuilder(512);
            GetWindowText(h, sb, 512);
            var title = sb.ToString();
            if (title.Length > 0 && title.IndexOf(pattern, StringComparison.OrdinalIgnoreCase) >= 0)
            {
                hit = h;
                return false;
            }
            return true;
        }, IntPtr.Zero);
        return hit;
    }

    /// <summary>找标题包含 pattern 的可见顶层窗口，返回它的标题（没有就返回空串）</summary>
    public static string Find(string pattern)
    {
        var h = FindHandle(pattern);
        if (h == IntPtr.Zero) return "";
        var sb = new StringBuilder(512);
        GetWindowText(h, sb, 512);
        return sb.ToString();
    }

    /// <summary>找到并置前（对话框中「保存」按钮才会响应 SendKeys 的回车）</summary>
    public static bool Focus(string pattern)
    {
        var h = FindHandle(pattern);
        if (h == IntPtr.Zero) return false;
        ShowWindow(h, 9);      // SW_RESTORE
        SetForegroundWindow(h);
        return true;
    }

    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }

    /// <summary>按标题取窗口矩形，返回 "x,y,w,h"；找不到返回空串</summary>
    public static string Rect(string pattern)
    {
        var h = FindHandle(pattern);
        if (h == IntPtr.Zero) return "";
        RECT r;
        if (!GetWindowRect(h, out r)) return "";
        return string.Format("{0},{1},{2},{3}", r.Left, r.Top, r.Right - r.Left, r.Bottom - r.Top);
    }

    [DllImport("user32.dll")] static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] static extern void mouse_event(uint f, int dx, int dy, int d, UIntPtr extra);

    /// <summary>在屏幕坐标处点一下左键</summary>
    public static void Click(int x, int y)
    {
        SetCursorPos(x, y);
        System.Threading.Thread.Sleep(60);
        mouse_event(0x0002, 0, 0, 0, UIntPtr.Zero);
        System.Threading.Thread.Sleep(40);
        mouse_event(0x0004, 0, 0, 0, UIntPtr.Zero);
    }

    /// <summary>点窗口的某个相对位置（0~1），比如 (0.5, 0.93) = 底部中间</summary>
    public static bool ClickIn(string pattern, double fx, double fy)
    {
        var h = FindHandle(pattern);
        if (h == IntPtr.Zero) return false;
        RECT r;
        if (!GetWindowRect(h, out r)) return false;
        ShowWindow(h, 9);
        SetForegroundWindow(h);
        System.Threading.Thread.Sleep(200);
        int x = r.Left + (int)((r.Right - r.Left) * fx);
        int y = r.Top + (int)((r.Bottom - r.Top) * fy);
        Click(x, y);
        return true;
    }
}