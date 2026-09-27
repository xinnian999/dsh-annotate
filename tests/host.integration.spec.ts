/**
 * Integration tests for the host half: boot the plugin in a real Cordis
 * context with stub services, connect a real WebSocket client as the browser
 * extension, and verify browser-initiated submissions land where intended.
 */

import { Context } from '@deepseek-ai/cordis'
import { WebSocket } from 'ws'
import { describe, expect, it } from 'vitest'
import * as annotate from '../src/index.js'

const ELEMENT = {
  selector: '#submit',
  tagName: 'button',
  classes: ['primary'],
  text: 'Submit',
  comment: '对比度太低，看不清。',
  rect: { x: 10, y: 20, width: 100, height: 40 },
  attributes: { type: 'submit' },
  styles: { color: 'rgb(0,0,0)', fontSize: '12px' },
  accessibility: { role: 'button', name: 'Submit', focusable: true, disabled: false },
}

function result(elements = [ELEMENT]) {
  return { url: 'https://example.com/page', viewport: { width: 1280, height: 720 }, elements }
}

interface Harness {
  ctx: Context
  commands: Map<string, any>
  followups: any[]
  images: { count: number }
  /** Emit the event the host fires when a user turn is appended. */
  userTurn: (sessionId: string) => void
  close: () => Promise<void>
}

let nextPort = 43_990

/** Boot the plugin with stub services and return handles onto its behaviour. */
async function boot(
  overrides: Record<string, unknown> = {},
  sessionIds = ['session-a'],
): Promise<Harness> {
  const port = ++nextPort
  const ctx = new Context()
  const commands = new Map<string, any>()
  const followups: any[] = []
  const images = { count: 0 }
  const agents = new Map<string, any>()
  for (const id of sessionIds) {
    agents.set(id, {
      id,
      status: 'idle',
      followup: (message: any) => followups.push(message),
      inject: (message: any) => followups.push(message),
    })
  }
  ctx.provide('commands', {
    register: (command: any) => {
      commands.set(command.name, command)
      return () => {}
    },
  })
  ctx.provide('attachments', {
    saveImage: async (input: any) => {
      images.count += 1
      return { kind: 'image', id: 'attachment-1', mediaType: input.mediaType }
    },
  })
  ctx.provide('agents', {
    get: (id: string) => agents.get(id),
    roots: () => [...agents.values()],
  })

  const fiber: any = await ctx.plugin(annotate, {
    host: '127.0.0.1',
    port,
    allowedExtensionId: '',
    requestTimeoutMs: 5_000,
    maxPayloadBytes: 1_000_000,
    includeScreenshot: true,
    sessionId: '',
    wake: true,
    ...overrides,
  })

  return {
    ctx,
    commands,
    followups,
    images,
    userTurn: (sessionId: string, kind: 'user' | 'plugin' = 'user') => {
      ctx.emit('session/event', { id: sessionId }, {
        type: 'user/message',
        data: { source: { kind } },
      })
    },
    close: async () => {
      await fiber.dispose()
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ...( { port } as any),
  } as Harness
}

/** Connect as the extension, retrying while the bridge finishes binding. */
async function connect(harness: Harness, extensionId = 'pafhnkcnkbgichobacjelpobleffalkm'): Promise<WebSocket> {
  const port = (harness as any).port as number
  let lastError: unknown
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const socket = new WebSocket(`ws://127.0.0.1:${port}`, {
        origin: `chrome-extension://${extensionId}`,
      })
      await new Promise<void>((resolve, reject) => {
        socket.once('open', () => resolve())
        socket.once('error', reject)
      })
      socket.send(JSON.stringify({ type: 'hello', version: 1, extensionId }))
      return socket
    } catch (error) {
      lastError = error
      await new Promise(resolve => setTimeout(resolve, 25))
    }
  }
  throw lastError
}

/** Poll for an asynchronously-assigned value. */
async function waitFor<T>(get: () => T | undefined, timeoutMs: number): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = get()
    if (value !== undefined) return value
    if (Date.now() >= deadline) throw new Error('timed out waiting for a value')
    await new Promise(resolve => setTimeout(resolve, 25))
  }
}

/**
 * Connect like the extension, but buffer incoming frames from the moment the
 * socket opens so a `start` frame cannot slip past before the test listens.
 */
async function connectCollecting(
  harness: Harness,
): Promise<{ socket: WebSocket; next: () => Promise<any> }> {
  const port = (harness as any).port as number
  let lastError: unknown
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const socket = new WebSocket(`ws://127.0.0.1:${port}`, {
      origin: 'chrome-extension://test-extension',
    })
    try {
      await new Promise<void>((resolve, reject) => {
        socket.once('open', () => resolve())
        socket.once('error', reject)
      })
    } catch (error) {
      lastError = error
      await new Promise(resolve => setTimeout(resolve, 25))
      continue
    }
    const inbox: any[] = []
    const waiters: ((value: any) => void)[] = []
    socket.on('message', raw => {
      const parsed = JSON.parse(String(raw))
      const waiter = waiters.shift()
      if (waiter === undefined) inbox.push(parsed)
      else waiter(parsed)
    })
    socket.send(JSON.stringify({ type: 'hello', version: 1, extensionId: 'test-extension' }))
    return {
      socket,
      next: () => new Promise(resolve => {
        const ready = inbox.shift()
        if (ready === undefined) waiters.push(resolve)
        else resolve(ready)
      }),
    }
  }
  throw lastError ?? new Error('could not connect')
}

function nextMessage(socket: WebSocket): Promise<any> {
  return new Promise(resolve => {
    socket.once('message', raw => resolve(JSON.parse(String(raw))))
  })
}

function submit(socket: WebSocket, payload = result()): Promise<any> {
  const received = nextMessage(socket)
  socket.send(JSON.stringify({ type: 'submit', result: payload }))
  return received
}

describe('browser-initiated annotations', () => {
  it('delivers to the session the user most recently messaged', async () => {
    const harness = await boot({}, ['session-a', 'session-b'])
    const socket = await connect(harness)
    try {
      harness.userTurn('session-b')

      const ack = await submit(socket)

      expect(ack).toMatchObject({ type: 'ack', ok: true, elements: 1, sessionId: 'session-b' })
      expect(harness.followups).toHaveLength(1)
      const message = harness.followups[0]
      expect(message.content[0].text).toContain('对比度太低，看不清。')
      expect(message.content[0].text).toContain('### 1. #submit')
      expect(message.source).toMatchObject({ kind: 'plugin', plugin: 'dsh-annotate', form: 'notice' })
    } finally {
      socket.close()
      await harness.close()
    }
  })

  it('ignores plugin-injected turns when tracking the active session', async () => {
    const harness = await boot({}, ['session-a', 'session-b'])
    const socket = await connect(harness)
    try {
      harness.userTurn('session-a')
      // A goal round, scheduled job, or another plugin's notice appends a
      // plugin-sourced user message; it must not steal the annotation target.
      harness.userTurn('session-b', 'plugin')

      const ack = await submit(socket)

      expect(ack.sessionId).toBe('session-a')
    } finally {
      socket.close()
      await harness.close()
    }
  })

  it('prefers a pinned session over the last-active one', async () => {
    const harness = await boot({}, ['session-a', 'session-b'])
    const socket = await connect(harness)
    try {
      harness.userTurn('session-a')
      const pinned = harness.commands.get('annotate-pin').handler({ agent: { id: 'session-b' } })
      expect(pinned.kind).toBe('success')

      const ack = await submit(socket)

      expect(ack.sessionId).toBe('session-b')
      expect(harness.followups).toHaveLength(1)
    } finally {
      socket.close()
      await harness.close()
    }
  })

  it('falls back to the configured session id', async () => {
    const harness = await boot({ sessionId: 'session-a' }, ['session-a', 'session-b'])
    const socket = await connect(harness)
    try {
      const ack = await submit(socket)

      expect(ack.sessionId).toBe('session-a')
    } finally {
      socket.close()
      await harness.close()
    }
  })

  it('attaches the screenshot as an image when one is present', async () => {
    const harness = await boot()
    const socket = await connect(harness)
    try {
      const ack = await submit(socket, {
        ...result(),
        screenshotDataUrl: 'data:image/png;base64,AQID',
      })

      expect(ack.ok).toBe(true)
      expect(harness.images.count).toBe(1)
      expect(harness.followups[0].content).toHaveLength(2)
      expect(harness.followups[0].content[1].type).toBe('image')
    } finally {
      socket.close()
      await harness.close()
    }
  })

  it('queues without waking when wake is disabled', async () => {
    const harness = await boot({ wake: false })
    const socket = await connect(harness)
    try {
      harness.userTurn('session-a')
      const calls: string[] = []
      // Distinguish followup (wakes) from inject (queues).
      const agent = (harness.ctx.agents as any).get('session-a')
      agent.followup = () => calls.push('followup')
      agent.inject = () => calls.push('inject')

      const ack = await submit(socket)

      expect(ack.ok).toBe(true)
      expect(calls).toEqual(['inject'])
    } finally {
      socket.close()
      await harness.close()
    }
  })

  it('reports a failure to the extension instead of failing silently', async () => {
    const harness = await boot({}, ['session-a'])
    const socket = await connect(harness)
    try {
      const ack = await submit(socket, result([]))

      expect(ack).toMatchObject({ type: 'ack', ok: false })
      expect(ack.message).toMatch(/no elements/)
      expect(harness.followups).toHaveLength(0)
    } finally {
      socket.close()
      await harness.close()
    }
  })

  it('refuses an extension whose id is not allowed', async () => {
    const harness = await boot({ allowedExtensionId: 'allowed-extension-id' }, ['session-a'])
    const socket = await connect(harness, 'some-other-extension')
    try {
      const { code } = await new Promise<{ code: number }>(resolve => {
        socket.once('close', code => resolve({ code }))
      })
      expect(code).toBe(1008)
    } finally {
      socket.close()
      await harness.close()
    }
  })

  it('shows the connected extension id in /annotate-status', async () => {
    const harness = await boot()
    const socket = await connect(harness, 'my-extension-id')
    try {
      await new Promise(resolve => setTimeout(resolve, 50))
      const status = harness.commands.get('annotate-status').handler({})
      expect(status.text).toContain('my-extension-id')
    } finally {
      socket.close()
      await harness.close()
    }
  })

  it('waits for an extension that connects after /annotate was run', async () => {
    const harness = await boot()
    let client: { socket: WebSocket; next: () => Promise<any> } | undefined
    try {
      // The extension's MV3 worker is recycled after ~30s idle, so the command
      // can land while nothing is connected. It must wait, not fail instantly.
      setTimeout(() => { void connectCollecting(harness).then(value => { client = value }) }, 300)

      const followups: any[] = []
      const handled = harness.commands.get('annotate').handler({
        agent: { id: 'session-a', followup: (message: any) => followups.push(message) },
        rawInput: '',
        signal: new AbortController().signal,
      })

      await waitFor(() => client, 6_000)
      const frame = await client!.next()
      expect(frame.type).toBe('start')
      expect(typeof frame.requestId).toBe('string')

      client!.socket.send(JSON.stringify({
        type: 'result', requestId: frame.requestId, result: result(),
      }))

      const outcome = await handled
      expect(outcome.kind).toBe('success')
      expect(followups).toHaveLength(1)
    } finally {
      client?.socket.close()
      await harness.close()
    }
  })
})
