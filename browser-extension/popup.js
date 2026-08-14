const endpoint = document.querySelector('#endpoint')
const saved = document.querySelector('#saved')
document.querySelector('#extension-id').textContent = chrome.runtime.id

void chrome.storage.local.get({ endpoint: 'ws://127.0.0.1:43119' }).then(settings => {
  endpoint.value = settings.endpoint
})

document.querySelector('#save').addEventListener('click', async () => {
  await chrome.storage.local.set({ endpoint: endpoint.value.trim() })
  saved.textContent = 'Saved'
  setTimeout(() => { saved.textContent = '' }, 1200)
  chrome.runtime.reload()
})
