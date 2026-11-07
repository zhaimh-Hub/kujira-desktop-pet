// 预加载脚本：给窗口加「按住拖动」的能力，并把几个小能力暴露给页面（window.pet）。
// 拖拽用屏幕坐标算增量，所以窗口移动时鼠标不会和窗口互相追着跑。
'use strict'

const { contextBridge, ipcRenderer } = require('electron')

let suppressClick = false

addEventListener('DOMContentLoaded', () => {
  let down = false
  let moved = false
  let lx = 0
  let ly = 0

  // 这些区域按下时不要拖动窗口：气泡要能自己拖、输入框和按钮要能点
  const NO_DRAG = '#bubble, #bar, #chatico, #close, input, textarea, button, [data-nodrag]'
  const inNoDrag = (t) => !!(t && t.closest && t.closest(NO_DRAG))

  document.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return
    if (inNoDrag(e.target)) return          // ← 关键：捕获阶段先跑，必须在这里就放行
    down = true
    moved = false
    lx = e.screenX
    ly = e.screenY
  }, true)

  document.addEventListener('mousemove', (e) => {
    if (!down) return
    const dx = e.screenX - lx
    const dy = e.screenY - ly
    if (!moved) {
      if (Math.hypot(dx, dy) < 5) return   // 阈值内算点击
      moved = true
    }
    ipcRenderer.send('pet:drag', dx, dy)
    lx = e.screenX
    ly = e.screenY
  }, true)

  addEventListener('mouseup', () => {
    if (moved) suppressClick = true
    down = false
  }, true)

  // 拖完那一下的鼠标松开，别再触发页面里的「单击换表情」
  document.addEventListener('click', (e) => {
    if (!suppressClick) return
    suppressClick = false
    e.stopPropagation()
    e.preventDefault()
  }, true)
})

contextBridge.exposeInMainWorld('pet', {
  setClickThrough: (on) => ipcRenderer.send('pet:click-through', !!on),
  reload: () => ipcRenderer.send('pet:reload'),
  quit: () => ipcRenderer.send('pet:quit'),
  state: () => ipcRenderer.invoke('pet:state'),
})
