# 桌宠的 Windows 控制小工具（被 chat-proxy.mjs 调用，不单独运行）
#   powershell -NoProfile -ExecutionPolicy Bypass -File win.ps1 -Action vol-set -Value 40
#   -Action: vol-set | vol-up | vol-down | mute | mute-on | mute-off | vol-get | media-play | media-next | media-prev | screenshot | type | keys | saveas | lock
#   -Value : vol-set 的音量 0..100
#   -Path  : screenshot 的保存路径
param(
  [Parameter(Mandatory = $true)][string]$Action,
  [int]$Value = 0,
  [string]$Path = '',
  [string]$Text = '',
  [switch]$Enter,
  [string]$Keys = '',
  [string]$Title = ''
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

# 窗口枚举（找「另存为」这类对话框）：C# 单独放 winx.cs
if (-not ('WINX' -as [type])) { Add-Type -Path (Join-Path $PSScriptRoot 'winx.cs') }

# 键盘事件（媒体键 / 音量键）
$kb = @'
using System;
using System.Runtime.InteropServices;
public static class KB {
  [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
  public static void Tap(byte vk, int times) {
    for (int i = 0; i < times; i++) {
      keybd_event(vk, 0, 0, UIntPtr.Zero);
      System.Threading.Thread.Sleep(30);
      keybd_event(vk, 0, 2, UIntPtr.Zero);
      System.Threading.Thread.Sleep(30);
    }
  }
}
'@
if (-not ('KB' -as [type])) { Add-Type -TypeDefinition $kb }

# CoreAudio：绝对音量（读 + 写）
$ca = @'
using System;
using System.Runtime.InteropServices;
[Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioEndpointVolume {
  int RegisterControlChangeNotify(IntPtr p);
  int UnregisterControlChangeNotify(IntPtr p);
  int GetChannelCount(out int c);
  int SetMasterVolumeLevel(float level, Guid ctx);
  int SetMasterVolumeLevelScalar(float level, Guid ctx);
  int GetMasterVolumeLevel(out float level);
  int GetMasterVolumeLevelScalar(out float level);
  int SetChannelVolumeLevel(uint ch, float level, Guid ctx);
  int SetChannelVolumeLevelScalar(uint ch, float level, Guid ctx);
  int GetChannelVolumeLevel(uint ch, out float level);
  int GetChannelVolumeLevelScalar(uint ch, out float level);
  int SetMute(bool mute, Guid ctx);
  int GetMute(out bool mute);
  int GetVolumeStepInfo(out uint step, out uint count);
  int VolumeStepUp(Guid ctx);
  int VolumeStepDown(Guid ctx);
  int QueryHardwareSupport(out uint mask);
  int GetVolumeRange(out float min, out float max, out float inc);
}
[Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDevice { int Activate(ref Guid iid, int ctx, IntPtr p, out IAudioEndpointVolume ep); }
[Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDeviceEnumerator { int _0(); int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice dev); }
[ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] class MMDeviceEnumeratorComObject { }
public static class Audio {
  static IAudioEndpointVolume Vol() {
    var en = (IMMDeviceEnumerator)(new MMDeviceEnumeratorComObject());
    IMMDevice dev; en.GetDefaultAudioEndpoint(0, 1, out dev);
    Guid iid = typeof(IAudioEndpointVolume).GUID;
    IAudioEndpointVolume v; dev.Activate(ref iid, 23, IntPtr.Zero, out v);
    return v;
  }
  public static int GetPercent() { float f; Vol().GetMasterVolumeLevelScalar(out f); return (int)Math.Round(f * 100); }
  public static void SetPercent(int p) { Vol().SetMasterVolumeLevelScalar(Math.Max(0f, Math.Min(1f, p / 100f)), Guid.Empty); }
  public static bool GetMute() { bool m; Vol().GetMute(out m); return m; }
  public static void SetMute(bool m) { Vol().SetMute(m, Guid.Empty); }
}
'@
if (-not ('Audio' -as [type])) { Add-Type -TypeDefinition $ca }

function Activate-Window([string]$Title) {
  if (-not $Title) { return '' }
  $alias = @{
    '记事本' = @('Notepad', '记事本'); '计算器' = @('Calculator'); '资源管理器' = @('Explorer')
    '微信' = @('微信', 'WeChat', 'Weixin'); '浏览器' = @('Edge', 'Chrome'); '设置' = @('Settings')
    '任务管理器' = @('Task Manager'); '代码' = @('Visual Studio Code')
  }
  $patterns = @($Title)
  if ($alias.ContainsKey($Title)) { $patterns += $alias[$Title] }
  $hit = Get-Process | Where-Object { $_.MainWindowTitle } | Where-Object {
    $tt = $_.MainWindowTitle
    ($patterns | Where-Object { $tt -like "*$_*" }) -ne $null
  } | Select-Object -First 1
  if (-not $hit) { return '' }
  (New-Object -ComObject WScript.Shell).AppActivate($hit.Id) | Out-Null
  Start-Sleep -Milliseconds 350
  return $hit.MainWindowTitle
}

switch ($Action) {
  'vol-get'   { @{ ok = $true; volume = [Audio]::GetPercent(); mute = [Audio]::GetMute() } | ConvertTo-Json -Compress; break }
  'vol-set'   { [Audio]::SetPercent($Value); @{ ok = $true; volume = [Audio]::GetPercent() } | ConvertTo-Json -Compress; break }
  'mute'      { [Audio]::SetMute(-not [Audio]::GetMute()); @{ ok = $true; mute = [Audio]::GetMute() } | ConvertTo-Json -Compress; break }
  'mute-off'  { [Audio]::SetMute($false); @{ ok = $true; mute = [Audio]::GetMute() } | ConvertTo-Json -Compress; break }
  'mute-on'   { [Audio]::SetMute($true); @{ ok = $true; mute = [Audio]::GetMute() } | ConvertTo-Json -Compress; break }
  'vol-up'    { [KB]::Tap(0xAF, [Math]::Max(1, [Math]::Min(50, $Value))); @{ ok = $true } | ConvertTo-Json -Compress; break }
  'vol-down'  { [KB]::Tap(0xAE, [Math]::Max(1, [Math]::Min(50, $Value))); @{ ok = $true } | ConvertTo-Json -Compress; break }
  'media-play'{ [KB]::Tap(0xB3, 1); @{ ok = $true } | ConvertTo-Json -Compress; break }
  'media-next'{ [KB]::Tap(0xB0, 1); @{ ok = $true } | ConvertTo-Json -Compress; break }
  'media-prev'{ [KB]::Tap(0xB2, 1); @{ ok = $true } | ConvertTo-Json -Compress; break }
  'clickin' {
    # -Text 形如 "0.5,0.93"；-Title 是窗口关键字
    $parts = ($Text -split ',')
    $fx = [double]$parts[0]
    $fy = [double]$parts[1]
    $hitC = Activate-Window $Title
    $ok = if ($hitC) { [WINX]::ClickIn($hitC, $fx, $fy) } else { $false }
    @{ ok = $ok; title = $Title; fx = $fx; fy = $fy } | ConvertTo-Json -Compress
    break
  }  'focus' {
    $hit = Activate-Window $Title
    @{ ok = [bool]$hit; focused = $hit } | ConvertTo-Json -Compress
    break
  }  'saveas' {
    if (-not $Text) { @{ ok = $false; error = 'saveas 需要 -Text 给保存路径' } | ConvertTo-Json -Compress; break }
    # 1) 激活目标窗口
    $act = Activate-Window $Title
    # 2) 给编辑区一个无害按键，确保键盘焦点落在正文（WinUI 记事本 AppActivate 后焦点常在标签栏）
    [System.Windows.Forms.SendKeys]::SendWait('{END}')
    Start-Sleep -Milliseconds 180

    $ok = $false
    $dlgTitle = ''
    $try = 0
    while (-not $ok -and $try -lt 2) {
      $try++
      [System.Windows.Forms.SendKeys]::SendWait('^s')
      Start-Sleep -Milliseconds 1200
      # 3) 枚举顶层窗口找对话框（对话框不是主窗口，Get-Process.MainWindowTitle 看不到）
      $dlgTitle = [WINX]::Find('另存为')
      if (-not $dlgTitle) { $dlgTitle = [WINX]::Find('Save As') }
      if ($dlgTitle) { [void][WINX]::Focus('另存为'); [void][WINX]::Focus('Save As'); Start-Sleep -Milliseconds 250 }
      # 4) 粘完整路径 + 回车
      Set-Clipboard -Value $Text
      Start-Sleep -Milliseconds 200
      [System.Windows.Forms.SendKeys]::SendWait('^v')
      Start-Sleep -Milliseconds 500
      [System.Windows.Forms.SendKeys]::SendWait('{ENTER}')
      Start-Sleep -Milliseconds 1300
      $ok = Test-Path -LiteralPath $Text
    }
    @{ ok = $ok; path = $Text; exists = $ok; dialog = $dlgTitle; tries = $try } | ConvertTo-Json -Compress
    break
  }  'keys' {
    if (-not $Keys) { @{ ok = $false; error = 'keys 为空' } | ConvertTo-Json -Compress; break }
    $map = @{
      'ctrl' = '^'; 'control' = '^'; 'alt' = '%'; 'shift' = '+'
      'enter' = '{ENTER}'; 'return' = '{ENTER}'; 'tab' = '{TAB}'; 'esc' = '{ESC}'; 'escape' = '{ESC}'
      'space' = ' '; 'backspace' = '{BACKSPACE}'; 'delete' = '{DELETE}'; 'del' = '{DELETE}'
      'home' = '{HOME}'; 'end' = '{END}'; 'pageup' = '{PGUP}'; 'pagedown' = '{PGDN}'
      'up' = '{UP}'; 'down' = '{DOWN}'; 'left' = '{LEFT}'; 'right' = '{RIGHT}'
      'insert' = '{INSERT}'; 'printscreen' = '{PRTSC}'; 'break' = '{BREAK}'
      'f1' = '{F1}'; 'f2' = '{F2}'; 'f3' = '{F3}'; 'f4' = '{F4}'; 'f5' = '{F5}'; 'f6' = '{F6}'
      'f7' = '{F7}'; 'f8' = '{F8}'; 'f9' = '{F9}'; 'f10' = '{F10}'; 'f11' = '{F11}'; 'f12' = '{F12}'
    }
    $seq = ''
    foreach ($part in ($Keys -split '\+')) {
      $k = $part.Trim().ToLower()
      if (-not $k) { continue }
      if ($map.ContainsKey($k)) { $seq += $map[$k] }
      elseif ($k -match '^[a-z0-9]$') { $seq += $k }
      elseif ($k.Length -eq 1) { $seq += ('{' + $k + '}') }
      else { $seq += ('{' + $k.ToUpper() + '}') }
    }
    $focused = Activate-Window $Title

    Start-Sleep -Milliseconds 60
    [System.Windows.Forms.SendKeys]::SendWait($seq)
    @{ ok = $true; seq = $seq; keys = $Keys; focused = $focused } | ConvertTo-Json -Compress
    break
  }
  'type' {
    if (-not $Text) { @{ ok = $false; error = 'text 为空' } | ConvertTo-Json -Compress; break }
    if ($Title) { $null = Activate-Window $Title; Start-Sleep -Milliseconds 300 }
    Set-Clipboard -Value $Text
    Start-Sleep -Milliseconds 180
    [System.Windows.Forms.SendKeys]::SendWait('^v')
    if ($Enter) { Start-Sleep -Milliseconds 180; [System.Windows.Forms.SendKeys]::SendWait('{ENTER}') }
    @{ ok = $true; chars = $Text.Length } | ConvertTo-Json -Compress
    break
  }
  'lock' { & rundll32.exe user32.dll,LockWorkStation; @{ ok = $true } | ConvertTo-Json -Compress; break }
  'screenshot' {
    if ($Title) {
      # 只截指定窗口（用 winx 拿矩形）
      $hitT = Activate-Window $Title
      if (-not $hitT) { @{ ok = $false; error = 'no such window' } | ConvertTo-Json -Compress; break }
      $rect = [WINX]::Rect($hitT)
      if (-not $rect) { @{ ok = $false; error = 'no such window' } | ConvertTo-Json -Compress; break }
      $parts = $rect -split ','
      $wx = [int]$parts[0]; $wy = [int]$parts[1]; $ww = [int]$parts[2]; $wh = [int]$parts[3]
      if ($Text) {
        # -Text 形如 "0,0,1,0.12"：相对窗口再裁一块（用来只截标题栏）
        $rel = $Text -split ','
        $wx = $wx + [int]($ww * [double]$rel[0])
        $wy = $wy + [int]($wh * [double]$rel[1])
        $ww = [int]($ww * [double]$rel[2])
        $wh = [int]($wh * [double]$rel[3])
      }
      $b = New-Object System.Drawing.Rectangle($wx, $wy, [Math]::Max($ww, 1), [Math]::Max($wh, 1))
    } else {
      $b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
    }
    $bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.CopyFromScreen($b.Location, [System.Drawing.Point]::Empty, $b.Size)
    if (-not $Path) { $Path = Join-Path $env:TEMP ("shot-" + (Get-Date -Format 'yyyyMMdd-HHmmss') + ".png") }
    $dir = Split-Path -Parent $Path
    if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
    $bmp.Save($Path, [System.Drawing.Imaging.ImageFormat]::Png)
    $g.Dispose(); $bmp.Dispose()
    @{ ok = $true; path = $Path; size = "$($b.Width)x$($b.Height)" } | ConvertTo-Json -Compress
    break
  }
  default { @{ ok = $false; error = "未知动作：$Action" } | ConvertTo-Json -Compress }
}
