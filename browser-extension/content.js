/**
 * dsh-annotate page agent.
 *
 * Injected on demand. Draws the hover highlight and toolbar, collects one
 * annotation per picked element, and hands the batch back to the service
 * worker. Comments are written in an in-page bubble, never `window.prompt`.
 */
(() => {
  if (globalThis.__dshAnnotateInstalled) return
  globalThis.__dshAnnotateInstalled = true

  const ACCENT = '#4d6bfe'
  const UI_ATTR = 'data-dsh-annotate-ui'

  let cleanup = () => {}

  chrome.runtime.onMessage.addListener(message => {
    if (message.type === 'dsh-annotate-start') start(message.requestId)
  })

  function start(requestId) {
    cleanup()
    const selections = []
    const markers = []
    let hovered
    let bubble

    const hoverBox = document.createElement('div')
    Object.assign(hoverBox.style, {
      position: 'fixed', pointerEvents: 'none', zIndex: '2147483646',
      border: `2px solid ${ACCENT}`, background: 'rgba(77,107,254,.12)', display: 'none',
    })

    const toolbar = document.createElement('div')
    toolbar.setAttribute(UI_ATTR, 'true')
    Object.assign(toolbar.style, {
      position: 'fixed', top: '16px', left: '50%', transform: 'translateX(-50%)',
      zIndex: '2147483647', display: 'flex', gap: '8px', alignItems: 'center',
      padding: '10px 12px', borderRadius: '10px', background: '#111827', color: '#fff',
      font: '13px system-ui, -apple-system, "PingFang SC", sans-serif',
      boxShadow: '0 8px 30px rgba(0,0,0,.3)',
    })
    const status = document.createElement('span')
    status.textContent = '点击页面元素开始标注'
    toolbar.append(status, button('提交', ACCENT, submit), button('取消', '#374151', cancel))
    document.documentElement.append(hoverBox, toolbar)

    function button(label, background, handler) {
      const element = document.createElement('button')
      element.textContent = label
      Object.assign(element.style, {
        border: '0', borderRadius: '6px', padding: '6px 10px', cursor: 'pointer',
        background, color: '#fff', font: 'inherit',
      })
      element.addEventListener('click', event => { event.stopPropagation(); handler() })
      return element
    }

    function isUi(element) {
      return Boolean(element?.closest?.(`[${UI_ATTR}="true"]`)) || element === toolbar
    }

    function move(event) {
      if (bubble) return
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
      if (bubble) return // one comment at a time
      if (!(hovered instanceof Element) || isUi(event.target)) return
      event.preventDefault()
      event.stopPropagation()
      const target = hovered
      openCommentBubble(target, comment => {
        const captured = capture(target, comment)
        selections.push(captured)
        const marker = document.createElement('div')
        marker.setAttribute(UI_ATTR, 'true')
        marker.textContent = String(selections.length)
        Object.assign(marker.style, {
          position: 'fixed', left: `${captured.rect.x}px`, top: `${captured.rect.y}px`,
          zIndex: '2147483647', width: '24px', height: '24px', borderRadius: '999px',
          display: 'grid', placeItems: 'center', background: ACCENT, color: '#fff',
          font: 'bold 12px system-ui, sans-serif', pointerEvents: 'none',
        })
        document.documentElement.append(marker)
        markers.push(marker)
        status.textContent = `已选 ${selections.length} 个 — 可继续点选，或点「提交」`
      })
    }

    /** In-page comment editor anchored to the picked element. */
    function openCommentBubble(target, onConfirm) {
      closeBubble()
      const rect = target.getBoundingClientRect()
      const panel = document.createElement('div')
      panel.setAttribute(UI_ATTR, 'true')
      Object.assign(panel.style, {
        position: 'fixed', width: '320px', zIndex: '2147483647',
        display: 'flex', flexDirection: 'column', gap: '8px',
        padding: '10px', borderRadius: '10px', background: '#111827', color: '#fff',
        font: '13px system-ui, -apple-system, "PingFang SC", sans-serif',
        boxShadow: '0 12px 40px rgba(0,0,0,.45)',
      })
      const margin = 8
      const width = 320
      const height = 132
      const left = Math.min(Math.max(margin, rect.left), Math.max(margin, innerWidth - width - margin))
      const below = rect.bottom + margin
      const top = below + height > innerHeight ? Math.max(margin, rect.top - height - margin) : below
      panel.style.left = `${left}px`
      panel.style.top = `${top}px`

      const label = document.createElement('div')
      label.textContent = `标注 ${selectorFor(target)}`
      Object.assign(label.style, { fontSize: '11px', opacity: '.7', wordBreak: 'break-all' })

      const input = document.createElement('textarea')
      input.rows = 3
      input.placeholder = '写下问题或建议'
      Object.assign(input.style, {
        width: '100%', boxSizing: 'border-box', resize: 'vertical',
        borderRadius: '6px', border: '1px solid #374151', background: '#1f2937',
        color: '#fff', padding: '6px 8px', font: 'inherit',
      })

      const row = document.createElement('div')
      Object.assign(row.style, { display: 'flex', gap: '8px', justifyContent: 'space-between', alignItems: 'center' })
      const hint = document.createElement('span')
      hint.textContent = '⌘/Ctrl+Enter 确认 · Esc 取消'
      Object.assign(hint.style, { fontSize: '11px', opacity: '.55' })
      const actions = document.createElement('div')
      Object.assign(actions.style, { display: 'flex', gap: '8px' })

      function confirm() {
        const value = input.value.trim()
        if (!value) { input.focus(); return }
        closeBubble()
        onConfirm(value)
      }

      actions.append(button('取消', '#374151', closeBubble), button('确认', ACCENT, confirm))
      row.append(hint, actions)
      panel.append(label, input, row)

      // Keep every bubble interaction out of the page's own handlers.
      for (const type of ['click', 'mousedown', 'mouseup', 'pointerdown']) {
        panel.addEventListener(type, event => event.stopPropagation())
      }
      input.addEventListener('keydown', event => {
        event.stopPropagation()
        if (event.key === 'Escape') { event.preventDefault(); closeBubble() }
        if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); confirm() }
      })

      document.documentElement.append(panel)
      bubble = panel
      input.focus()
    }

    function closeBubble() {
      if (!bubble) return
      bubble.remove()
      bubble = undefined
    }

    async function submit() {
      closeBubble()
      const count = selections.length
      const payload = {
        url: location.href,
        viewport: { width: innerWidth, height: innerHeight },
        elements: selections,
      }
      cleanup()
      let outcome
      try {
        outcome = await chrome.runtime.sendMessage({
          type: 'dsh-annotate-result', requestId, result: payload,
        })
      } catch (error) {
        outcome = { ok: false, message: error instanceof Error ? error.message : String(error) }
      }
      showToast(outcome, count)
    }

    function cancel() {
      closeBubble()
      void chrome.runtime.sendMessage({ type: 'dsh-annotate-cancel', requestId }).catch(() => {})
      cleanup()
    }

    // Capture phase, so this runs before the bubble's own keydown handler.
    // While a bubble is open, Escape belongs to the bubble (close it), not to
    // cancelling the whole annotation session.
    function onKey(event) {
      if (event.key !== 'Escape' || bubble) return
      cancel()
    }
    document.addEventListener('mousemove', move, true)
    document.addEventListener('click', select, true)
    document.addEventListener('keydown', onKey, true)
    cleanup = () => {
      document.removeEventListener('mousemove', move, true)
      document.removeEventListener('click', select, true)
      document.removeEventListener('keydown', onKey, true)
      closeBubble()
      hoverBox.remove(); toolbar.remove(); markers.forEach(marker => marker.remove())
      cleanup = () => {}
    }
  }

  /**
   * Transient result pill. The submission happens after the annotation UI is
   * torn down, so this is the only place the user learns whether it arrived.
   */
  function showToast(outcome, count) {
    const ok = outcome?.ok !== false
    const detail = outcome?.message ?? (ok ? `已发送 ${count} 条标注` : '发送失败')
    const suffix = ok && outcome?.sessionId ? ` → 会话 ${outcome.sessionId}` : ''
    const toast = document.createElement('div')
    toast.setAttribute(UI_ATTR, 'true')
    toast.textContent = `${ok ? '✓' : '✕'} ${detail}${suffix}`
    Object.assign(toast.style, {
      position: 'fixed', left: '50%', bottom: '28px', transform: 'translateX(-50%)',
      zIndex: '2147483647', maxWidth: '70vw', padding: '10px 16px', borderRadius: '999px',
      background: ok ? '#16a34a' : '#dc2626', color: '#fff',
      font: '13px system-ui, -apple-system, "PingFang SC", sans-serif',
      boxShadow: '0 8px 30px rgba(0,0,0,.35)', pointerEvents: 'none',
      opacity: '0', transition: 'opacity .18s ease',
    })
    document.documentElement.append(toast)
    requestAnimationFrame(() => { toast.style.opacity = '1' })
    setTimeout(() => {
      toast.style.opacity = '0'
      setTimeout(() => toast.remove(), 220)
    }, ok ? 3200 : 6000)
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
        fontSize: computed.fontSize, fontWeight: computed.fontWeight,
        lineHeight: computed.lineHeight, borderRadius: computed.borderRadius,
        margin: computed.margin, padding: computed.padding, border: computed.border,
        boxShadow: computed.boxShadow, opacity: computed.opacity,
        zIndex: computed.zIndex, overflow: computed.overflow, gap: computed.gap,
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
