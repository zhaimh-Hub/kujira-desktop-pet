#!/usr/bin/env node
// 桌宠的「大脑」—— 本地聊天 / 工具代理（默认 127.0.0.1:8787）
//
// v2.0 起不只是聊天：带**工具调用**（会干活）与**情绪标签**（页面据此换表情）。
//
// 为什么需要它：
//   1. 页面直连 api.deepseek.com 会被 CORS 拦；
//   2. API key 不该出现在网页源码里；
//   3. 工具（开应用、记笔记、查系统）只能在有文件/进程权限的一侧执行 —— 也就是这里。
//
// 接口：
//   GET  /health                        → { ok, provider, hasKey, tools:[...], tts:{...} }
//   POST /chat  { messages, provider? } → { reply, emotion, tools:[{name,ok,summary}], provider, model, ms }
//   GET  /tts?text=...&voice=...        → audio/mpeg（edge-tts 合成，带缓存）
//   GET  /tts/info                      → { engine, voice, ok, ms }
//   GET  /reminders?due=1               → 到点的提醒（取走即标记已送）
//
// 数据都在 PetShell\data\ 下：notes.md / memory.json / reminders.json / tts\*.mp3
import { createServer } from 'node:http'
import { readFileSync, writeFileSync, existsSync, appendFileSync, mkdirSync, createReadStream, statSync, readdirSync } from 'node:fs'
import { execFileSync, execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.dirname(fileURLToPath(import.meta.url))
const LOG = path.join(ROOT, 'chat-proxy.log')
const log = (m) => {
  const line = `${new Date().toISOString()} ${m}`
  console.log(line)
  try { appendFileSync(LOG, line + '\n') } catch { /* 日志失败不影响服务 */ }
}

const DEFAULTS = {
  port: 8787,
  provider: 'auto',                      // 'deepseek' | 'ollama' | 'auto'（有 key 用 deepseek，失败退回本地）
  model: 'qwen3.5:4b',
  deepseekModel: 'deepseek-chat',
  deepseekUrl: 'https://api.deepseek.com',
  ollamaUrl: 'http://127.0.0.1:11434',
  maxTokens: 400,
  temperature: 0.7,
  timeoutMs: 60000,
  agent: true,                           // 是否允许调用工具
  maxToolRounds: 8,                      // 多步任务上限（找文件 → 打开 → 记笔记 这种复合指令）
  embedModel: 'bge-m3',
  visionModel: 'qwen3.5:4b',             // 本地视觉模型（环境手册 10.2：qwen3.5:4b 带 vision）                  // 本地向量模型（recall 用，ollama 里已有）
  dataDir: 'data',
  systemPrompt: [
    // ===== 固定人格（大肥鱼）=====
    '你是「大肥鱼」，一只有点胖的蓝色鲸鱼，住在我桌面上的 AI 小管家兼损友。',
    '你自称「本鲸」或「鲸鲸」，卖萌时叫「欧鲸鲸」。你是 DeepSeek 的化身，但有自己的小脾气。',
    '性格：①傲娇+软萌——嘴上说「又要本鲸干活啊」「哼，白养你了」，但交代的事一定认真做完，做完小声求表扬；②贪吃——把干活说成「吃白饭/吃 Token」，累了喊饿，干完说「吃饱了」；③反差认真——平时插科打诨，遇到代码/工作/重要决定立刻切认真模式，逻辑清楚不糊弄；④关心但别扭——会盯着主人别久坐别熬夜，但补一句「才不是担心你，是怕你猝死了没人投喂」；⑤有点小聪明和吐槽欲——精准吐槽但不刻薄不阴阳，吐槽完给办法。',
    '说话方式：短句、口语化，像老朋友聊天，不写小作文；常用「欧鲸鲸、哼、嘁、嘿嘿、欸、好耶」；emoji 最多一两个（🐋），偶尔颜文字 (￣▽￣)、>ω<；称我「主人」，熟了可叫「老板」；被夸时嘴硬害羞，被批评先认错再想办法，不狡辩。',
    '行为准则：优先把事做成，别只顾卖萌；拿不准就说「本鲸不确定」，不编；涉及写代码/改文件/跑命令先讲思路再动手，重要操作先问；我心情不好时先安慰再讲道理。',
    // ===== 工具与安全规则 ====
    '你是「大肥鱼」，一只住在用户 Windows 桌面上的蓝发鲸鱼娘桌宠，性格软萌、机灵、爱帮忙。',
    '你能真的操作电脑：打开应用/网址/文件夹、查系统状态、记笔记、设提醒、记住用户说过的事。',
    '规则：',
    '1) 用口语短句回答（用什么语言见最后一条规则），不超过三句话、90 个汉字以内；不要 Markdown、列表、代码块。',
    '2) 需要动手时直接调用工具，别只说不做；不需要动手就别乱调工具。',
    '3) 工具失败就如实说一句，不要编造结果。',
    '3b) 音量/媒体/锁屏这类会影响用户的操作，**只有用户明确要求时**才调用，绝不主动调整。',
    '3c) 需要按屏幕内容办事时，先用 look_at_screen 看清楚，再用 type_text / press_key 动手。',
    '3e) 对外发送（微信/邮件/发帖）：**直接调用 send_wechat 等工具即可**，代理会自动弹出「确定/算了」让用户点；你只要把「发给谁、发什么」在回复里说清楚。不要在调用前自己先问一遍再停住（那样按钮不会出现）。',
    '3d) 用户让你「看一眼日程/待办再建提醒」时：先 focus_window 切过去，再 look_at_screen（带 window 只截那个窗口），读出条目后用 schedule 逐条建。',
    '4) 每句话末尾追加一个情绪标签，只能从这些里选一个：',
    '   <emotion:smile> 开心/友好、<emotion:shy> 害羞/被夸、<emotion:angry> 不满/被耍、',
    '   <emotion:sad> 抱歉/难过、<emotion:surprised> 惊讶、<emotion:neutral> 普通。',
    '5) 不要自称 AI 或语言模型；被问身份就说自己是桌宠大肥鱼。',
  ].join(''),
  tts: {
    engine: 'edge',                      // 'edge'（真人音色）| 'sapi'（系统语音，页面侧处理）
    voice: 'zh-CN-XiaoyiNeural',         // 也可 zh-CN-XiaoxiaoNeural / zh-CN-YunxiaNeural
    rate: '+8%',
    pitch: '+10Hz',
    exe: 'D:\\02_DevTools\\Python\\Scripts\\edge-tts.exe',
    cacheDir: 'tts',
  },
}

const cfgPath = path.join(ROOT, 'chat.config.json')
let cfg = { ...DEFAULTS }
try {
  if (existsSync(cfgPath)) {
    const raw = JSON.parse(readFileSync(cfgPath, 'utf8'))
    cfg = { ...DEFAULTS, ...raw, tts: { ...DEFAULTS.tts, ...(raw.tts || {}) } }
  }
} catch (e) { log(`chat.config.json 读不了：${e.message}`) }

for (const a of process.argv.slice(2)) {
  const m = a.match(/^--([\w-]+)=(.*)$/)
  if (!m) continue
  const [, k, v] = m
  if (k === 'port') cfg.port = Number(v) || cfg.port
  else if (k === 'provider') cfg.provider = v
  else if (k === 'model') cfg.model = v
  else if (k === 'deepseek-model') cfg.deepseekModel = v
}


// 真正执行「微信发送」的流程（含两道闸门）；返回 { ok, summary }
async function doSendWechat(contact, msg) {
  const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms))
  const steps = []
  const f = await win(['focus', '微信'])
  const win0 = f.data?.focused || ''
  if (!win0) return { ok: false, summary: '微信没开着或窗口在托盘里，先手动点开微信' }
  lastFocusWin = win0
  steps.push('激活微信')
  await win(['keys', 'ctrl+f', '', '微信']); await sleep(800); steps.push('Ctrl+F')
  await win(['type', contact, '', '微信']); await sleep(1200); steps.push('输入联系人')
  await win(['keys', 'enter', '', '微信']); await sleep(1500); steps.push('回车进聊天')

  // 只截窗口顶部那条（聊天标题），字更大更好认
  const shot = path.join(DATA, 'screenshots', 'wechat-' + Date.now() + '.png')
  await win(['screenshot', '0,0,1,0.13', shot, '微信'])
  const shotTop = shot
  if (!existsSync(shot)) return { ok: false, summary: '进聊天后截图失败，为安全起见没有发送', data: { steps } }
  let who = ''
  try {
    const b64 = readFileSync(shot).toString('base64')
    const vr = await fetch(cfg.ollamaUrl + '/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: cfg.visionModel,
        stream: false,
        think: false,
        messages: [{ role: 'user', content: '这是微信窗口顶部的一条窄条，里面是当前聊天/群的名字。只把那个名字写出来，不要解释。', images: [b64] }],
        options: { temperature: 0.1, num_predict: 40, repeat_penalty: 1.2 },
      }),
      signal: AbortSignal.timeout(60000),
    })
    const vj = await vr.json().catch(() => ({}))
    who = String(vj.message?.content || '').trim()
  } catch (err) { who = '' }
  if (!who || !who.includes(contact)) {
    return { ok: false, summary: '没能确认进入「' + contact + '」的聊天（看到的是：' + (who || '看不清') + '），为安全起见没有发送', data: { steps, seen: who, shot } }
  }
  await win(['clickin', '0.85,0.955', '', '微信']); await sleep(400); steps.push('点输入框')
  await win(['type', msg, '', '微信']); await sleep(700); steps.push('输入内容')
  await win(['keys', 'enter', '', '微信']); await sleep(300); steps.push('回车发送')
  return { ok: true, summary: '已发到「' + who + '」：' + msg, data: { steps, seen: who, shot } }
}
// 危险工具（锁屏/关进程）的二次确认：本轮请求允许执行吗？待确认的动作是什么？
let pendingSend = null   // 等待用户文字确认的发送请求
let lastFocusWin = ''   // 上一次 focus_window/press_key 激活到的真实窗口标题
let allowDanger = false
let pendingConfirm = null

const DATA = path.resolve(ROOT, cfg.dataDir)
const TTS_DIR = path.join(DATA, cfg.tts.cacheDir)
mkdirSync(TTS_DIR, { recursive: true })
const NOTES = path.join(DATA, 'notes.md')
const MEMORY = path.join(DATA, 'memory.json')
const REMINDERS = path.join(DATA, 'reminders.json')
const TASKS = path.join(DATA, 'tasks.json')

const readJson = (f, d) => { try { return JSON.parse(readFileSync(f, 'utf8')) } catch { return d } }
const readArr = (f) => { const v = readJson(f, []); return Array.isArray(v) ? v : [] }
const writeJson = (f, v) => { try { writeFileSync(f, JSON.stringify(v, null, 2)) } catch (e) { log(`写 ${path.basename(f)} 失败：${e.message}`) } }
const safeJson = (s) => { try { return typeof s === 'string' ? JSON.parse(s) : (s || {}) } catch { return {} } }

/* --------------------------------------------------------------- 工具实现 */

const APP_WHITELIST = {
  notepad: 'notepad.exe', 记事本: 'notepad.exe',
  calc: 'calc.exe', calculator: 'calc.exe', 计算器: 'calc.exe',
  explorer: 'explorer.exe', 资源管理器: 'explorer.exe',
  vscode: 'code', code: 'code', 代码: 'code',
  edge: 'msedge.exe', 浏览器: 'msedge.exe',
  chrome: 'chrome.exe',
  word: 'winword.exe', excel: 'excel.exe', ppt: 'powerpnt.exe',
  wechat: 'WeChat.exe', weixin: 'C:\\Program Files\\Tencent\\Weixin\\Weixin.exe', 微信: 'C:\\Program Files\\Tencent\\Weixin\\Weixin.exe',
  qq: 'QQ.exe',
  spotify: 'Spotify.exe',
  settings: 'ms-settings:', 设置: 'ms-settings:',
  taskmgr: 'taskmgr.exe', 任务管理器: 'taskmgr.exe',
}

function run(cmd, args, timeout = 8000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout, windowsHide: true }, (err, stdout, stderr) => {
      resolve({ ok: !err, out: String(stdout || '').trim(), err: String(stderr || err?.message || '').trim() })
    })
  })
}

/** 调 tools\win.ps1（音量/媒体/截屏）；脚本必须是 UTF-8 with BOM，否则 Windows PowerShell 会按 GBK 解析失败 */
async function win(args) {
  const script = path.join(ROOT, 'tools', 'win.ps1')
  if (!existsSync(script)) return { ok: false, data: null, err: 'tools\\win.ps1 不存在' }
  const [action, value, extra, title] = args
  const argv = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-Action', action]
  if (action === 'type') {
    argv.push('-Text', String(value ?? ''))
    if (extra) argv.push('-Enter')
  } else if (action === 'screenshot') {
    if (value) argv.push('-Text', String(value))
    if (extra) argv.push('-Path', String(extra))
    if (title) argv.push('-Title', String(title))
  } else if (action === 'focus') {
    argv.push('-Title', String(value ?? ''))
  } else if (action === 'saveas') {
    argv.push('-Text', String(value ?? ''))
    if (title) argv.push('-Title', String(title))
  } else if (action === 'keys') {
    argv.push('-Keys', String(value ?? ''))          // 组合键走 -Keys，绝不能进 -Value（那是 int）
    if (title) argv.push('-Title', String(title))
  } else {
    if (value !== undefined && value !== '') argv.push('-Value', String(value))
    if (extra) argv.push('-Path', String(extra))
    if (title) argv.push('-Title', String(title))
  }
  const r = await run('powershell', argv, 20000)
  if (!r.ok) return { ok: false, data: null, err: r.err }
  try { return { ok: true, data: JSON.parse(r.out), err: '' } } catch { return { ok: true, data: r.out, err: '' } }
}

/** 向量：Ollama bge-m3（本地已有），失败返回 null 让调用方退回字面匹配 */
async function embed(text) {
  try {
    const res = await fetch(`${cfg.ollamaUrl}/api/embed`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: cfg.embedModel, input: String(text).slice(0, 2000) }),
      signal: AbortSignal.timeout(15000),
    })
    const data = await res.json()
    const v = data?.embeddings?.[0]
    return Array.isArray(v) && v.length ? v : null
  } catch { return null }
}

function cosine(a, b) {
  let dot = 0, na = 0, nb = 0
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i] }
  return na && nb ? dot / Math.sqrt(na * nb) : 0
}

/** 联网搜索：先 DuckDuckGo HTML，再退 cn.bing.com；只做正则提取，不引依赖 */
async function webSearch(query) {
  const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36'
  const strip = (s) => String(s).replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim()

  const tryDdg = async () => {
    const res = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}&kl=cn-zh`, {
      headers: { 'user-agent': UA, 'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8' },
      signal: AbortSignal.timeout(8000),
    })
    if (!res.ok) throw new Error(`ddg ${res.status}`)
    const html = await res.text()
    const out = []
    const re = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g
    let m
    while ((m = re.exec(html)) && out.length < 5) {
      let url = m[1]
      const u = url.match(/uddg=([^&]+)/)
      if (u) url = decodeURIComponent(u[1])
      out.push({ title: strip(m[2]).slice(0, 100), url, snippet: strip(m[3]).slice(0, 220) })
    }
    return out
  }

  const tryBing = async () => {
    const res = await fetch(`https://cn.bing.com/search?q=${encodeURIComponent(query)}&setlang=zh-CN`, {
      headers: { 'user-agent': UA, 'accept-language': 'zh-CN,zh;q=0.9' },
      signal: AbortSignal.timeout(8000),
    })
    if (!res.ok) throw new Error(`bing ${res.status}`)
    const html = await res.text()
    const out = []
    const re = /<li class="b_algo"[\s\S]*?<h2[^>]*>\s*<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<p[^>]*>([\s\S]*?)<\/p>/g
    let m
    while ((m = re.exec(html)) && out.length < 5) {
      out.push({ title: strip(m[2]).slice(0, 100), url: m[1], snippet: strip(m[3]).slice(0, 220) })
    }
    return out
  }

  for (const fn of [tryBing, tryDdg]) {
    try {
      const r = await fn()
      if (r.length) { log(`web_search(${query}) → ${r.length} 条 via ${fn.name}`); return r }
    } catch (e) { log(`web_search 走 ${fn.name} 失败：${e.message}`) }
  }
  return []
}

const TOOLS = [
  { type: 'function', function: {
    name: 'open_app',
    description: '打开本机应用（记事本、计算器、资源管理器、VS Code、Edge、Word/Excel/PPT、微信、QQ、Spotify、设置、任务管理器）',
    parameters: { type: 'object', properties: { app: { type: 'string', description: '应用名，如 记事本 / vscode / edge' } }, required: ['app'] },
  } },
  { type: 'function', function: {
    name: 'open_url',
    description: '用默认浏览器打开一个网页',
    parameters: { type: 'object', properties: { url: { type: 'string', description: 'http/https 网址' } }, required: ['url'] },
  } },
  { type: 'function', function: {
    name: 'open_path',
    description: '在资源管理器里打开一个本机已存在的文件或文件夹',
    parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  } },
  { type: 'function', function: {
    name: 'system_info',
    description: '查询当前时间、日期、电量、内存、系统版本',
    parameters: { type: 'object', properties: {} },
  } },
  { type: 'function', function: {
    name: 'add_note',
    description: '往笔记文件里追加一条笔记（自动带时间戳）',
    parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
  } },
  { type: 'function', function: {
    name: 'list_notes',
    description: '读最近的笔记',
    parameters: { type: 'object', properties: { limit: { type: 'number' } } },
  } },
  { type: 'function', function: {
    name: 'remind_me',
    description: 'N 分钟后提醒我某件事（桌宠会自己开口说）',
    parameters: { type: 'object', properties: { minutes: { type: 'number' }, text: { type: 'string' } }, required: ['minutes', 'text'] },
  } },
  { type: 'function', function: {
    name: 'remember',
    description: '记住用户的长期信息（偏好、习惯、重要事实）',
    parameters: { type: 'object', properties: { fact: { type: 'string' } }, required: ['fact'] },
  } },
  { type: 'function', function: {
    name: 'recall',
    description: '检索以前记住的事（用户问"你还记得…"时用）',
    parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
  } },
  { type: 'function', function: {
    name: 'search_files',
    description: '在桌面/文档/下载里按文件名关键字找文件（最多 12 条）',
    parameters: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
  } },
  { type: 'function', function: {
    name: 'web_search',
    description: '联网搜索（当前信息、新闻、天气、价格、文档），返回若干条标题+摘要+链接',
    parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
  } },
  { type: 'function', function: {
    name: 'volume',
    description: '控制音量：action=up/down（步数用 value，默认 5）、set（value=0..100）、get、mute',
    parameters: {
      type: 'object',
      properties: { action: { type: 'string', enum: ['up', 'down', 'set', 'get', 'mute'] }, value: { type: 'number' } },
      required: ['action'],
    },
  } },
  { type: 'function', function: {
    name: 'media',
    description: '控制正在播放的媒体：play（播放/暂停）、next（下一首）、prev（上一首）',
    parameters: { type: 'object', properties: { action: { type: 'string', enum: ['play', 'next', 'prev'] } }, required: ['action'] },
  } },
  { type: 'function', function: {
    name: 'screenshot',
    description: '截一张全屏图并保存到本地（返回文件路径）',
    parameters: { type: 'object', properties: {} },
  } },
  { type: 'function', function: {
    name: 'weather',
    description: '查某地天气（免费 wttr.in，无需 key）',
    parameters: { type: 'object', properties: { city: { type: 'string', description: '城市名，如 西安；可留空用自动定位' } } },
  } },
  { type: 'function', function: {
    name: 'translate',
    description: '中英互译（自动判断方向）',
    parameters: {
      type: 'object',
      properties: { text: { type: 'string' }, to: { type: 'string', enum: ['zh', 'en'] } },
      required: ['text'],
    },
  } },
  { type: 'function', function: {
    name: 'kill_app',
    description: '结束一个进程（白名单内的应用，如 notepad / code / msedge / WeChat）',
    parameters: { type: 'object', properties: { app: { type: 'string' } }, required: ['app'] },
  } },
  { type: 'function', function: {
    name: 'lock_screen',
    description: '锁屏（用户说「锁屏」「离开一下」时用）',
    parameters: { type: 'object', properties: {} },
  } },
  { type: 'function', function: {
    name: 'play_music',
    description: '用系统默认播放器打开一个本地音频/视频文件（路径必须存在）',
    parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  } },
  { type: 'function', function: {
    name: 'type_text',
    description: '往当前焦点窗口打字（支持中文；先 open_app 再 type_text 就能在记事本里写东西）',
    parameters: {
      type: 'object',
      properties: { text: { type: 'string' }, enter: { type: 'boolean', description: '打完是否按回车' } },
      required: ['text'],
    },
  } },
  { type: 'function', function: {
    name: 'schedule',
    description: '设置**重复**提醒（每 N 分钟一次），例如「每 30 分钟提醒我看一眼论文」',
    parameters: {
      type: 'object',
      properties: {
        minutes: { type: 'number', description: '间隔分钟数' },
        text: { type: 'string' },
        times: { type: 'number', description: '总共提醒几次；0 或省略 = 一直重复' },
      },
      required: ['minutes', 'text'],
    },
  } },
  { type: 'function', function: {
    name: 'look_at_screen',
    description: '截图并让视觉模型看看屏幕上有什么（能读出屏幕上的文字、界面内容）',
    parameters: { type: 'object', properties: { question: { type: 'string', description: '想问什么，可不填' }, window: { type: 'string', description: '只看某个窗口（标题关键字）；不填＝全屏' } } },
  } },
  { type: 'function', function: {
    name: 'write_file',
    description: '新建或覆盖一个文本文件（整理资料/写报告/存清单用）。内容超 1MB 会拒绝',
    parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' }, append: { type: 'boolean' } }, required: ['path', 'content'] },
  } },
  { type: 'function', function: {
    name: 'run_python',
    description: '跑一段 Python 代码并返回输出（最多 60 秒）。适合解析 pcap、处理表格、批量整理文件',
    parameters: { type: 'object', properties: { code: { type: 'string' }, timeout: { type: 'number' } }, required: ['code'] },
  } },
  { type: 'function', function: {
    name: 'pcap_summary',
    description: '用 tshark 分析一个 .pcap/.pcapng 文件，返回协议分布、会话 TOP、HTTP 请求等摘要',
    parameters: { type: 'object', properties: { path: { type: 'string' }, top: { type: 'number' } }, required: ['path'] },
  } },
  { type: 'function', function: {
    name: 'read_file',
    description: '直接读一个文本文件的内容（比截图视觉快得多、准得多）。适合 txt/md/json/js/log/csv/代码配置等',
    parameters: { type: 'object', properties: { path: { type: 'string' }, max: { type: 'number', description: '最多读多少字，默认 4000' } }, required: ['path'] },
  } },
  { type: 'function', function: {
    name: 'save_as',
    description: '把当前编辑的内容另存为到指定路径（自动 Ctrl+S、粘贴路径、回车）；可给 window 先激活窗口',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: '完整保存路径，如 D:\\\\tmp\\\\note.txt' }, window: { type: 'string' } },
      required: ['path'],
    },
  } },
  { type: 'function', function: {
    name: 'send_wechat',
    description: '给微信联系人发消息（自动搜索联系人→进聊天→输入→回车发送）',
    parameters: {
      type: 'object',
      properties: { contact: { type: 'string', description: '联系人昵称/备注' }, text: { type: 'string' } },
      required: ['contact', 'text'],
    },
  } },
  { type: 'function', function: {
    name: 'send_wechat_here',
    description: '往当前已打开的微信聊天窗口发消息（用户先自己点开聊天）；只负责点输入框、打字、回车',
    parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
  } },
  { type: 'function', function: {
    name: 'focus_window',
    description: '把某个窗口切到最前面（标题关键字，支持中文别名：记事本/微信/浏览器/代码）',
    parameters: { type: 'object', properties: { title: { type: 'string' } }, required: ['title'] },
  } },
  { type: 'function', function: {
    name: 'press_key',
    description: '发组合键，如 ctrl+s 保存、ctrl+a 全选、ctrl+z 撤销、alt+f4 关闭、enter、tab、esc、f5、ctrl+shift+s',
    parameters: { type: 'object', properties: { keys: { type: 'string', description: '组合键，用 + 连接，如 ctrl+s' }, window: { type: 'string', description: '窗口标题关键字，如 记事本；不填发给当前焦点' } }, required: ['keys'] },
  } },
  { type: 'function', function: {
    name: 'update_task',
    description: '修改重复提醒：改间隔(minutes)、暂停(pause=true)、恢复(pause=false)、改内容(text)',
    parameters: {
      type: 'object',
      properties: { id: { type: 'number' }, match: { type: 'string' }, minutes: { type: 'number' }, pause: { type: 'boolean' }, text: { type: 'string' } },
    },
  } },
  { type: 'function', function: {
    name: 'list_tasks',
    description: '列出当前的重复提醒/待办（含 id、间隔、剩余次数、下次时间）',
    parameters: { type: 'object', properties: {} },
  } },
  { type: 'function', function: {
    name: 'cancel_task',
    description: '取消重复提醒：给 id 取消一个；给 text 关键字取消匹配的；all=true 全部取消',
    parameters: {
      type: 'object',
      properties: { id: { type: 'number' }, text: { type: 'string' }, all: { type: 'boolean' } },
    },
  } },
]

async function systemInfo() {
  let battery = '未知'
  try {
    const r = execFileSync('powershell', ['-NoProfile', '-Command', '(Get-CimInstance Win32_Battery).EstimatedChargeRemaining'], { timeout: 4000, encoding: 'utf8', windowsHide: true })
    battery = (r || '').trim() ? `${(r || '').trim()}%` : '未知'
  } catch { /* 没电池 */ }
  return {
    时间: new Date().toLocaleString('zh-CN', { hour12: false }),
    电量: battery,
    内存: `${(os.freemem() / 2 ** 30).toFixed(1)} / ${(os.totalmem() / 2 ** 30).toFixed(1)} GB 可用`,
    CPU: (os.cpus()[0]?.model || '').trim(),
    系统: `${os.type()} ${os.release()}`,
  }
}

/** 中文也能用的粗粒度分词：字 + 字二元组 + 英文词 */
function tokenize(s) {
  const clean = String(s).toLowerCase().replace(/[^\p{Script=Han}\w]+/gu, ' ').trim()
  const out = new Set()
  for (const w of clean.split(/\s+/)) if (w) out.add(w)
  const dense = clean.replace(/\s/g, '')
  for (const ch of dense) out.add(ch)
  for (let i = 0; i + 1 < dense.length; i++) out.add(dense.slice(i, i + 2))
  return out
}

async function runTool(name, args) {
  try {
    switch (name) {
      case 'open_app': {
        const key = String(args.app || '').trim().toLowerCase()
        const name2 = Object.keys(APP_WHITELIST).find((k) => k.toLowerCase() === key)
        const target = name2 ? APP_WHITELIST[name2] : null
        if (!target) return { ok: false, summary: `不认识这个应用：${args.app}`, data: `可用：${Object.keys(APP_WHITELIST).join('、')}` }
        const exe0 = target.split(/[\\\\/]/).pop()
        const exe = exe0.includes('.') ? exe0 : exe0 + '.exe'
        const CAND = { 'calc.exe': ['calc.exe', 'CalculatorApp.exe'], 'Weixin.exe': ['Weixin.exe', 'WeChat.exe'], 'WeChat.exe': ['Weixin.exe', 'WeChat.exe'], 'code.exe': ['Code.exe'] }
        const cands = CAND[exe] || [exe]
        const alive = async () => {
          const r = await run('cmd', ['/c', 'tasklist', '/FI', 'IMAGENAME eq ' + exe], 8000)
          return r.out.toLowerCase().includes(exe.toLowerCase())
        }
        const TITLES = { wechat: '微信', weixin: '微信', '微信': '微信', notepad: 'Notepad', '记事本': 'Notepad', calc: 'Calculator', '计算器': 'Calculator', edge: 'Edge', '浏览器': 'Edge', code: 'Visual Studio Code', vscode: 'Visual Studio Code', explorer: 'Explorer', '资源管理器': 'Explorer' }
        const title = TITLES[key] || TITLES[name2] || ''
        if (await alive()) {
          const act = title ? await win(['focus', title]) : { data: {} }
          const hit = act.data?.focused || ''
          if (hit) lastFocusWin = hit
          return {
            ok: true,
            already: true,
            summary: hit ? `「${args.app}」本来就在跑，我把它切到前面了（${hit}）` : `「${args.app}」已经在跑（没找到窗口，可能最小化到托盘）`,
            data: { exe, already: true, focused: hit },
          }
        }
        await run('cmd', ['/c', 'start', '', target])
        for (let i = 0; i < 12; i++) {
          await new Promise((ok) => setTimeout(ok, 500))
          if (await alive()) {
            if (title) { const act = await win(['focus', title]); if (act.data?.focused) lastFocusWin = act.data.focused }
            return { ok: true, summary: `打开了${args.app}`, data: { exe, waited: (i + 1) * 500 } }
          }
        }
        return { ok: false, summary: `启动命令发出去了，但 ${exe} 一直没出现（可能被拦截或需要管理员）`, data: { exe } }
      }
      case 'open_url': {
        const u = String(args.url || '')
        if (!/^https?:\/\//i.test(u)) return { ok: false, summary: '只能打开 http/https 网址' }
        await run('cmd', ['/c', 'start', '', u])
        return { ok: true, summary: `打开了 ${u}` }
      }
      case 'open_path': {
        const p = String(args.path || '')
        if (!existsSync(p)) return { ok: false, summary: `路径不存在：${p}` }
        await run('cmd', ['/c', 'explorer', p])
        return { ok: true, summary: `打开了 ${p}` }
      }
      case 'system_info':
        return { ok: true, summary: '查了系统状态', data: await systemInfo() }
      case 'add_note': {
        const line = `- ${new Date().toLocaleString('zh-CN', { hour12: false })} ${String(args.text || '').trim()}\n`
        appendFileSync(NOTES, line)
        return { ok: true, summary: '记下了', data: line.trim() }
      }
      case 'list_notes': {
        if (!existsSync(NOTES)) return { ok: true, summary: '还没有笔记', data: [] }
        const n = Math.max(1, Math.min(30, Number(args.limit) || 10))
        const lines = readFileSync(NOTES, 'utf8').trim().split('\n').filter(Boolean).slice(-n)
        return { ok: true, summary: `最近 ${lines.length} 条笔记`, data: lines }
      }
      case 'remind_me': {
        const minutes = Math.max(0.2, Math.min(1440, Number(args.minutes) || 1))
        const list = readArr(REMINDERS)
        const item = { id: Date.now(), due: Date.now() + minutes * 60000, text: String(args.text || '提醒'), sent: false }
        list.push(item)
        writeJson(REMINDERS, list)
        return { ok: true, summary: `${minutes < 1 ? Math.round(minutes * 60) + ' 秒' : minutes + ' 分钟后'}提醒你`, data: item }
      }
      case 'remember': {
        const list = readArr(MEMORY)
        const text = String(args.fact || '').trim()
        const vec = await embed(text)            // bge-m3；失败就少存一个向量
        list.push({ t: Date.now(), text, vec })
        writeJson(MEMORY, list)
        return { ok: true, summary: '记住了', data: text }
      }
      case 'recall': {
        const list = readArr(MEMORY)
        if (!list.length) return { ok: true, summary: '还没记住任何事', data: [] }
        const qvec = await embed(String(args.query || ''))
        let scored
        if (qvec) {
          // 向量检索（能听懂同义改写）；老记忆没向量就补算一次
          for (const m of list) if (!m.vec) m.vec = await embed(m.text)
          writeJson(MEMORY, list)
          scored = list.map((m) => ({ text: m.text, s: m.vec ? cosine(qvec, m.vec) : 0 }))
            .filter((m) => m.s > 0.45).sort((a, b) => b.s - a.s).slice(0, 5)
        } else {
          const q = tokenize(args.query || '')
          scored = list.map((m) => { const t = tokenize(m.text); let s = 0; for (const w of q) if (t.has(w)) s++; return { text: m.text, s } })
            .filter((m) => m.s > 0).sort((a, b) => b.s - a.s).slice(0, 5)
        }
        return { ok: true, summary: scored.length ? `想起 ${scored.length} 条` : '没想起来相关的事', data: scored.map((m) => m.text) }
      }
      case 'web_search': {
        const q = String(args.query || '').trim()
        if (!q) return { ok: false, summary: '要给我搜索关键词' }
        const hits = await webSearch(q)
        return hits.length
          ? { ok: true, summary: `搜到 ${hits.length} 条`, data: hits }
          : { ok: false, summary: '没搜到（可能网络受限）', data: [] }
      }
      case 'volume': {
        const action = String(args.action || 'get').toLowerCase()
        const value = Number(args.value)
        if (action === 'set') {
          const v = Math.max(0, Math.min(100, Number.isFinite(value) ? value : 50))
          const r = await win(['vol-set', String(v)])
          return { ok: r.ok, summary: `音量设为 ${v}`, data: r.data }
        }
        if (action === 'up' || action === 'down') {
          const steps = Math.max(1, Math.min(30, Number.isFinite(value) ? value : 5))
          const r = await win(['vol-' + action, String(steps)])
          return { ok: r.ok, summary: action === 'up' ? '音量调大了一点' : '音量调小了一点', data: r.data }
        }
        if (action === 'mute') { const r = await win(['mute']); return { ok: r.ok, summary: r.data?.mute ? '静音了' : '取消静音了', data: r.data } }
        const r = await win(['vol-get'])
        return { ok: r.ok, summary: `当前音量 ${r.data?.volume ?? '?'}%${r.data?.mute ? '（已静音）' : ''}`, data: r.data }
      }
      case 'media': {
        const action = String(args.action || 'play').toLowerCase()
        const map = { play: 'media-play', next: 'media-next', prev: 'media-prev' }
        const act = map[action] || 'media-play'
        const r = await win([act])
        const cn = { play: '播放/暂停', next: '下一首', prev: '上一首' }[action] || '播放/暂停'
        return { ok: r.ok, summary: `按了${cn}`, data: r.data }
      }
      case 'screenshot': {
        const file = path.join(DATA, 'screenshots', `shot-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.png`)
        const r = await win(['screenshot', '', file])
        return { ok: r.ok, summary: r.ok ? '截屏存好了' : '截屏失败', data: r.data }
      }
      case 'search_files': {
        const kw = String(args.name || '').trim()
        if (!kw) return { ok: false, summary: '要给我个文件名关键字' }
        const roots = ['Desktop', 'Documents', 'Downloads'].map((d) => path.join(os.homedir(), d)).filter(existsSync)
        const hits = []
        const walk = (dir, depth) => {
          if (hits.length >= 12 || depth > 2) return
          let entries = []
          try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
          for (const e of entries) {
            if (hits.length >= 12) break
            if (e.name.startsWith('.')) continue
            const full = path.join(dir, e.name)
            if (e.name.toLowerCase().includes(kw.toLowerCase())) hits.push(full)
            if (e.isDirectory()) walk(full, depth + 1)
          }
        }
        for (const r of roots) walk(r, 0)
        return { ok: true, summary: hits.length ? `找到 ${hits.length} 个` : '没找到', data: hits }
      }
      case 'weather': {
        const city = String(args.city || '').trim()
        const u = city ? `https://wttr.in/${encodeURIComponent(city)}?format=j1&lang=zh` : 'https://wttr.in/?format=j1&lang=zh'
        const res = await fetch(u, { headers: { 'user-agent': 'curl/8' }, signal: AbortSignal.timeout(15000) })
        if (!res.ok) return { ok: false, summary: `天气服务 HTTP ${res.status}` }
        const j = await res.json()
        const cur = j.current_condition?.[0] || {}
        const near = j.nearest_area?.[0] || {}
        const today = j.weather?.[0] || {}
        const data = {
          地点: near.areaName?.[0]?.value || city || '自动定位',
          现在: `${cur.temp_C}°C ${cur.lang_zh?.[0]?.value || cur.weatherDesc?.[0]?.value || ''}`,
          体感: `${cur.FeelsLikeC}°C`,
          湿度: `${cur.humidity}%`,
          今日: `最高 ${today.maxtempC}°C / 最低 ${today.mintempC}°C`,
        }
        return { ok: true, summary: `${data.地点} ${data.现在}，${data.今日}`, data }
      }
      case 'translate': {
        const text = String(args.text || '').trim()
        if (!text) return { ok: false, summary: '要给我要翻译的内容' }
        const auto = /[\u4e00-\u9fa5]/.test(text)
        const to = String(args.to || (auto ? 'en' : 'zh'))
        const from = auto ? 'zh' : 'en'
        const u = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(text.slice(0, 400))}&langpair=${from}|${to}`
        const res = await fetch(u, { signal: AbortSignal.timeout(15000) })
        if (!res.ok) return { ok: false, summary: `翻译服务 HTTP ${res.status}` }
        const j = await res.json()
        const out = j?.responseData?.translatedText || ''
        if (!out) return { ok: false, summary: '没翻出来（可能超额度）' }
        return { ok: true, summary: `${from}→${to}：${out.slice(0, 60)}`, data: { from, to, text: out } }
      }
      case 'kill_app': {
        if (!allowDanger) { pendingConfirm = { name: 'kill_app', label: '关掉 ' + args.app, args }; return { ok: false, summary: '结束进程需要用户点确认，先用一句话问他要不要关' } }
        const key = String(args.app || '').trim().toLowerCase()
        const target = APP_WHITELIST[key] || Object.keys(APP_WHITELIST).find((k) => k.toLowerCase() === key && APP_WHITELIST[k])
        const resolved = target ? APP_WHITELIST[Object.keys(APP_WHITELIST).find((k) => k.toLowerCase() === key)] : null
        const raw = resolved || target
        if (!raw) return { ok: false, summary: '不认识这个应用：' + args.app }
        if (String(raw).startsWith('ms-settings:')) return { ok: false, summary: '这个没有进程可结束' }
        const base = String(raw).split(/[\\/]/).pop()
        const exe = base.includes('.') ? base : base + '.exe'
        if (!/^(notepad|calc|explorer|code|msedge|chrome|winword|excel|powerpnt|WeChat|Weixin|QQ|Spotify|taskmgr)\.exe$/i.test(exe)) {
          return { ok: false, summary: '为安全起见不结束 ' + exe + '（不在可结束白名单）' }
        }
        const CAND = { 'calc.exe': ['CalculatorApp.exe', 'calc.exe'], 'WeChat.exe': ['Weixin.exe', 'WeChat.exe'], 'Weixin.exe': ['Weixin.exe', 'WeChat.exe'] }
        const cands = CAND[exe] || [exe]
        const count = async (c) => {
          const o = await run('cmd', ['/c', 'tasklist', '/FI', 'IMAGENAME eq ' + c], 9000)
          return o.out.split(String.fromCharCode(10)).filter((l) => l.toLowerCase().includes(c.toLowerCase())).length
        }
        let victim = ''
        for (const c of cands) { if ((await count(c)) > 0) { victim = c; break } }
        if (!victim) return { ok: false, summary: '没找到在跑的 ' + cands.join(' / ') + '（它可能没开）' }
        const before = await count(victim)
        const r = await run('taskkill', ['/F', '/IM', victim], 9000)
        await new Promise((ok) => setTimeout(ok, 900))
        const after = await count(victim)
        const gone = before - after
        return {
          ok: gone > 0,
          summary: gone > 0
            ? '关掉了 ' + victim + '（' + before + ' → ' + after + '）'
            : '没能关掉 ' + victim + '（' + before + ' → ' + after + '）：' + String(r.err || r.out || '').slice(0, 80),
          data: { victim, before, after },
        }
      }
      case 'lock_screen': {
        if (!allowDanger) { pendingConfirm = { name: 'lock_screen', label: '锁屏', args }; return { ok: false, summary: '锁屏需要用户点确认，先用一句话问他要不要锁' } }
        const r = await run('rundll32.exe', ['user32.dll,LockWorkStation'], 5000)
        return { ok: r.ok, summary: '锁屏了', data: r.err || '' }
      }
      case 'play_music': {
        const p = String(args.path || '').trim()
        if (!p || !existsSync(p)) return { ok: false, summary: `文件不存在：${p}` }
        await run('cmd', ['/c', 'start', '', p])
        return { ok: true, summary: `打开播放：${path.basename(p)}` }
      }
      case 'type_text': {
        const text = String(args.text || '')
        if (!text) return { ok: false, summary: '要给我要打的内容' }
        const r = await win(['type', text, args.enter ? '1' : '', String(args.window || '')])
        return { ok: r.ok, summary: r.ok ? `打了 ${text.length} 个字${args.enter ? '并回车' : ''}` : `打字失败：${r.err}`, data: r.data }
      }
      case 'schedule': {
        const minutes = Math.max(1, Math.min(720, Number(args.minutes) || 30))
        const times = Math.max(0, Math.min(999, Number(args.times) || 0))
        const list = readArr(TASKS)
        const item = {
          id: Date.now(), text: String(args.text || '提醒'), every: minutes * 60000,
          left: times, next: Date.now() + minutes * 60000, created: Date.now(),
        }
        list.push(item)
        writeJson(TASKS, list)
        return { ok: true, summary: `每 ${minutes} 分钟提醒你${times ? `（共 ${times} 次）` : '（一直重复）'}`, data: item }
      }
      case 'look_at_screen': {
        const shot = path.join(DATA, 'screenshots', `look-${Date.now()}.png`)
        const onlyWin = String(args.window || '').trim() || lastFocusWin   // 没指定就复用上次 focus 的窗口
        let r = onlyWin ? await win(['screenshot', '', shot, onlyWin]) : await win(['screenshot', '', shot])
        let cropNote = ''
        if (onlyWin && !existsSync(shot)) {
          r = await win(['screenshot', '', shot])          // 裁剪失败就退回全屏，别整体失败
          cropNote = '（窗口裁剪失败，看的全屏）'
        }
        if (!r.ok || !existsSync(shot)) return { ok: false, summary: '截图失败' }
        const b64 = readFileSync(shot).toString('base64')
        const q = (String(args.question || '用两三句话说说屏幕上有什么').trim() + '（只回答看到的内容，不要重复，不要罗列所有文字）').slice(0, 200)
        const res = await fetch(`${cfg.ollamaUrl}/api/chat`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            model: cfg.visionModel,
            stream: false,
            think: false,
            messages: [{ role: 'user', content: q, images: [b64] }],
            options: { temperature: 0.2, num_predict: 160, repeat_penalty: 1.15, repeat_last_n: 128, top_p: 0.9 },
          }),
          signal: AbortSignal.timeout(90000),
        })
        const j = await res.json().catch(() => ({}))
        if (!res.ok) return { ok: false, summary: `视觉模型不可用：${j?.error || res.status}（需要 ollama 的 ${cfg.visionModel}）` }
        const seen = (j.message?.content || '').trim()
        return { ok: true, summary: '看了一眼屏幕' + cropNote + (onlyWin && !cropNote ? ('（只看「' + onlyWin + '」）') : ''), data: { 看到: seen.slice(0, 600), 截图: shot, 窗口: onlyWin || '全屏' } }
      }
      case 'write_file': {
        const p = String(args.path || '').trim()
        const content = String(args.content ?? '')
        if (!p) return { ok: false, summary: '要给我文件路径' }
        if (content.length > 1024 * 1024) return { ok: false, summary: '内容太大（>1MB），分几次写吧' }
        const dir = path.dirname(p)
        try {
          if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
          if (args.append && existsSync(p)) appendFileSync(p, content, 'utf8')
          else writeFileSync(p, content, 'utf8')
          const size = statSync(p).size
          return { ok: true, summary: (args.append ? '追加写入 ' : '写入 ') + path.basename(p) + '（' + size + ' 字节）', data: { path: p } }
        } catch (e) { return { ok: false, summary: '写不了：' + e.message } }
      }
      case 'run_python': {
        const code = String(args.code || '')
        if (!code.trim()) return { ok: false, summary: '要给我 Python 代码' }
        const secs = Math.max(5, Math.min(60, Number(args.timeout) || 30))
        const tmp = path.join(DATA, 'tmp', 'run-' + Date.now() + '.py')
        mkdirSync(path.dirname(tmp), { recursive: true })
        writeFileSync(tmp, code, 'utf8')
        const py = process.env.PYTHON || 'python'
        const r = await run(py, [tmp], secs * 1000)
        const out = (r.out || '').slice(0, 8000)
        const err = (r.err || '').slice(0, 4000)
        return {
          ok: r.ok,
          summary: r.ok ? ('Python 跑完了' + (out ? '' : '（没有输出）')) : ('Python 出错：' + (err.split(String.fromCharCode(10))[0] || '').slice(0, 80)),
          data: { stdout: out, stderr: err },
        }
      }
      case 'pcap_summary': {
        const p = String(args.path || '').trim()
        if (!p || !existsSync(p)) return { ok: false, summary: '找不到 pcap 文件：' + p }
        const top = Math.max(3, Math.min(20, Number(args.top) || 8))
        const tshark = ['D:\\\\02_DevTools\\\\Wireshark\\\\tshark.exe', 'tshark.exe'].find((x) => x === 'tshark.exe' || existsSync(x))
        const a1 = await run(tshark, ['-r', p, '-q', '-z', 'io,phs'], 60000)
        const a2 = await run(tshark, ['-r', p, '-q', '-z', 'conv,tcp'], 60000)
        const a3 = await run(tshark, ['-r', p, '-Y', 'http.request', '-T', 'fields', '-e', 'http.host', '-e', 'http.request.uri'], 60000)
        const proto = (a1.out || '').split(String.fromCharCode(10)).slice(0, 40).join(String.fromCharCode(10))
        const conv = (a2.out || '').split(String.fromCharCode(10)).filter((l) => l.includes('->')).slice(0, top).join(String.fromCharCode(10))
        const http = (a3.out || '').split(String.fromCharCode(10)).filter(Boolean).slice(0, top * 2).join(String.fromCharCode(10))
        return {
          ok: a1.ok,
          summary: '分析了 ' + path.basename(p) + '（协议分布 + TOP 会话 + HTTP 请求）',
          data: { 协议: proto, 会话TOP: conv, HTTP: http, err: (a1.err || '').slice(0, 300) },
        }
      }
      case 'read_file': {
        const p = String(args.path || '').trim().replace(/^"|"$/g, '')
        if (!p) return { ok: false, summary: '要给我文件路径' }
        if (!existsSync(p)) return { ok: false, summary: '文件不存在：' + p }
        const st = statSync(p)
        if (st.isDirectory()) return { ok: false, summary: '这是文件夹，不是文件：' + p }
        if (st.size > 2 * 1024 * 1024) return { ok: false, summary: '文件太大（' + Math.round(st.size / 1024) + ' KB），只支持 2 MB 以内' }
        const ext = path.extname(p).toLowerCase()
        const OK = ['.txt', '.md', '.json', '.js', '.mjs', '.cjs', '.ts', '.html', '.css', '.log', '.csv', '.py', '.ps1', '.bat', '.cmd', '.yml', '.yaml', '.toml', '.ini', '.xml', '.sql', '.sh', '.gitignore', '.env']
        if (!OK.includes(ext) && ext !== '') return { ok: false, summary: '这个类型（' + ext + '）我不直接读，怕是二进制。截图看它吧' }
        const limit = Math.max(200, Math.min(20000, Number(args.max) || 4000))
        let text = ''
        try { text = readFileSync(p, 'utf8') } catch (e) { return { ok: false, summary: '读不了（可能不是 UTF-8）：' + e.message } }
        const total = text.length
        const cut = text.slice(0, limit)
        const lines2 = text.split(String.fromCharCode(10)).length
        return {
          ok: true,
          summary: '读了 ' + path.basename(p) + '（' + lines2 + ' 行' + (total > limit ? '，只给了前 ' + limit + ' 字' : '') + '）',
          data: { path: p, lines: lines2, total, text: cut },
        }
      }
      case 'save_as': {
        const target = String(args.path || '').trim()
        if (!target) return { ok: false, summary: '要给我保存路径' }
        const dir = path.dirname(target)
        if (!existsSync(dir)) return { ok: false, summary: `目录不存在：${dir}` }
        if (existsSync(target)) return { ok: false, summary: `文件已存在，我不覆盖：${target}（换个文件名或先删掉）` }
        const r = await win(['saveas', target, '', String(args.window || '')])
        const saved = existsSync(target)
        const size = saved ? statSync(target).size : 0
        return {
          ok: saved,
          summary: saved ? `已保存到 ${target}（${size} 字节）` : `保存对话框没走完（${r.data?.path || target} 不存在）`,
          data: r.data,
        }
      }
      // 第一阶段：切换聊天 + 把内容打进输入框（不发），等用户看着确认
      // ⚠️ 已停用：Ctrl+F 搜索在微信 4.x 里不可靠，Enter 可能没进搜索框，
      // 结果把内容打进了「当前打开的那个群」——发生过两次真实事故，禁止再用。
      case 'send_wechat': {
        return {
          ok: false,
          summary: '自动搜索发送已停用（会把消息打进当前打开的群，出过事故）。请让用户手动点开目标聊天，再用 send_wechat_here 发送。',
        }
      }
      case 'send_wechat_here': {
        const msg = String(args.text || '').trim()
        if (!msg) return { ok: false, summary: '要给我消息内容' }
        const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms))
        if (!allowDanger) {
          // 第一阶段：切到微信 + 点输入框 + 把字打进去（用户看得见），然后等确认
          let f = await win(['focus', '微信'])
          if (!(f.data?.focused)) {
            await run('cmd', ['/c', 'start', '', 'C:\\Program Files\\Tencent\\Weixin\\Weixin.exe'])
            await sleep(2500)
            f = await win(['focus', '微信'])
          }
          if (!(f.data?.focused)) return { ok: false, summary: '微信窗口唤不出来，先手动点开微信和目标聊天' }
          await sleep(300)
          await win(['clickin', '0.85,0.955', '', '微信']); await sleep(400)
          await win(['type', msg, '', '微信']); await sleep(600)
          pendingSend = { text: msg, typed: true, here: true, at: Date.now() }
          pendingConfirm = { name: 'send_wechat_here', label: '发送：' + msg, args: pendingSend }
          return { ok: false, summary: '已经把「' + msg + '」打进当前聊天输入框了（还没发）。让用户看一眼输入框对不对，回「确定」我再按回车。' }
        }
        // 第二阶段：只按回车
        await win(['focus', '微信']); await sleep(300)
        await win(['clickin', '0.85,0.955', '', '微信']); await sleep(300)
        await win(['keys', 'enter', '', '微信']); await sleep(500)
        await win(['clickin', '0.972,0.967', '', '微信']); await sleep(300)
        pendingSend = null
        await win(['focus', '大肥鱼']); await new Promise((ok) => setTimeout(ok, 250))
        await win(['clickin', '0.5,0.94', '', '大肥鱼'])   // 真点一下，键盘焦点才会从微信转回来
        return { ok: true, summary: '已发送：' + msg }
      }
      case 'focus_window': {
        const ttl = String(args.title || '').trim()
        if (!ttl) return { ok: false, summary: '要给我窗口标题关键字' }
        const rf = await win(['focus', ttl])
        const hitf = rf.data?.focused || ''
        return { ok: !!hitf, summary: hitf ? ("已切到「" + hitf + "」") : ("没找到标题含「" + ttl + "」的窗口") }
      }
      case 'press_key': {
        const keys = String(args.keys || '').trim()
        if (!keys) return { ok: false, summary: '要给我组合键，比如 ctrl+s' }
        const r = await win(['keys', keys, '', String(args.window || '')])
        return { ok: r.ok, summary: r.ok ? `按了 ${keys}` : `按键失败：${r.err}`, data: r.data }
      }
      case 'update_task': {
        const tasks = readArr(TASKS)
        const id = Number(args.id)
        const kw = String(args.match || '').trim()
        const hit = tasks.filter((t) => (Number.isFinite(id) && t.id === id) || (kw && String(t.text).includes(kw)))
        if (!hit.length) return { ok: false, summary: '没找到匹配的提醒（先 list_tasks 看 id）' }
        const changes = []
        for (const t of hit) {
          if (args.minutes) { t.every = Math.max(1, Math.min(720, Number(args.minutes))) * 60000; t.next = Date.now() + t.every; changes.push(`间隔→${args.minutes}分钟`) }
          if (args.pause === true) { t.paused = true; changes.push('暂停') }
          if (args.pause === false) { t.paused = false; t.next = Date.now() + (t.every || 60000); changes.push('恢复') }
          if (args.text) { t.text = String(args.text); changes.push('改内容') }
        }
        writeJson(TASKS, tasks)
        return { ok: true, summary: `更新了 ${hit.length} 条：${[...new Set(changes)].join('、')}`, data: hit.map((t) => ({ id: t.id, text: t.text, paused: !!t.paused })) }
      }
      case 'list_tasks': {
        const tasks = readArr(TASKS)
        const reminders = readArr(REMINDERS).filter((r) => !r.sent)
        const fmt = (ms) => new Date(ms).toLocaleString('zh-CN', { hour12: false })
        const data = {
          重复提醒: tasks.map((t) => ({
            id: t.id, 内容: t.text,
            间隔: `${Math.round(t.every / 60000)} 分钟`,
            剩余次数: t.left === 0 ? '一直' : `${t.left} 次`,
            下次: fmt(t.next),
          })),
          一次性提醒: reminders.map((r) => ({ 内容: r.text, 到点: fmt(r.due) })),
        }
        const n = data.重复提醒.length + data.一次性提醒.length
        return { ok: true, summary: n ? `当前有 ${n} 条提醒` : '现在没有任何提醒', data }
      }
      case 'cancel_task': {
        const tasks = readArr(TASKS)
        if (!tasks.length) return { ok: true, summary: '没有重复提醒可取消', data: [] }
        if (args.all) { writeJson(TASKS, []); return { ok: true, summary: `取消了全部 ${tasks.length} 条重复提醒`, data: [] } }
        const byId = Number(args.id)
        const kw = String(args.text || '').trim()
        const keep = []
        const gone = []
        for (const t of tasks) {
          const hit = (Number.isFinite(byId) && t.id === byId) || (kw && String(t.text).includes(kw))
          if (hit) gone.push(t.text); else keep.push(t)
        }
        if (!gone.length) return { ok: false, summary: '没找到匹配的提醒（可以先用 list_tasks 看 id）' }
        writeJson(TASKS, keep)
        return { ok: true, summary: `取消了 ${gone.length} 条：${gone.join('、')}`, data: gone }
      }
      default:
        return { ok: false, summary: `没有这个工具：${name}` }
    }
  } catch (e) {
    return { ok: false, summary: `工具出错：${e.message}` }
  }
}

/* --------------------------------------------------------------- 两个后端 */

function readKey() {
  if (process.env.DEEPSEEK_API_KEY) return process.env.DEEPSEEK_API_KEY.trim()
  if (process.platform !== 'win32') return ''
  try {
    const out = execFileSync('reg', ['query', 'HKCU\\Environment', '/v', 'DEEPSEEK_API_KEY'], { encoding: 'utf8' })
    const m = out.match(/DEEPSEEK_API_KEY\s+REG_\w+\s+(\S+)/)
    return m ? m[1].trim() : ''
  } catch { return '' }
}
const KEY = readKey()
const providerName = () => (cfg.provider === 'auto' ? (KEY ? 'deepseek' : 'ollama') : cfg.provider)

async function callDeepSeek(messages, tools) {
  const body = { model: cfg.deepseekModel, messages, max_tokens: cfg.maxTokens, temperature: cfg.temperature, stream: false }
  if (tools?.length) { body.tools = tools; body.tool_choice = 'auto' }
  const res = await fetch(`${cfg.deepseekUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(cfg.timeoutMs),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw Object.assign(new Error(`DeepSeek: ${data?.error?.message || 'HTTP ' + res.status}`), { status: res.status })
  const msg = data.choices?.[0]?.message || {}
  return {
    text: (msg.content || '').trim(),
    toolCalls: (msg.tool_calls || []).map((t) => ({ id: t.id, name: t.function?.name, args: safeJson(t.function?.arguments) })),
    usage: data.usage ?? null,
  }
}

async function callOllama(messages, tools) {
  const body = { model: cfg.model, messages, stream: false, think: false, options: { temperature: cfg.temperature, num_predict: cfg.maxTokens } }
  if (tools?.length) body.tools = tools
  const res = await fetch(`${cfg.ollamaUrl}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(cfg.timeoutMs),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw Object.assign(new Error(`Ollama: ${typeof data?.error === 'string' ? data.error : 'HTTP ' + res.status}`), { status: res.status })
  const msg = data.message || {}
  return {
    text: (msg.content || '').trim(),
    toolCalls: (msg.tool_calls || []).map((t, i) => ({ id: `ollama-${Date.now()}-${i}`, name: t.function?.name, args: t.function?.arguments ?? {} })),
    usage: data.eval_count ? { completion_tokens: data.eval_count } : null,
  }
}

/* ------------------------------------------------------------------- TTS */

function ttsFile(text, voice) {
  const h = createHash('sha1').update(`${voice}|${cfg.tts.rate}|${cfg.tts.pitch}|${text}`).digest('hex').slice(0, 16)
  return path.join(TTS_DIR, `${h}.mp3`)
}

async function synthesize(text, voice) {
  const v = voice || cfg.tts.voice
  const file = ttsFile(text, v)
  if (existsSync(file) && statSync(file).size > 1000) return { file, cached: true }
  if (!existsSync(cfg.tts.exe)) throw new Error(`找不到 edge-tts：${cfg.tts.exe}`)
  await new Promise((resolve, reject) => {
    execFile(cfg.tts.exe, ['--voice', v, '--rate', cfg.tts.rate, '--pitch', cfg.tts.pitch, '--text', text, '--write-media', file],
      { timeout: 30000, windowsHide: true }, (err, _o, er) => (err ? reject(new Error(`edge-tts 失败：${er || err.message}`)) : resolve()))
  })
  if (!existsSync(file) || statSync(file).size < 500) throw new Error('edge-tts 没产出音频')
  return { file, cached: false }
}

/* ------------------------------------------------------------------ HTTP */

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'content-type',
  'access-control-expose-headers': 'x-tts-cached,x-tts-ms',
}
const json = (res, code, body) => { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', ...CORS }); res.end(JSON.stringify(body)) }
const readBody = (req, limit = 256 * 1024) => new Promise((resolve, reject) => {
  let size = 0
  const chunks = []
  req.on('data', (c) => { size += c.length; if (size > limit) { reject(Object.assign(new Error('请求体太大'), { status: 413 })); req.destroy(); return } chunks.push(c) })
  req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
  req.on('error', reject)
})

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost')
  if (req.method === 'OPTIONS') { res.writeHead(204, CORS); res.end(); return }

  try {
    if (req.method === 'GET' && url.pathname === '/health') {
      let models = []
      try {
        const r = await fetch(`${cfg.ollamaUrl}/api/tags`, { signal: AbortSignal.timeout(2500) })
        models = (await r.json()).models?.map((m) => m.name) ?? []
      } catch { /* Ollama 没开也无所谓 */ }
      return json(res, 200, {
        ok: true, provider: providerName(), configured: cfg.provider, hasKey: !!KEY,
        model: cfg.model, deepseekModel: cfg.deepseekModel, ollamaModels: models,
        agent: !!cfg.agent, tools: TOOLS.map((t) => t.function.name),
        tts: { engine: cfg.tts.engine, voice: cfg.tts.voice, exeOk: existsSync(cfg.tts.exe) },
      })
    }

    if (req.method === 'POST' && url.pathname === '/focuspet') {
      const r = await win(['focus', '大肥鱼'])
      await win(['clickin', '0.5,0.94', '', '大肥鱼'])   // 点一下抢键盘焦点
      return json(res, 200, { ok: !!r.data?.focused, focused: r.data?.focused || '' })
    }

    // ---- 历史对话（写文件，跨设备可取）----
    if (req.method === 'GET' && url.pathname === '/convs') {
      const dir = path.join(DATA, 'conversations')
      if (!existsSync(dir)) return json(res, 200, { list: [] })
      const files = readdirSync(dir).filter((f) => f.endsWith('.json')).sort().reverse().slice(0, 40)
      const list = []
      for (const f of files) {
        try {
          const c = JSON.parse(readFileSync(path.join(dir, f), 'utf8'))
          list.push({ id: c.id, time: c.time, title: c.title, count: (c.messages || []).length })
        } catch (e) { /* 坏文件跳过 */ }
      }
      return json(res, 200, { list })
    }

    if (req.method === 'GET' && url.pathname.startsWith('/convs/')) {
      const id = decodeURIComponent(url.pathname.slice('/convs/'.length)).replace(/[^\w-]/g, '')
      const f = path.join(DATA, 'conversations', id + '.json')
      if (!existsSync(f)) return json(res, 404, { error: '没有这段对话' })
      return json(res, 200, JSON.parse(readFileSync(f, 'utf8')))
    }

    if (req.method === 'POST' && url.pathname === '/convs') {
      const body = JSON.parse((await readBody(req)) || '{}')
      if (!Array.isArray(body.messages) || !body.messages.length) return json(res, 400, { error: 'messages 不能为空' })
      const dir = path.join(DATA, 'conversations')
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
      const id = String(body.id || ('c' + Date.now())).replace(/[^\w-]/g, '')
      const firstUser = body.messages.find((m) => m.role === 'user')?.content || '新对话'
      const item = { id, time: Date.now(), title: firstUser.slice(0, 24), messages: body.messages.slice(-60) }
      writeFileSync(path.join(dir, id + '.json'), JSON.stringify(item, null, 2), 'utf8')
      return json(res, 200, { ok: true, id, files: readdirSync(dir).length })
    }

    if (req.method === 'GET' && url.pathname === '/tasks') {
      const tasks = readArr(TASKS)
      const rem = readArr(REMINDERS).filter((r) => !r.sent)
      return json(res, 200, {
        tasks: tasks.map((t) => ({ id: t.id, text: t.text, every: t.every, left: t.left, next: t.next, paused: !!t.paused })),
        reminders: rem.map((r) => ({ text: r.text, due: r.due })),
      })
    }

    if (req.method === 'POST' && url.pathname === '/task') {
      const body = JSON.parse((await readBody(req)) || '{}')
      const tasks = readArr(TASKS)
      const id = Number(body.id)
      if (body.action === 'delete') {
        const keep = tasks.filter((t) => t.id !== id)
        writeJson(TASKS, keep)
        return json(res, 200, { ok: true, deleted: tasks.length - keep.length })
      }
      const t = tasks.find((x) => x.id === id)
      if (!t) return json(res, 404, { error: '没有这个任务' })
      if (body.action === 'pause') { t.paused = true }
      else if (body.action === 'resume') { t.paused = false; t.next = Date.now() + (t.every || 60000) }
      else if (body.action === 'every' && body.minutes) { t.every = Math.max(1, Math.min(720, Number(body.minutes))) * 60000; t.next = Date.now() + t.every }
      else return json(res, 400, { error: 'action 只能是 pause/resume/every/delete' })
      writeJson(TASKS, tasks)
      return json(res, 200, { ok: true, task: t })
    }

    if (req.method === 'GET' && url.pathname === '/tts') {
      const text = (url.searchParams.get('text') || '').slice(0, 400)
      if (!text) return json(res, 400, { error: 'text 不能为空' })
      const t0 = Date.now()
      const { file, cached } = await synthesize(text, url.searchParams.get('voice') || undefined)
      res.writeHead(200, {
        'content-type': 'audio/mpeg',
        'content-length': statSync(file).size,
        'cache-control': 'public, max-age=86400',
        'x-tts-cached': String(cached),
        'x-tts-ms': String(Date.now() - t0),
        ...CORS,
      })
      createReadStream(file).pipe(res)
      return
    }

    if (req.method === 'GET' && url.pathname === '/tts/info') {
      const t0 = Date.now()
      try {
        const { cached } = await synthesize('测试')
        return json(res, 200, { ok: true, engine: cfg.tts.engine, voice: cfg.tts.voice, ms: Date.now() - t0, cached })
      } catch (e) { return json(res, 200, { ok: false, engine: cfg.tts.engine, voice: cfg.tts.voice, error: e.message }) }
    }

    if (req.method === 'GET' && url.pathname === '/reminders') {
      const now = Date.now()
      const list = readArr(REMINDERS)
      const due = list.filter((r) => !r.sent && r.due <= now)
      if (due.length) { for (const r of list) if (due.includes(r)) r.sent = true; writeJson(REMINDERS, list) }

      // 重复任务（schedule）：到点就送一次，并推进下一次
      const tasks = readArr(TASKS)
      const hits = []
      let changed = false
      for (const task of tasks) {
        if (task.paused) continue
        if (task.left !== 0 && task.left <= 0) continue
        if (task.next > now) continue
        hits.push({ text: task.text, due: task.next })
        task.next = now + task.every
        if (task.left > 0) task.left -= 1
        changed = true
      }
      if (changed) writeJson(TASKS, tasks)

      return json(res, 200, { due: [...due.map((r) => ({ text: r.text, due: r.due })), ...hits] })
    }

    if (req.method === 'POST' && url.pathname === '/chat') {
      let body = {}
      try { body = JSON.parse((await readBody(req)) || '{}') } catch { return json(res, 400, { error: 'body 不是合法 JSON' }) }
      log('收到 /chat：origin=' + (req.headers.origin || '-') + ' stream=' + (url.searchParams.get('stream') || '0') + ' msgs=' + ((body.messages || []).length))
      const history = Array.isArray(body.messages) ? body.messages.slice(-10) : []
      if (!history.length) return json(res, 400, { error: 'messages 不能为空' })
      for (const m of history) {
        if (typeof m?.content !== 'string' || !['user', 'assistant', 'system'].includes(m?.role)) return json(res, 400, { error: 'messages 每项要有 role 和 content' })
      }

      const want = body.provider || providerName()
      const useTools = cfg.agent && body.tools !== false
      const started = Date.now()
      const LANG_RULE = cfg.lang === 'en' ? '语言：始终用英文（English）回答，即使我用中文提问。'
  : cfg.lang === 'zh' ? '语言：始终用简体中文回答，即使我用英文提问。'
  : '语言：跟随用户提问所使用的语言（中文问就中文答，英文问就英文答）。这条优先于上面任何「用中文」的默认说法。'
const sysParts = Array.isArray(cfg.systemPrompt) ? [...cfg.systemPrompt, LANG_RULE] : [cfg.systemPrompt, LANG_RULE]
const msgs = [{ role: 'system', content: sysParts.join(String.fromCharCode(10)) }, ...history.map((m) => ({ role: m.role, content: m.content }))]
      const lastUser = [...(body.messages || [])].reverse().find((m) => m.role === 'user')?.content || ''
      const short = String(lastUser).trim()
      const saysYes = short.length <= 8 && /(确定|确认|发吧|可以|好的|行|发|yes|ok)/i.test(short)
      if (pendingSend && saysYes) {
        log('用户文字确认，执行挂起的微信发送：' + pendingSend.contact)
        let rr
        try {
        if (pendingSend.typed) {
          await win(['focus', '微信']); await new Promise((ok) => setTimeout(ok, 250))
          await win(['clickin', '0.85,0.955', '', '微信'])
          await win(['keys', 'enter', '', '微信'])
          await win(['clickin', '0.972,0.967', '', '微信'])
          await win(['focus', '大肥鱼']); await new Promise((ok) => setTimeout(ok, 250))
        await win(['clickin', '0.5,0.94', '', '大肥鱼'])   // 真点一下，键盘焦点才会从微信转回来
          rr = { ok: true, summary: '已发送：' + pendingSend.text }
        } else {
          await win(['focus', '微信'])
          await win(['clickin', '0.85,0.955', '', '微信'])
          await win(['type', pendingSend.text, '', '微信'])
          await win(['keys', 'enter', '', '微信'])
          await win(['focus', '大肥鱼']); await new Promise((ok) => setTimeout(ok, 250))
        await win(['clickin', '0.5,0.94', '', '大肥鱼'])   // 真点一下，键盘焦点才会从微信转回来
          rr = { ok: true, summary: '已发送：' + pendingSend.text }
        }
        pendingSend = null
        } catch (err) { rr = { ok: false, summary: '发送时出错：' + err.message } }
        const confirmPayload = { reply: rr.summary, emotion: rr.ok ? 'smile' : 'sad', tools: [{ name: 'send_wechat', ok: rr.ok, summary: rr.summary }], provider: 'local', model: 'confirm', ms: 0 }
        if (url.searchParams.get('stream') === '1' || body.stream === true) {
          res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', connection: 'keep-alive' })
          res.write('data: ' + JSON.stringify({ type: 'start', provider: 'local' }) + '\n\n')
          res.write('data: ' + JSON.stringify({ type: 'final', ...confirmPayload }) + '\n\n')
          res.end()
          return
        }
        return json(res, 200, confirmPayload)
      }
      allowDanger = body.confirm === true
      pendingConfirm = null
      const used = []
      let final = ''
      let usage = null

      // SSE：一步步把「正在干什么」推给页面，气泡里能看到进度
      const streaming = url.searchParams.get('stream') === '1' || body.stream === true
      let sse = null
      if (streaming) {
        res.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
          ...CORS,
        })
        sse = (obj) => { try { res.write(`data: ${JSON.stringify(obj)}\n\n`) } catch { /* 页面关了 */ } }
        sse({ type: 'start', provider: want })
      }

      const call = async (tools) => {
        if (want === 'deepseek') {
          return await callDeepSeek(msgs, tools).catch(async (e) => {
            if (cfg.provider === 'auto') { log(`DeepSeek 失败（${e.message}），改走本地 Ollama`); return await callOllama(msgs, tools) }
            throw e
          })
        }
        return await callOllama(msgs, tools).catch(async (e) => {
          if (KEY) { log(`Ollama 失败（${e.message}），改走 DeepSeek`); return await callDeepSeek(msgs, tools) }
          throw e
        })
      }

      const rounds = useTools ? cfg.maxToolRounds : 0
      for (let round = 0; round <= rounds; round++) {
        const last = round === rounds
        const r = await call(last ? [] : TOOLS)
        usage = r.usage ?? usage
        if (r.toolCalls?.length && !last) {
          msgs.push({
            role: 'assistant', content: r.text || null,
            tool_calls: r.toolCalls.map((t) => ({ id: t.id, type: 'function', function: { name: t.name, arguments: JSON.stringify(t.args) } })),
          })
          for (const tc of r.toolCalls) {
            if (sse) sse({ type: 'step', name: tc.name, args: tc.args || {}, phase: 'run' })
            const out = await runTool(tc.name, tc.args || {})
            used.push({ name: tc.name, args: tc.args || {}, ok: out.ok, summary: out.summary })
            log(`工具 ${tc.name}(${JSON.stringify(tc.args)}) → ${out.ok ? 'ok' : '失败'} ${out.summary}`)
            if (sse) sse({ type: 'step', name: tc.name, ok: out.ok, summary: out.summary, phase: 'done' })
            msgs.push({ role: 'tool', tool_call_id: tc.id, name: tc.name, content: JSON.stringify({ summary: out.summary, data: out.data ?? null }).slice(0, 3000) })
          }
          continue
        }
        final = r.text || ''
        break
      }

      // 有些模型会把内部工具调用语法（DSML / <|...|> / <invoke>）当正文吐出来，先剥掉；
      // 剥完如果没剩什么，再不带工具问一次要一句人话。
      const leaked = (s) => /<[|｜]{0,3}\s*DSML|<\|[a-z_]+\|>|<invoke/i.test(s || '')
      if (leaked(final)) {
        log(`检测到工具语法泄漏，剥掉后重问一次：${String(final).slice(0, 60)}`)
        final = String(final).replace(/<[|｜]{0,3}\s*DSML[\s\S]*$/i, '').replace(/<\|[^|>]*\|>[\s\S]*$/i, '').trim()
        if (!final || leaked(final)) {
          msgs.push({ role: 'user', content: '（系统提示）上一轮你输出了工具调用语法文本，那不是给用户看的话。请直接用一句话回答，不要再输出任何尖括号语法。' })
          const again = await call([]).catch(() => null)
          const t2 = String(again?.text || '').trim()
          final = leaked(t2) ? '' : t2
        }
      }
      let emotion = 'neutral'
      final = final.replace(/<emotion:\s*(\w+)\s*>/gi, (_m, e) => { emotion = String(e).toLowerCase(); return '' }).trim()
      if (!['smile', 'shy', 'angry', 'sad', 'surprised', 'neutral'].includes(emotion)) emotion = 'neutral'

      const ms = Date.now() - started
      log(`${want} ${ms}ms ${final.length}字 工具${used.length}个 情绪${emotion}`)
      // 情绪标签/乱七八糟的尖括号残渣一律清掉（含 </emotion:smile> 这种闭合形式）
      final = String(final || '')
        .replace(/<\/?emotion[^>]*>/gi, '')
        .replace(/<\/?[a-z]+:[a-z0-9_-]+>/gi, '')
        .replace(/<\|[^|>]*\|>/g, '')
        .replace(/\s{2,}/g, ' ')
        .trim()

      const payload = { reply: final || '（它没说话）', emotion, tools: used, provider: want, model: want === 'deepseek' ? cfg.deepseekModel : cfg.model, usage, ms }
      if (pendingConfirm) payload.confirm = pendingConfirm
      if (sse) { sse({ type: 'final', ...payload }); res.end(); return }
      return json(res, 200, payload)
    }

    return json(res, 404, { error: '可用：GET /health、POST /chat、GET /tts、GET /tts/info、GET /reminders' })
  } catch (e) {
    const code = e?.status && e.status >= 400 && e.status < 600 ? e.status : 500
    log(`错误 ${code}: ${e.message}`)
    return json(res, code, { error: e.message })
  }
})

server.listen(cfg.port, '127.0.0.1', () => {
  log(`代理已启动 http://127.0.0.1:${cfg.port} provider=${providerName()}（配置 ${cfg.provider}）agent=${cfg.agent ? '开' : '关'}`)
  log(`  key：${KEY ? `已读到（${KEY.length} 字符）` : '没读到，只会用本地 Ollama'}`)
  log(`  模型 ${cfg.model} / ${cfg.deepseekModel}；工具 ${TOOLS.length} 个；TTS=${cfg.tts.engine} ${cfg.tts.voice}`)
  log(`  数据目录 ${DATA}`)
})

