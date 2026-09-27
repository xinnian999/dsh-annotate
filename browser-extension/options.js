/** Options page: bridge endpoint, live connection state, extension id. */

const DEFAULT_ENDPOINT = 'ws://127.0.0.1:43119'

const endpoint = document.querySelector('#endpoint')
const saved = document.querySelector('#saved')
const dot = document.querySelector('#dot')
const statusText = document.querySelector('#status-text')

document.querySelector('#extension-id').textContent = chrome.runtime.id

void chrome.storage.local.get({ endpoint: DEFAULT_ENDPOINT }).then(settings => {
  endpoint.value = settings.endpoint
})

async function refreshStatus() {
  try {
    const status = await chrome.runtime.sendMessage({ type: 'dsh-annotate-status' })
    const connected = Boolean(status?.connected)
    dot.classList.toggle('on', connected)
    statusText.textContent = connected
      ? '已连接到 DeepSeek Harness'
      : '未连接 — 请确认 DeepSeek Harness 正在运行，且已加载 dsh-annotate 插件'
  } catch {
    dot.classList.remove('on')
    statusText.textContent = '无法确认连接状态'
  }
}

document.querySelector('#save').addEventListener('click', async () => {
  await chrome.storage.local.set({ endpoint: endpoint.value.trim() || DEFAULT_ENDPOINT })
  saved.textContent = '已保存'
  setTimeout(() => { saved.textContent = '' }, 1500)
  chrome.runtime.reload()
})

void refreshStatus()
setInterval(() => void refreshStatus(), 3000)
