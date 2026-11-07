# 大肥鱼桌宠（Kujira Desktop Pet）

把 [livliv-dev/player](https://github.com/livliv-dev/player) 的 2.5D 角色做成**桌面宠物 + 会干活的 AI 助手**：
透明无边框窗口、真人音色朗读、真实振幅口型、多步工具调用、本地视觉、任务提醒、微信发送（人工确认）。

> 本项目只是「外壳 + 页面 + 代理」，**依赖上游 player 库**（角色与渲染）。角色模型（`.livliv`）请从上游或你自备的包里获取。

## 功能

| 能力 | 说明 |
|---|---|
| 桌面宠物 | Electron 透明窗口、无边框、置顶、可拖拽、托盘菜单、全局热键 `Ctrl+Alt+空格` |
| 会说话 | edge-tts 真人音色（失败退系统语音）；**说话时音量/口型按真实音频振幅驱动**，🔊 可静音 |
| 会干活 | 31 个工具：开应用/读文件/写笔记/设提醒/重复任务/查天气/翻译/联网搜索/音量/媒体/截图/读屏/打字/组合键/另存为/发微信… |
| 多步任务 | 最多 8 轮工具循环，SSE 实时进度显示在气泡里 |
| 本地记忆 | `bge-m3` 向量记忆（Ollama），语义召回 |
| 本地视觉 | `qwen2.5vl:7b` 读屏、OCR，不联网、不花钱 |
| 任务面板 | `pages/pet-tasks.html`：暂停/恢复/改间隔/删除，`Ctrl+Alt+T` 打开 |
| 安全 | 应用白名单、路径白名单、危险操作二次确认、**对外发送必须人工确认** |

## 目录结构

```
kujira-pet/
├─ app/            Electron 壳（main.js / preload.js）与聊天代理（chat-proxy.mjs）
├─ pages/          页面：pet-chat.html（主）、pet-tasks.html（任务面板）、my-pet.html、pet-card.html、wallpaper.html
├─ tools/          win.ps1（音量/媒体/截图/打字/按键）、winx.cs（窗口枚举与点击）、PetHotkey.cs（常驻热键）
├─ assets/         托盘与图标
├─ docs/           搭建记录（含踩坑清单）
├─ config.example.json
└─ setup.ps1       一键准备：装依赖、把页面装进 player 的 example 目录
```

## 快速开始

```powershell
# 0) 需要 Node.js 18+、Windows 10/11
# 1) 准备依赖
.\setup.ps1                 # 会在 ..\player 找上游库；没有会提示先 clone

# 2) 配置（复制一份，填入自己的 key）
Copy-Item config.example.json config.json
# 编辑 config.json：填 deepseekKey 或设置环境变量 DEEPSEEK_API_KEY

# 3) 启动
npm start                   # 托盘出现，桌宠从右下角出来
```

可选：本地模型（Ollama）

```powershell
ollama pull qwen3.5:4b        # 离线聊天（不想用云端时）
ollama pull bge-m3            # 向量记忆
ollama pull qwen2.5vl:7b      # 本地视觉（读屏）
```

## 热键

| 热键 | 作用 |
|---|---|
| `Ctrl+Alt+空格` | 叫出/启动桌宠（由 `tools/PetHotkey.cs` 编译的常驻小程序提供） |
| `Ctrl+Alt+T` | 打开任务面板 |
| `Ctrl+Alt+H` | 显示/隐藏 |
| `Ctrl+Alt+P` | 点击穿透 |
| `Ctrl+Alt+↑ / ↓` | 缩放 |
| `Ctrl+Alt+Q` | 退出 |

## 隐私

- **不含任何密钥**：`config.json` 与 `data/` 已在 `.gitignore` 中
- 本机路径全部换成了占位符（`<APP_DIR>`、`<PLAYER_DIR>`、`<WECHAT_EXE>` 等），运行时会自动解析为真实路径
- 视觉/记忆/提醒都在本地（Ollama + 本地文件），只有聊天会按你选择的 provider 联网

## 已知限制

- 微信发送**只能「先人工点开聊天 → 程序打字 → 人工确认 → 回车」**；自动搜索联系人不安全（曾把消息发进群聊），已停用
- 停止键（工作中显示 ■）只完成了中止逻辑，视觉状态未完成
- 视觉模型读小字不稳，需要更强模型

## 许可

本仓库代码 MIT。上游 player 库版权归其作者，按其各自许可使用。

## 文档

详细搭建与踩坑记录见 [docs/搭建记录.md](docs/搭建记录.md)。