(() => {
  if (globalThis.__dshAnnotateInstalled) return
  globalThis.__dshAnnotateInstalled = true

  let cleanup = () => {}

  chrome.runtime.onMessage.addListener(message => {
    if (message.type === 'dsh-annotate-start') start(message.requestId)
  })

  function start(requestId) {
    cleanup()
    const selections = []
    const markers = []
    let hovered

    const hoverBox = document.createElement('div')
    Object.assign(hoverBox.style, {
      position: 'fixed', pointerEvents: 'none', zIndex: '2147483646',
      border: '2px solid #4d6bfe', background: 'rgba(77,107,254,.12)', display: 'none',
    })

    const toolbar = document.createElement('div')
    toolbar.dataset.dshAnnotateUi = 'true'
    Object.assign(toolbar.style, {
      position: 'fixed', top: '16px', left: '50%', transform: 'translateX(-50%)',
      zIndex: '2147483647', display: 'flex', gap: '8px', alignItems: 'center',
      padding: '10px 12px', borderRadius: '10px', background: '#111827', color: '#fff',
      font: '13px system-ui, sans-serif', boxShadow: '0 8px 30px rgba(0,0,0,.3)',
    })
    const status = document.createElement('span')
    status.textContent = 'Click an element to annotate'
    toolbar.append(status, button('Submit', submit), button('Cancel', cancel))
    document.documentElement.append(hoverBox, toolbar)

    function button(label, handler) {
      const element = document.createElement('button')
      element.textContent = label
      Object.assign(element.style, {
        border: '0', borderRadius: '6px', padding: '6px 10px', cursor: 'pointer',
        background: label === 'Submit' ? '#4d6bfe' : '#374151', color: '#fff',
      })
      element.addEventListener('click', event => { event.stopPropagation(); handler() })
      return element
    }

    function isUi(element) {
      return element?.closest?.('[data-dsh-annotate-ui="true"]') || element === toolbar
    }

    function move(event) {
      const element = document.elementFromPoint(event.clientX, event.clientY)
      if (!(element instanceof Element) || isUi(element)) return
      hovered = element
      const rect = element.getBoundingClientRect()
      Object.assign(hoverBox.style, {
        display: 'block', left: `${rect.left}px`, top: `${rect.top}px`,
        width: `${rect.width}px`, height: `${rect.height}px`,
      })
    }

    function select(event) {
      if (!(hovered instanceof Element) || isUi(event.target)) return
      event.preventDefault()
      event.stopPropagation()
      const comment = prompt(`Comment for ${selectorFor(hovered)}:`)
      if (!comment?.trim()) return
      const captured = capture(hovered, comment.trim())
      selections.push(captured)
      const marker = document.createElement('div')
      marker.dataset.dshAnnotateUi = 'true'
      marker.textContent = String(selections.length)
      Object.assign(marker.style, {
        position: 'fixed', left: `${captured.rect.x}px`, top: `${captured.rect.y}px`,
        zIndex: '2147483647', width: '24px', height: '24px', borderRadius: '999px',
        display: 'grid', placeItems: 'center', background: '#4d6bfe', color: '#fff',
        font: 'bold 12px system-ui, sans-serif', pointerEvents: 'none',
      })
      document.documentElement.append(marker)
      markers.push(marker)
      status.textContent = `${selections.length} selected — click more or submit`
    }

    function submit() {
      chrome.runtime.sendMessage({
        type: 'dsh-annotate-result', requestId,
        result: {
          url: location.href,
          viewport: { width: innerWidth, height: innerHeight },
          elements: selections,
        },
      })
      cleanup()
    }

    function cancel() {
      chrome.runtime.sendMessage({ type: 'dsh-annotate-cancel', requestId })
      cleanup()
    }

    function onKey(event) { if (event.key === 'Escape') cancel() }
    document.addEventListener('mousemove', move, true)
    document.addEventListener('click', select, true)
    document.addEventListener('keydown', onKey, true)
    cleanup = () => {
      document.removeEventListener('mousemove', move, true)
      document.removeEventListener('click', select, true)
      document.removeEventListener('keydown', onKey, true)
      hoverBox.remove(); toolbar.remove(); markers.forEach(marker => marker.remove())
      cleanup = () => {}
    }
  }

  function selectorFor(element) {
    if (element.id) return `#${CSS.escape(element.id)}`
    const parts = []
    let current = element
    while (current && parts.length < 4) {
      let part = current.tagName.toLowerCase()
      const classes = [...current.classList].slice(0, 2)
      if (classes.length) part += `.${classes.map(value => CSS.escape(value)).join('.')}`
      const siblings = current.parentElement ? [...current.parentElement.children].filter(item => item.tagName === current.tagName) : []
      if (siblings.length > 1) part += `:nth-of-type(${siblings.indexOf(current) + 1})`
      parts.unshift(part)
      current = current.parentElement
    }
    return parts.join(' > ')
  }

  function capture(element, comment) {
    const rect = element.getBoundingClientRect()
    const computed = getComputedStyle(element)
    const attributes = Object.fromEntries([...element.attributes].slice(0, 20).map(item => [item.name, item.value]))
    const role = element.getAttribute('role') || implicitRole(element)
    const name = element.getAttribute('aria-label') || element.textContent?.trim().slice(0, 200) || undefined
    return {
      selector: selectorFor(element),
      tagName: element.tagName.toLowerCase(),
      ...(element.id ? { id: element.id } : {}),
      classes: [...element.classList],
      text: element.textContent?.trim().replace(/\s+/g, ' ').slice(0, 500) || '',
      comment,
      rect: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) },
      attributes,
      styles: {
        display: computed.display, position: computed.position, color: computed.color,
        backgroundColor: computed.backgroundColor, font: computed.font,
        margin: computed.margin, padding: computed.padding, border: computed.border,
      },
      accessibility: {
        ...(role ? { role } : {}), ...(name ? { name } : {}),
        focusable: element.matches('a[href],button,input,select,textarea,[tabindex]'),
        disabled: element.matches(':disabled,[aria-disabled="true"]'),
      },
    }
  }

  function implicitRole(element) {
    const roles = { A: 'link', BUTTON: 'button', INPUT: 'textbox', SELECT: 'combobox', TEXTAREA: 'textbox', IMG: 'img' }
    return roles[element.tagName]
  }
})()
