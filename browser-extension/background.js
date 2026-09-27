/**
 * dsh-annotate service worker.
 *
 * Two ways to start an annotation:
 * - The user clicks the toolbar action (or presses the shortcut). The worker
 *   starts on the active tab and submits the result on its own.
 * - DeepSeek Harness runs `/annotate`. The host sends `start` over the bridge
 *   and receives the result as a request/response exchange.
 *
 * Chrome recycles an extension service worker after ~30 seconds without an
 * event or extension-API call, and an idle WebSocket alone does not count as
 * activity. Three parts of this file exist because of that:
 *
 * 1. A heartbeat calls an extension API so the worker — and therefore the
 *    bridge socket — survives long enough to receive `/annotate`.
 * 2. The in-flight request is persisted in `chrome.storage.session`, so a
 *    recycled worker can still tell a browser-initiated submission from a
 *    host-initiated one.
 * 3. Every send waits for a live socket and reports failure, because the worker
 *    is restarted by the content script's message at submit time and must not
 *    drop the annotation on the floor.
 */

const DEFAULT_ENDPOINT = 'ws://127.0.0.1:43119'
const HEARTBEAT_MS = 20_000
const SEND_TIMEOUT_MS = 12_000
const ACK_TIMEOUT_MS = 15_000
const PENDING_KEY = 'pending'

const BADGE_OK = '#16a34a'
const BADGE_ERR = '#dc2626'
const BADGE_BUSY = '#4d6bfe'
const DEFAULT_TITLE = '标注当前页面（点击开始）'

let socket
let connecting
let reconnectTimer
let heartbeat
let badgeTimer
let pendingAck
let anonymousSeq = 0

async function endpoint() {
  const settings = await chrome.storage.local.get({ endpoint: DEFAULT_ENDPOINT })
  return settings.endpoint
}

// ---------------------------------------------------------------- badge state

/** Show a transient badge plus a hover title explaining it. */
function flashBadge(text, color, title, holdMs) {
  clearTimeout(badgeTimer)
  void chrome.action.setBadgeText({ text })
  void chrome.action.setBadgeBackgroundColor({ color })
  void chrome.action.setTitle({ title })
  badgeTimer = setTimeout(() => {
    void chrome.action.setBadgeText({ text: '' })
    void chrome.action.setTitle({ title: DEFAULT_TITLE })
  }, holdMs)
}

function setConnected(connected) {
  clearTimeout(badgeTimer)
  void chrome.action.setBadgeText({ text: connected ? '' : '·' })
  if (!connected) void chrome.action.setBadgeBackgroundColor({ color: '#9ca3af' })
  void chrome.action.setTitle({
    title: connected ? DEFAULT_TITLE : `${DEFAULT_TITLE} — 未连接到 DeepSeek Harness`,
  })
}

/** Report a submission outcome on the toolbar. */
function onAck(message) {
  if (message.ok) {
    flashBadge('✓', BADGE_OK, `已发送 ${message.elements ?? 0} 条标注 → 会话 ${message.sessionId ?? '(未知)'}`, 3000)
  } else {
    flashBadge('!', BADGE_ERR, `发送失败：${message.message ?? '未知错误'}`, 6000)
  }
}

// ----------------------------------------------------------------- connection

/**
 * Periodic keepalive: resets the worker's idle timer and restores a dropped or
 * never-established bridge connection.
 */
function startHeartbeat() {
  stopHeartbeat()
  // Calling an extension API resets the idle timer that would otherwise recycle
  // this worker after ~30s. Reconnecting here too means a socket that dropped —
  // or whose very first attempt failed because DSH was not up yet — heals on its
  // own instead of waiting for the next click.
  heartbeat = setInterval(() => {
    void chrome.runtime.getPlatformInfo().catch(() => {})
    if (socket?.readyState !== WebSocket.OPEN) void ensureSocket().catch(() => {})
  }, HEARTBEAT_MS)
}

function stopHeartbeat() {
  if (heartbeat !== undefined) clearInterval(heartbeat)
  heartbeat = undefined
}

/** Retry the connection after a delay, replacing any pending retry. */
function scheduleReconnect(delayMs = 2000) {
  clearTimeout(reconnectTimer)
  reconnectTimer = setTimeout(() => void ensureSocket().catch(() => {}), delayMs)
}

/** Connect (or reuse) the bridge socket; concurrent callers share one attempt. */
async function ensureSocket() {
  if (socket?.readyState === WebSocket.OPEN) return socket
  if (connecting !== undefined) return connecting
  connecting = openSocket().finally(() => { connecting = undefined })
  try {
    return await connecting
  } catch (error) {
    // Chrome can start before DeepSeek Harness does, so a failed first attempt
    // must not leave the extension permanently disconnected.
    scheduleReconnect()
    throw error
  }
}

async function openSocket() {
  const ws = new WebSocket(await endpoint())
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', () => resolve(), { once: true })
    ws.addEventListener('close', () => reject(new Error('连接被关闭')), { once: true })
    ws.addEventListener('error', () => reject(new Error('无法连接到 DeepSeek Harness')), { once: true })
  })
  socket = ws
  ws.addEventListener('message', event => onFrame(event))
  ws.addEventListener('close', () => {
    if (socket !== ws) return
    socket = undefined
    setConnected(false)
    scheduleReconnect()
  })
  ws.send(JSON.stringify({ type: 'hello', version: 1, extensionId: chrome.runtime.id }))
  setConnected(true)
  return ws
}

/** Send one frame, waiting for a live socket. Resolves `false` if it never opened. */
async function sendFrame(message, timeoutMs = SEND_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      const ws = await ensureSocket()
      ws.send(JSON.stringify(message))
      return true
    } catch {
      if (Date.now() >= deadline) return false
      await new Promise(resolve => setTimeout(resolve, 300))
    }
  }
}

function waitForAck(timeoutMs = ACK_TIMEOUT_MS) {
  return new Promise(resolve => {
    const timer = setTimeout(() => {
      pendingAck = undefined
      resolve({ ok: false, message: '等待 DeepSeek Harness 响应超时' })
    }, timeoutMs)
    pendingAck = message => {
      clearTimeout(timer)
      resolve(message)
    }
  })
}

function onFrame(event) {
  let message
  try { message = JSON.parse(event.data) } catch { return }
  if (message.type === 'start') {
    void startAnnotation({ requestId: message.requestId, url: message.url })
    return
  }
  if (message.type !== 'ack') return
  if (pendingAck !== undefined) {
    const settle = pendingAck
    pendingAck = undefined
    settle(message)
  } else {
    onAck(message)
  }
}

// ------------------------------------------------------------------- requests

/** Read and clear the in-flight request. Survives a worker restart. */
async function takePending() {
  try {
    const store = await chrome.storage.session.get(PENDING_KEY)
    await chrome.storage.session.remove(PENDING_KEY)
    return store[PENDING_KEY]
  } catch {
    return undefined
  }
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  if (!tab?.id) throw new Error('没有找到活动标签页')
  return tab
}

async function waitForLoad(tabId) {
  const tab = await chrome.tabs.get(tabId)
  if (tab.status === 'complete') return
  await new Promise(resolve => {
    const listener = (changedId, info) => {
      if (changedId !== tabId || info.status !== 'complete') return
      chrome.tabs.onUpdated.removeListener(listener)
      resolve()
    }
    chrome.tabs.onUpdated.addListener(listener)
  })
}

/**
 * Enter annotation mode on the active tab.
 * @param {{ requestId?: string, url?: string }} message - `requestId` is absent
 *   for a toolbar-initiated run, which marks the result as a direct submission.
 */
async function startAnnotation(message) {
  const local = message.requestId === undefined
  const requestId = message.requestId ?? `local-${Date.now()}-${++anonymousSeq}`
  try {
    let tab = await activeTab()
    if (message.url) {
      tab = await chrome.tabs.update(tab.id, { url: message.url })
      await waitForLoad(tab.id)
    }
    await chrome.storage.session.set({ [PENDING_KEY]: { id: requestId, local, at: Date.now() } })
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] })
    await chrome.tabs.sendMessage(tab.id, { type: 'dsh-annotate-start', requestId })
  } catch (error) {
    await chrome.storage.session.remove(PENDING_KEY)
    const text = error instanceof Error ? error.message : String(error)
    if (local) flashBadge('!', BADGE_ERR, `无法在此页面标注：${text}`, 6000)
    else await sendFrame({ type: 'error', requestId, message: text })
  }
}

/** Attach the visible-tab screenshot, then dispatch. Never fails on capture. */
async function finishRequest(request, result) {
  let screenshotDataUrl
  try {
    screenshotDataUrl = await chrome.tabs.captureVisibleTab(undefined, { format: 'png' })
  } catch {
    screenshotDataUrl = undefined
  }
  const full = screenshotDataUrl === undefined ? result : { ...result, screenshotDataUrl }
  const count = result.elements?.length ?? 0

  // A missing record means the worker was recycled with nothing persisted;
  // treat it as browser-initiated so the annotation is still delivered and the
  // user still gets an answer.
  if (request === undefined || request.local) {
    flashBadge('…', BADGE_BUSY, '正在发送标注…', SEND_TIMEOUT_MS + ACK_TIMEOUT_MS)
    if (!await sendFrame({ type: 'submit', result: full })) {
      flashBadge('!', BADGE_ERR, '未连接到 DeepSeek Harness', 6000)
      return { ok: false, message: '未连接到 DeepSeek Harness，请确认它正在运行' }
    }
    const ack = await waitForAck()
    onAck(ack)
    return ack.ok
      ? { ok: true, message: `已发送 ${ack.elements ?? count} 条标注`, sessionId: ack.sessionId }
      : { ok: false, message: ack.message ?? '发送失败' }
  }

  await sendFrame({ type: 'result', requestId: request.id, result: full })
  return { ok: true, message: `已发送 ${count} 条标注` }
}

// --------------------------------------------------------------------- wiring

chrome.action.onClicked.addListener(() => void startAnnotation({}))

chrome.commands.onCommand.addListener(command => {
  if (command === 'start-annotation') void startAnnotation({})
})

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'dsh-annotate-status') {
    sendResponse({ connected: socket?.readyState === WebSocket.OPEN, endpoint: socket?.url })
    return
  }
  if (message.type === 'dsh-annotate-cancel') {
    void (async () => {
      const request = await takePending()
      if (request !== undefined && !request.local) await sendFrame({ type: 'cancel', requestId: request.id })
    })()
    return
  }
  if (message.type !== 'dsh-annotate-result') return
  // Report the real outcome back to the page so the user sees it there.
  void (async () => {
    const request = await takePending()
    sendResponse(await finishRequest(request, message.result))
  })()
  return true
})

// Start the heartbeat whether or not the socket is up: it keeps this worker
// alive and retries a connection the host was not ready for yet.
startHeartbeat()
chrome.runtime.onInstalled.addListener(() => void ensureSocket().catch(() => {}))
chrome.runtime.onStartup.addListener(() => void ensureSocket().catch(() => {}))
void ensureSocket().catch(() => {})
