/** Local WebSocket bridge between Harness and the browser extension. */

import { randomUUID } from 'node:crypto'
import { WebSocket, WebSocketServer, type RawData } from 'ws'
import type { AnnotationResult, ClientMessage, ServerMessage } from './protocol.js'
import { parseClientMessage } from './protocol.js'

interface PendingRequest {
  resolve: (result: AnnotationResult) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
  signal: AbortSignal
  onAbort: () => void
}

/** Configuration needed by the local browser bridge. */
export interface BridgeConfig {
  host: string
  port: number
  allowedExtensionId: string
  requestTimeoutMs: number
  maxPayloadBytes: number
}

/**
 * Deliver an annotation the user started from the browser, with no pending
 * `/annotate` request. Resolves with the session it landed in for the ack.
 */
export type SubmitHandler = (result: AnnotationResult) => Promise<{ sessionId?: string } | undefined>

/** One connected browser extension and its pending annotation requests. */
export class AnnotationBridge {
  private readonly server: WebSocketServer
  private readonly ready: Promise<void>
  private client: WebSocket | undefined
  private clientExtensionId: string | undefined
  private pending = new Map<string, PendingRequest>()

  constructor(
    private readonly config: BridgeConfig,
    private readonly onSubmit?: SubmitHandler,
  ) {
    this.server = new WebSocketServer({
      host: config.host,
      port: config.port,
      verifyClient: ({ origin }: { origin: string }) => origin.startsWith('chrome-extension://'),
    })
    this.ready = new Promise((resolve, reject) => {
      this.server.once('listening', resolve)
      this.server.once('error', reject)
    })
    this.server.on('connection', socket => this.accept(socket))
  }

  /** Whether an authenticated extension is currently connected. */
  get connected(): boolean {
    return this.client?.readyState === WebSocket.OPEN
  }

  /** The connected extension's id, or `undefined` while none is connected. */
  get extensionId(): string | undefined {
    return this.connected ? this.clientExtensionId : undefined
  }

  /** Request annotation in the connected browser. */
  async annotate(url: string | undefined, signal: AbortSignal): Promise<AnnotationResult> {
    await this.ready
    signal.throwIfAborted()
    // An MV3 service worker is recycled after ~30s idle and that drops the
    // socket with no host-side signal, so give a reconnecting extension a
    // moment instead of failing the instant the command runs.
    await this.waitForClient(signal)
    const requestId = randomUUID()

    return new Promise<AnnotationResult>((resolve, reject) => {
      const onAbort = (): void => this.settle(requestId, new Error('annotation request was cancelled'))
      const timer = setTimeout(
        () => this.settle(requestId, new Error('annotation request timed out')),
        this.config.requestTimeoutMs,
      )
      this.pending.set(requestId, { resolve, reject, timer, signal, onAbort })
      signal.addEventListener('abort', onAbort, { once: true })
      this.notify({ type: 'start', requestId, ...(url === undefined ? {} : { url }) })
    })
  }

  /** Close the bridge and reject every pending request. */
  async close(): Promise<void> {
    for (const requestId of this.pending.keys()) this.settle(requestId, new Error('annotation bridge stopped'))
    for (const client of this.server.clients) client.terminate()
    await new Promise<void>(resolve => this.server.close(() => resolve()))
  }

  private accept(socket: WebSocket): void {
    let greeted = false
    socket.on('message', raw => {
      try {
        const data = toBuffer(raw)
        const message = parseClientMessage(data, this.config.maxPayloadBytes)
        if (!greeted) {
          if (message.type !== 'hello') throw new Error('browser extension must introduce itself first')
          if (this.config.allowedExtensionId !== '' && message.extensionId !== this.config.allowedExtensionId) {
            throw new Error('browser extension id is not allowed')
          }
          greeted = true
          this.client?.terminate()
          this.client = socket
          this.clientExtensionId = message.extensionId
          return
        }
        this.handle(message)
      } catch (error) {
        socket.close(1008, error instanceof Error ? error.message.slice(0, 120) : 'invalid message')
      }
    })
    socket.on('close', () => {
      if (this.client !== socket) return
      this.client = undefined
      this.clientExtensionId = undefined
      for (const requestId of this.pending.keys()) this.settle(requestId, new Error('browser extension disconnected'))
    })
  }

  private handle(message: ClientMessage): void {
    if (message.type === 'hello') return
    if (message.type === 'submit') {
      void this.handleSubmit(message.result)
      return
    }
    if (message.type === 'result') this.settle(message.requestId, undefined, message.result)
    else if (message.type === 'cancel') this.settle(message.requestId, new Error('annotation was cancelled in the browser'))
    else this.settle(message.requestId, new Error(message.message))
  }

  /**
   * Deliver a browser-initiated submission and report the outcome back to the
   * extension, which surfaces it as a toolbar badge.
   */
  private async handleSubmit(result: AnnotationResult): Promise<void> {
    try {
      const outcome = await this.onSubmit?.(result)
      this.notify({
        type: 'ack',
        ok: true,
        elements: result.elements.length,
        ...(outcome?.sessionId === undefined ? {} : { sessionId: outcome.sessionId }),
      })
    } catch (error) {
      this.notify({ type: 'ack', ok: false, message: error instanceof Error ? error.message : String(error) })
    }
  }

  /**
   * Wait for an authenticated extension to be connected.
   *
   * @param signal - aborts the wait.
   * @param timeoutMs - how long to wait before giving up.
   * @throws when no extension connects in time.
   */
  private async waitForClient(signal: AbortSignal, timeoutMs = 10_000): Promise<void> {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      signal.throwIfAborted()
      if (this.client?.readyState === WebSocket.OPEN) return
      if (Date.now() >= deadline) {
        throw new Error(
          'The dsh-annotate browser extension is not connected. Open the browser and click the dsh-annotate toolbar icon.',
        )
      }
      await new Promise(resolve => setTimeout(resolve, 150))
    }
  }

  /** Send one frame to the connected extension, ignoring a closed or absent socket. */
  private notify(message: ServerMessage): void {
    const client = this.client
    if (client?.readyState !== WebSocket.OPEN) return
    client.send(JSON.stringify(message))
  }

  private settle(requestId: string, error?: Error, result?: AnnotationResult): void {
    const request = this.pending.get(requestId)
    if (request === undefined) return
    this.pending.delete(requestId)
    clearTimeout(request.timer)
    request.signal.removeEventListener('abort', request.onAbort)
    if (error !== undefined) request.reject(error)
    else if (result !== undefined) request.resolve(result)
  }
}

function toBuffer(raw: RawData): Buffer {
  if (Buffer.isBuffer(raw)) return raw
  if (Array.isArray(raw)) return Buffer.concat(raw)
  return Buffer.from(raw)
}
