// LivLiv 桌宠透明壳 —— 一个极小的 Electron 外壳：无边框 + 透明 + 永远置顶，
// 里面就是 player 的透明页面（默认 example/pet-chat.html）。
//
// 设计目标：**零常驻**。点快捷方式才起，退出就全没，开机不需要任何后台服务。
//   · 静态文件服务（8080）由本进程内置的 http 服务器提供，不再依赖 python
//   · 聊天代理（8787）在本进程里动态 import chat-proxy.mjs，同生共死
//   · 端口若已被别的进程占用（例如你手动起了 python），就沿用那个，不抢
//
//   npm start                 正常启动
//   npm run selftest          截一张图（selftest.png）然后退出，用于验证透明通道
//   --dragtest                模拟拖动三次，验证「拖动不改大小」
//
// 托盘菜单：显示/隐藏、点击穿透、重新加载、大小、开发者工具、退出
// 快捷键：Ctrl+Alt+Q 退出、Ctrl+Alt+H 隐藏/显示、Ctrl+Alt+P 穿透、Ctrl+Alt+R 重载、Ctrl+Alt+↑/↓ 缩放
'use strict'

const { app, BrowserWindow, Tray, Menu, ipcMain, screen, globalShortcut, nativeImage } = require('electron')
const fs = require('fs')
const path = require('path')
const http = require('node:http')
const net = require('node:net')
const { pathToFileURL } = require('node:url')

const ROOT = __dirname
const LOG_FILE = path.join(ROOT, 'pet-shell.log')
const log = (msg) => {
  const line = `${new Date().toISOString()} ${msg}`
  console.log(line)
  try { fs.appendFileSync(LOG_FILE, line + '\n') } catch { /* 日志写不进去也不影响运行 */ }
}

const DEFAULTS = {
  // 要显示什么：默认是「会说话」的聊天版（需要 chat-proxy）；想回到不说话的就换回 my-pet.html
  url: 'http://127.0.0.1:8080/example/pet-chat.html?char=p01',
  // 宠物大小 = 窗口大小（角色按窗口等比铺满）。托盘「大小」和 Ctrl+Alt+↑/↓ 都能改
  // 注意：这台机器 1 DIP ≈ 1.5 物理像素，320×440 DIP ≈ 屏幕上的 480×660 px
  width: 320,
  height: 440,
  marginRight: 60,      // 距屏幕右侧
  marginBottom: 0,      // 距任务栏上沿
  alwaysOnTop: true,
  clickThrough: false,  // 启动就穿透（只显示、不挡鼠标）
  position: null,       // [x, y] 记住上次位置后会被写回这里
  aspectRatio: 1.375,   // 高 / 宽（440/320）。改大小只按这个比例，不受窗口被拉伸影响
  // 内置静态服务器：把哪个目录挂到 8080（相对 PetShell 目录）
  serveDir: '../player',
  servePort: 8080,
  chatPort: 8787,
  // 启动时顺手拉起聊天代理（本进程内，不额外开进程）
  startChatProxy: true,
}

const cfgPath = path.join(ROOT, 'config.json')
let cfg = { ...DEFAULTS }
try {
  if (fs.existsSync(cfgPath)) cfg = { ...DEFAULTS, ...JSON.parse(fs.readFileSync(cfgPath, 'utf8')) }
} catch (e) { log(`config.json 读不了，用默认值: ${e.message}`) }

// 命令行临时覆盖（不改配置文件）：
//   electron . --size=220            临时用这个宽度，高度按原比例算
//   electron . --char=p02            临时换角色
const arg = (name) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : null
}
if (arg('size')) {
  const w = Math.max(120, Math.min(1600, Number(arg('size')) || 0))
  if (w) { cfg.height = Math.round(w * (cfg.height / cfg.width)); cfg.width = w; cfg.position = null }
}
if (arg('char')) cfg.url = cfg.url.replace(/([?&]char=)[\w-]+/, `$1${arg('char')}`)

// 比例兜底：老配置里可能存着被「拖动改大小」拉变形的宽高，这里修正回设计比例
const A = Number(cfg.aspectRatio)
cfg.aspectRatio = Number.isFinite(A) && A > 0.4 && A < 3 ? A : DEFAULTS.aspectRatio
cfg.height = Math.round(cfg.width * cfg.aspectRatio)


let win = null
let tray = null
let clickThrough = !!cfg.clickThrough
let retries = 0

/* ------------------------------------------------- 内置静态服务 / 聊天代理 */

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.webp': 'image/webp', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.wasm': 'application/wasm', '.txt': 'text/plain; charset=utf-8',
  '.livliv': 'application/octet-stream', '.zip': 'application/zip',
}

/** 端口上有没有人在听 */
const portTaken = (port) => new Promise((resolve) => {
  const s = net.connect({ port, host: '127.0.0.1' })
  s.setTimeout(700)
  s.once('connect', () => { s.destroy(); resolve(true) })
  s.once('timeout', () => { s.destroy(); resolve(false) })
  s.once('error', () => resolve(false))
})

let staticServer = null

/** 把 player 目录挂到 8080 —— 替代原先那个 python http.server，点快捷方式才起，退出即关 */
async function startStaticServer() {
  const port = Number(cfg.servePort) || 8080
  if (await portTaken(port)) { log(`静态服务：${port} 已被占用，沿用已有的（可能是手动起的服务器）`); return }
  const root = path.resolve(ROOT, cfg.serveDir || '../player')
  if (!fs.existsSync(root)) { log(`静态服务：目录不存在 ${root}，跳过`); return }
  staticServer = http.createServer((req, res) => {
    try {
      let file = path.normalize(path.join(root, decodeURIComponent(new URL(req.url, 'http://x').pathname)))
      const rel = path.relative(root, file)
      if (rel.startsWith('..') || path.isAbsolute(rel)) { res.writeHead(403).end('forbidden'); return }
      if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html')
      if (!fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404).end('not found'); return }
      res.writeHead(200, {
        'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
        'content-length': fs.statSync(file).size,
        'cache-control': 'no-cache',
      })
      fs.createReadStream(file).pipe(res)
    } catch (e) { res.writeHead(500).end(String(e.message)) }
  })
  staticServer.on('error', (e) => log(`静态服务启动失败：${e.message}`))
  staticServer.listen(port, '127.0.0.1', () => log(`静态服务：http://127.0.0.1:${port} → ${root}`))
}

/** 聊天代理：直接在本进程里 import，进程退出它一起没，不残留 node 子进程 */
async function startChatProxyInProcess() {
  if (!cfg.startChatProxy) return
  const port = Number(cfg.chatPort) || 8787
  if (await portTaken(port)) { log(`聊天代理：${port} 已被占用，沿用已有的`); return }
  try {
    await import(pathToFileURL(path.join(ROOT, 'chat-proxy.mjs')).href)
    log(`聊天代理：已在本进程内启动（${port}）`)
  } catch (e) { log(`聊天代理启动失败：${e.message}`) }
}

/* ------------------------------------------------------------------ 窗口 */

function createWindow() {
  const area = screen.getPrimaryDisplay().workArea
  const x = cfg.position?.[0] ?? area.x + area.width - cfg.width - cfg.marginRight
  const y = cfg.position?.[1] ?? area.y + area.height - cfg.height - cfg.marginBottom

  win = new BrowserWindow({
    x: Math.round(x), y: Math.round(y),
    width: cfg.width, height: cfg.height, useContentSize: true,
    transparent: true,            // ← 关键：窗口本身透明
    backgroundColor: '#00000000',
    frame: false, hasShadow: false,
    // ⚠️ 必须 false：透明无边框窗口若可调大小，鼠标在窗口边缘附近按下时 Windows 会当成
    //    「拖边框改大小」而不是「拖动窗口」，表现就是「一拖就变大」。大小只走托盘/热键/配置。
    resizable: false, movable: true,
    minimizable: false, maximizable: false, fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: !!cfg.alwaysOnTop,
    show: false,
    title: 'LivLiv 桌宠',
    webPreferences: {
      preload: path.join(ROOT, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,   // 被别的窗口盖住也别降帧
    },
  })

  // 'screen-saver' 这一级能压住全屏应用和任务栏
  if (cfg.alwaysOnTop) win.setAlwaysOnTop(true, 'screen-saver')
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  if (clickThrough) applyClickThrough(true)

  // 右键菜单：透明无边框窗口默认没有菜单，粘贴/复制都用不了
  win.webContents.on('context-menu', (_e, params) => {
    const items = []
    if (params.isEditable) {
      items.push({ role: 'cut', label: '剪切' }, { role: 'copy', label: '复制' }, { role: 'paste', label: '粘贴' })
      items.push({ type: 'separator' }, { role: 'selectAll', label: '全选' })
    } else if (params.selectionText) {
      items.push({ role: 'copy', label: '复制' })
    }
    if (!items.length) items.push({ role: 'copy', label: '复制' }, { role: 'selectAll', label: '全选' })
    Menu.buildFromTemplate(items).popup({ window: win })
  })
  win.once('ready-to-show', () => win.show())
  win.webContents.on('did-fail-load', (_e, code, desc, url, isMainFrame) => {
    if (!isMainFrame) return
    log(`页面加载失败 (${code} ${desc}) ${url}`)
    if (retries++ < 40) {
      // 常见原因：本地静态服务器还没起来（开机自启时顺序不确定）→ 3 秒后重试
      setTimeout(() => win && !win.isDestroyed() && load(), 3000)
    }
  })
  win.webContents.on('did-finish-load', () => { retries = 0; log('页面加载完成') })
  // 把页面里的 console 也记进日志（新版/旧版 Electron 的回调签名不一样，两种都兼容）
  win.webContents.on('console-message', (...args) => {
    const parts = args
      .map((a) => (a && typeof a === 'object' && typeof a.message === 'string') ? a.message : (typeof a === 'string' ? a : null))
      .filter(Boolean)
    if (parts.length) log(`[page] ${parts.join(' ')}`)
  })
  win.on('moved', persistPosition)
  // 万一哪天又被改成可调大小，至少把异常尺寸记下来
  win.on('resize', () => {
    if (!win || win.isDestroyed()) return
    const [w, h] = win.getContentSize()
    if (w !== cfg.width || h !== cfg.height) log(`注意：窗口尺寸被外部改变 ${w}×${h}（配置是 ${cfg.width}×${cfg.height}）`)
  })

  load()
}

function load() {
  win.loadURL(cfg.url + (cfg.url.includes("?") ? "&" : "?") + "v=" + Date.now()).catch((e) => log(`loadURL: ${e.message}`))
}

function saveConfig() {
  try { fs.writeFileSync(cfgPath, JSON.stringify({ ...cfg }, null, 2)) } catch { /* 只影响记住位置/大小 */ }
}

function persistPosition() {
  if (!win || win.isDestroyed()) return
  const [x, y] = win.getPosition()
  cfg.position = [x, y]
  saveConfig()
}

/* ---------------------------------------------------------------- 宠物大小 */

// 宠物多大 = 窗口多大（页面里的角色按容器等比铺满）。
// 比例固定用 cfg.aspectRatio，**不**从当前窗口反推 —— 否则窗口一旦被拉变形，缩放会沿着畸形比例一路错下去。
// 按比例缩放并按「底边中点」为锚点，缩小时不会跑到屏幕中间去。
function setPetSize(width, opts = {}) {
  if (!win || win.isDestroyed()) return
  const [ow, oh] = win.getContentSize()
  const w = Math.max(120, Math.min(1600, Math.round(width)))
  const h = Math.round(w * cfg.aspectRatio)
  const [x, y] = win.getPosition()
  const nx = Math.round(x + (ow - w) / 2)
  const ny = opts.keepBottom === false ? y : Math.round(y + oh - h)
  win.setContentSize(w, h)
  win.setPosition(nx, ny)
  cfg.width = w
  cfg.height = h
  cfg.position = [nx, ny]
  saveConfig()
  log(`宠物大小：${w}×${h}（原 ${ow}×${oh}）`)
  refreshTray()
}

/** 在当前宽度基础上按比例缩放，例如 0.9 / 1.1 */
function scalePet(factor) {
  if (!win || win.isDestroyed()) return
  setPetSize(win.getContentSize()[0] * factor)
}


/* -------------------------------------------------------------- 点击穿透 */

function applyClickThrough(on) {
  clickThrough = on
  if (!win || win.isDestroyed()) return
  // forward:true —— 穿透后鼠标移动仍会转发给页面，角色的眼睛还能跟着走
  win.setIgnoreMouseEvents(on, { forward: true })
  log(`点击穿透：${on ? '开' : '关'}`)
  refreshTray()
}

/* ------------------------------------------------------------------ 托盘 */

function refreshTray() {
  if (!tray) return
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'LivLiv 桌宠', enabled: false },
    { label: win && !win.isDestroyed() ? `当前：${win.getContentSize().join('×')}` : '当前：—', enabled: false },
    { type: 'separator' },
    { label: '大小', submenu: [
      { label: '很小 180×248', click: () => setPetSize(180) },
      { label: '小（默认）240×330', click: () => setPetSize(240) },
      { label: '中 320×440', click: () => setPetSize(320) },
      { label: '大 420×580', click: () => setPetSize(420) },
      { label: '特大 560×770', click: () => setPetSize(560) },
      { type: 'separator' },
      { label: '放大 10%（Ctrl+Alt+↑）', click: () => scalePet(1.1) },
      { label: '缩小 10%（Ctrl+Alt+↓）', click: () => scalePet(0.9) },
      { type: 'separator' },
      { label: '重置为默认 240×330', click: () => setPetSize(240) },
    ] },
    { label: win && win.isVisible() ? '隐藏（Ctrl+Alt+H）' : '显示（Ctrl+Alt+H）', click: () => toggleVisible() },
    { label: '点击穿透（Ctrl+Alt+P）', type: 'checkbox', checked: clickThrough, click: (item) => applyClickThrough(item.checked) },
    { label: '重新加载（Ctrl+Alt+R）', click: () => win.reload() },
    { label: '回到右下角', click: () => {
      const a = screen.getPrimaryDisplay().workArea
      win.setPosition(Math.round(a.x + a.width - win.getSize()[0] - 60), Math.round(a.y + a.height - win.getSize()[1]))
      persistPosition()
    } },
    { type: 'separator' },
    { label: '开发者工具', click: () => win.webContents.openDevTools({ mode: 'detach' }) },
    { label: '任务面板（Ctrl+Alt+T）', click: () => require('electron').shell.openExternal('http://127.0.0.1:8080/example/pet-tasks.html') },
    { label: '打开日志文件夹', click: () => require('electron').shell.openPath(ROOT) },
    { label: '打开配置文件', click: () => require('electron').shell.openPath(cfgPath) },
    { type: 'separator' },
    { label: '退出桌宠（Ctrl+Alt+Q）', click: () => app.quit() },
  ]))
}

/** 显示 / 隐藏（隐藏后进程还在，Ctrl+Alt+H 或托盘左键能叫回来） */
function toggleVisible() {
  if (!win || win.isDestroyed()) return
  win.isVisible() ? win.hide() : win.show()
  refreshTray()
}

function createTray() {
  const icon = nativeImage.createFromPath(path.join(ROOT, 'assets', 'tray.png'))
  tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon.resize({ width: 16, height: 16 }))
  tray.setToolTip('LivLiv 桌宠')
  tray.on('click', () => { win.isVisible() ? win.hide() : win.show() })
  refreshTray()
}

/* ------------------------------------------------------------------ 生命期 */

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    // 再点一次快捷方式/热键：把已有窗口叫到前面，并自动展开输入框
    if (!win) return
    log('收到第二次启动：把窗口叫到前面 + 展开输入框')
    win.show()
    win.focus()
    win.webContents.executeJavaScript('window.petChat?.focusInput?.()').catch(() => {})
  })

  app.whenReady().then(async () => {
    log(`启动，页面 ${cfg.url}`)
    // 先把两个本地服务拉起来（都在本进程内/同生共死），再开窗口
    await startStaticServer()
    await startChatProxyInProcess()
    createWindow()
    log(`宠物大小 ${cfg.width}×${cfg.height}`)
    createTray()
    globalShortcut.register('Control+Alt+P', () => applyClickThrough(!clickThrough))
    globalShortcut.register('Control+Alt+R', () => win && win.reload())
    globalShortcut.register('Control+Alt+Up', () => scalePet(1.1))     // 放大
    globalShortcut.register('Control+Alt+Down', () => scalePet(0.9))   // 缩小
    globalShortcut.register('Control+Alt+T', () => {                   // 任务面板
      log('Ctrl+Alt+T：打开任务面板')
      require('electron').shell.openExternal('http://127.0.0.1:8080/example/pet-tasks.html')
    })
    globalShortcut.register('Control+Alt+H', () => toggleVisible())    // 隐藏 / 显示
    globalShortcut.register('Control+Alt+Q', () => {                   // 退出
      log('Ctrl+Alt+Q：退出');
      app.quit()
    })
    for (const k of ['Control+Alt+T', 'Control+Alt+P', 'Control+Alt+R', 'Control+Alt+Up', 'Control+Alt+Down', 'Control+Alt+H', 'Control+Alt+Q']) {
      if (!globalShortcut.isRegistered(k)) log(`⚠ 热键被别的程序占用，注册失败：${k}`)
    }

    if (process.argv.includes('--dragtest')) {
      // 模拟一次拖动（走 preload 里那条真实链路：mousedown → mousemove×10 → mouseup）
      // 期望：位置变了、尺寸一点都不变。
      win.webContents.once('did-finish-load', async () => {
        const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
        await sleep(1500)
        const start = win.getBounds()
        log(`dragtest: 起始 ${start.width}×${start.height} @${start.x},${start.y}`)
        for (let round = 1; round <= 3; round++) {
          await win.webContents.executeJavaScript(`(() => {
            const cx = innerWidth / 2, cy = innerHeight / 2
            document.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0, screenX: 400, screenY: 400, clientX: cx, clientY: cy }))
            for (let i = 1; i <= 10; i++) {
              document.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, button: 0, screenX: 400 + i * 10, screenY: 400 + i * 5, clientX: cx + i * 10, clientY: cy + i * 5 }))
            }
            document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
            return true
          })()`).catch((e) => log(`dragtest: 注入失败 ${e.message}`))
          await sleep(400)
          const b = win.getBounds()
          const [cw, ch] = win.getContentSize()
          log(`dragtest: 第 ${round} 轮后 bounds ${b.width}×${b.height} @${b.x},${b.y} / 内容 ${cw}×${ch}`)
        }
        const end = win.getBounds()
        log(`dragtest: 三轮共位移 ${end.x - start.x},${end.y - start.y}；尺寸 ${start.width}×${start.height} → ${end.width}×${end.height}`)
        app.quit()
      })
    }

    if (process.argv.includes('--selftest')) {
      win.webContents.once('did-finish-load', async () => {
        const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
        try {
          await sleep(2500)
          // 如果加载的是聊天页（pet-chat.html），先真发一条消息，验证「代理 → 模型 → 气泡」整条链路
          const hasChat = await win.webContents.executeJavaScript('!!window.petChat').catch(() => false)
          if (hasChat) {
            const question = process.env.PET_TEST_MSG || '用一句话夸夸我的桌面壁纸'
            log(`selftest: 聊天测试「${question}」`)
            await win.webContents.executeJavaScript(`window.petChat.ask(${JSON.stringify(question)})`).catch((e) => log(`selftest: ask 失败 ${e.message}`))
            for (let i = 0; i < 60; i++) {
              await sleep(500)
              const busy = await win.webContents.executeJavaScript("document.getElementById('bubble').classList.contains('thinking')").catch(() => false)
              if (!busy) break
            }
            const bubble = await win.webContents.executeJavaScript("document.getElementById('bubble').textContent").catch(() => '')
            const mouth = await win.webContents.executeJavaScript('window.player ? window.player.params.mouthOpen : -1').catch(() => -1)
            log(`selftest: 气泡="${bubble}"  mouthOpen=${mouth}`)
          }
          const img = await win.webContents.capturePage()
          const file = path.join(ROOT, 'selftest.png')
          fs.writeFileSync(file, img.toPNG())
          log(`selftest: ${JSON.stringify(img.getSize())} -> ${file}`)
          const b = img.toBitmap()            // BGRA
          let opaque = 0, clear = 0
          for (let i = 3; i < b.length; i += 4) { const a = b[i]; if (a > 12) opaque++; else if (a === 0) clear++ }
          const total = b.length / 4
          log(`selftest: 不透明像素 ${(opaque / total * 100).toFixed(1)} %，全透明像素 ${(clear / total * 100).toFixed(1)} %`)
        } catch (e) { log(`selftest 失败: ${e.message}`) }
        app.quit()
      })
    }
  })

  app.on('window-all-closed', () => app.quit())
  app.on('will-quit', () => {
    globalShortcut.unregisterAll()
    try { staticServer?.close() } catch { /* 已经在关了 */ }
    log('退出，内置服务一并关闭')
  })
}

/* ------------------------------------------------------------------- IPC */

ipcMain.on('pet:drag', (_e, dx, dy) => {
  if (!win || win.isDestroyed()) return
  // 只移动，不带尺寸：在 150% 缩放上 setPosition 会因 DIP↔物理像素取整让内容尺寸每步漂 +1~2px，
  // 拖十下就肉眼可见变大。所以这里用 setBounds 并把宽高钉死成配置值。
  const b = win.getBounds()
  win.setBounds({
    x: Math.round(b.x + dx),
    y: Math.round(b.y + dy),
    width: cfg.width,
    height: cfg.height,
  })
})
ipcMain.on('pet:click-through', (_e, on) => applyClickThrough(!!on))
ipcMain.on('pet:reload', () => win && win.reload())
ipcMain.on('pet:quit', () => app.quit())
ipcMain.handle('pet:state', () => ({ clickThrough, alwaysOnTop: !!(win && win.isAlwaysOnTop()) }))

