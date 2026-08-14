const DEFAULT_ENDPOINT = 'ws://127.0.0.1:43119'
let socket
let reconnectTimer

async function endpoint() {
  const settings = await chrome.storage.local.get({ endpoint: DEFAULT_ENDPOINT })
  return settings.endpoint
}

async function connect() {
  clearTimeout(reconnectTimer)
  if (socket && socket.readyState <= WebSocket.OPEN) return
  socket = new WebSocket(await endpoint())
  socket.addEventListener('open', () => {
    socket.send(JSON.stringify({ type: 'hello', version: 1, extensionId: chrome.runtime.id }))
  })
  socket.addEventListener('message', event => {
    let message
    try { message = JSON.parse(event.data) } catch { return }
    if (message.type === 'start') void startAnnotation(message)
  })
  socket.addEventListener('close', () => {
    socket = undefined
    reconnectTimer = setTimeout(() => void connect(), 2000)
  })
  socket.addEventListener('error', () => socket?.close())
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  if (!tab?.id) throw new Error('No active browser tab.')
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

async function startAnnotation(message) {
  try {
    let tab = await activeTab()
    if (message.url) {
      tab = await chrome.tabs.update(tab.id, { url: message.url })
      await waitForLoad(tab.id)
    }
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] })
    await chrome.tabs.sendMessage(tab.id, { type: 'dsh-annotate-start', requestId: message.requestId })
  } catch (error) {
    send({ type: 'error', requestId: message.requestId, message: error.message || String(error) })
  }
}

function send(message) {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message))
}

chrome.runtime.onMessage.addListener((message, sender) => {
  if (message.type !== 'dsh-annotate-result' && message.type !== 'dsh-annotate-cancel') return
  if (message.type === 'dsh-annotate-cancel') {
    send({ type: 'cancel', requestId: message.requestId })
    return
  }
  void chrome.tabs.captureVisibleTab(sender.tab?.windowId, { format: 'png' }).then(screenshotDataUrl => {
    send({
      type: 'result',
      requestId: message.requestId,
      result: { ...message.result, screenshotDataUrl },
    })
  }).catch(error => send({ type: 'error', requestId: message.requestId, message: error.message }))
})

chrome.runtime.onInstalled.addListener(() => void connect())
chrome.runtime.onStartup.addListener(() => void connect())
void connect()
