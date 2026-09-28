/** Browser element annotation plugin for DeepSeek Harness. */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-attachment'
import type {} from '@deepseek-ai/dsh-commands'
import type { Session, SessionId } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import Schema from '@deepseek-ai/schemastery'
import { AnnotationBridge } from './bridge.js'
import { decodePngDataUrl, renderAnnotation, type AnnotationResult } from './protocol.js'

export const name = 'dsh-annotate'
export const inject = ['commands', 'attachments', 'agents', 'sessions']

/** Deployment configuration for the local browser bridge. */
export interface Config {
  host: string
  port: number
  allowedExtensionId: string
  requestTimeoutMs: number
  maxPayloadBytes: number
  includeScreenshot: boolean
  sessionId: string
  wake: boolean
  preferDraft: boolean
}

export const Config: Schema<Config> = Schema.object({
  host: Schema.string().default('127.0.0.1'),
  port: Schema.number().step(1).min(1).max(65_535).default(43_119),
  allowedExtensionId: Schema.string().default(''),
  requestTimeoutMs: Schema.number().min(1).default(300_000),
  maxPayloadBytes: Schema.number().step(1).min(1).default(16 * 1024 * 1024),
  includeScreenshot: Schema.boolean().default(true),
  sessionId: Schema.string().default('').description(
    'Fixed target session id for browser-initiated submissions; empty follows the session where you last sent a message.',
  ),
  wake: Schema.boolean().default(true).description(
    'true: a submission starts the agent immediately; false: queue it for the next turn without waking the agent.',
  ),
  preferDraft: Schema.boolean().default(true).description(
    'true: a New Session the user opened but never messaged in (a live blank session) wins over the last-messaged session.',
  ),
})

/**
 * Register the loopback bridge, the annotation commands, and browser-initiated
 * delivery.
 *
 * Two entry points share one delivery path:
 * - `/annotate` asks the extension to start, and the result returns to the
 *   invoking session.
 * - The user clicks the extension action; the extension submits on its own and
 *   the result goes to the resolved target session.
 */
export function apply(ctx: Context, config: Config): void {
  if (config.host !== '127.0.0.1' && config.host !== '::1' && config.host !== 'localhost') {
    throw new Error('dsh-annotate host must be a loopback address')
  }

  /** Session the user most recently sent a message in, and when it happened. */
  let lastActiveSessionId: SessionId | undefined
  let lastActiveAt = 0
  /** Session pinned by `/annotate-pin`; overrides every other rule. */
  let pinnedSessionId: SessionId | undefined

  // A genuine user turn is the strongest available signal of "the session I am
  // working in" — the host has no notion of the session a client is viewing.
  //
  // Plugin-injected turns (goal rounds, scheduled jobs, other plugins' notices,
  // and this plugin's own submissions) also append `user/message`, so filter on
  // the source kind. This is the same discriminator the host uses to compute
  // `lastPromptAt`, and it stops a background injection from stealing the
  // annotation target.
  ctx.on('session/event', (session, event) => {
    if (event.type !== 'user/message') return
    if (event.data.source.kind !== 'user') return
    lastActiveSessionId = session.id
    lastActiveAt = Date.now()
  })

  /**
   * The New Session the user has open but never messaged in: a live Session with
   * no events yet.
   *
   * Starting a New Session creates the Session (and composes its live Agent)
   * right away, and it stays blank until the first message — so the newest blank
   * Session is the freshest signal for "the conversation I am looking at" when
   * the user has not typed there yet. That is exactly the case where the
   * last-messaged Session would be the wrong conversation, or where nothing at
   * all resolves (`session/event` never fired for the new Session).
   *
   * A client's viewed Session is not visible to the host, so this stays a
   * heuristic and `preferDraft: false` disables it. Blank Sessions whose Agent is
   * gone (an old draft) are ignored, so a delivery never targets a dead session.
   */
  function newestDraft(): Session | undefined {
    let newest: Session | undefined
    for (const session of ctx.sessions.list()) {
      if (session.seq !== 0) continue
      if (session.header.origin === 'subagent') continue
      if (ctx.agents.get(session.id) === undefined) continue
      if (newest === undefined || session.header.createdAt > newest.header.createdAt) newest = session
    }
    return newest
  }

  /** Resolve the session a browser-initiated annotation should land in. */
  function resolveTarget(): SessionId {
    if (pinnedSessionId !== undefined) return pinnedSessionId
    if (config.sessionId !== '') return config.sessionId as SessionId
    const draft = config.preferDraft ? newestDraft() : undefined
    // Whichever happened last wins: a New Session opened after the user's last
    // message means they moved to a new conversation; a message sent after the
    // draft was opened means they went back to typing in an older one.
    if (draft !== undefined && draft.header.createdAt > lastActiveAt) return draft.id
    if (lastActiveSessionId !== undefined) return lastActiveSessionId
    if (draft !== undefined) return draft.id
    const roots = ctx.agents.roots()
    const only = roots.length === 1 ? roots[0] : undefined
    if (only !== undefined) return only.id
    throw new Error(
      roots.length === 0
        ? '没有可接收标注的会话：请先在 DeepSeek Harness 里打开一个新会话或发一条消息，也可以在该会话里执行 /annotate-pin。'
        : `有 ${roots.length} 个会话在运行，无法判断标注该进哪一个：请在目标会话里发一条消息、新开一个会话，或在该会话里执行 /annotate-pin。`,
    )
  }

  /** Build the user message one annotation becomes. */
  async function buildMessage(result: AnnotationResult) {
    const content: Parameters<typeof createUserMessage>[0]['content'] = [
      { type: 'text', text: renderAnnotation(result) },
    ]
    if (config.includeScreenshot && result.screenshotDataUrl !== undefined) {
      const attachment = await ctx.attachments.saveImage({
        data: decodePngDataUrl(result.screenshotDataUrl),
        mediaType: 'image/png',
        name: 'dsh-annotate.png',
      })
      content.push({ type: 'image', attachment })
    }
    const count = result.elements.length
    return createUserMessage({
      content,
      source: {
        kind: 'plugin',
        plugin: name,
        form: 'notice',
        summary: `Browser annotation: ${count} element${count === 1 ? '' : 's'} on ${result.url}`,
      },
    })
  }

  /** Deliver one annotation into an exact session. */
  async function deliver(result: AnnotationResult, sessionId: SessionId): Promise<void> {
    const agent = ctx.agents.get(sessionId)
    if (agent === undefined) {
      throw new Error(`会话 ${sessionId} 没有正在运行的 Agent（可能已关闭）：请在该会话里发一条消息后重试。`)
    }
    const message = await buildMessage(result)
    if (config.wake) agent.followup(message)
    else agent.inject(message)
  }

  const bridge = new AnnotationBridge(config, async result => {
    if (result.elements.length === 0) throw new Error('no elements were annotated')
    const sessionId = resolveTarget()
    await deliver(result, sessionId)
    return { sessionId }
  })
  ctx.effect(() => () => bridge.close(), 'dsh-annotate.bridge')

  ctx.commands.register({
    name: 'annotate',
    description: '让浏览器扩展开始标注，结果进入本会话。',
    input: { hint: '[URL]' },
    async handler({ agent, rawInput, signal }) {
      try {
        const url = rawInput.trim() || undefined
        if (url !== undefined) new URL(url)
        const result = await bridge.annotate(url, signal)
        if (result.elements.length === 0) return { kind: 'success', text: '标注结束，没有选中任何元素。' }
        agent.followup(await buildMessage(result))
        return { kind: 'success', text: `已把 ${result.elements.length} 条标注发送到本会话。` }
      } catch (error) {
        return { kind: 'error', text: error instanceof Error ? error.message : String(error) }
      }
    },
  })

  ctx.commands.register({
    name: 'annotate-pin',
    description: '把浏览器标注固定发送到本会话，直到执行 /annotate-unpin。',
    handler({ agent }) {
      pinnedSessionId = agent.id
      return { kind: 'success', text: `浏览器标注已固定到本会话（${pinnedSessionId}）。` }
    },
  })

  ctx.commands.register({
    name: 'annotate-unpin',
    description: '清除 /annotate-pin 固定的标注目标会话。',
    handler() {
      const previous = pinnedSessionId
      pinnedSessionId = undefined
      return {
        kind: 'success',
        text: previous === undefined
          ? '当前没有固定任何会话。'
          : '已清除固定，跟随你新开的会话或最近发过消息的会话。',
      }
    },
  })

  ctx.commands.register({
    name: 'annotate-status',
    description: '查看浏览器标注当前会进入哪个会话。',
    handler() {
      const draft = config.preferDraft ? newestDraft() : undefined
      let target: string
      try {
        target = resolveTarget()
      } catch (error) {
        target = `无 — ${error instanceof Error ? error.message : String(error)}`
      }
      return {
        kind: 'success',
        text: [
          `扩展：${bridge.connected ? `已连接（${bridge.extensionId}）` : '未连接'}`,
          `已固定：${pinnedSessionId ?? '—'}`,
          `最近活跃：${lastActiveSessionId ?? '—'}`,
          `新会话草稿：${draft?.id ?? '—'}`,
          `目标会话：${target}`,
        ].join('\n'),
      }
    },
  })
}
