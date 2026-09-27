/** Browser bridge protocol and model-facing annotation rendering. */

/** Captured facts for one selected DOM element. */
export interface ElementAnnotation {
  selector: string
  tagName: string
  id?: string
  classes: string[]
  text: string
  comment: string
  rect: { x: number; y: number; width: number; height: number }
  attributes: Record<string, string>
  styles: Record<string, string>
  accessibility: { role?: string; name?: string; focusable: boolean; disabled: boolean }
}

/** Complete annotation submission from the browser extension. */
export interface AnnotationResult {
  url: string
  viewport: { width: number; height: number }
  elements: ElementAnnotation[]
  screenshotDataUrl?: string
}

export type ClientMessage =
  | { type: 'hello'; version: 1; extensionId: string }
  | { type: 'result'; requestId: string; result: AnnotationResult }
  | { type: 'cancel'; requestId: string }
  | { type: 'error'; requestId: string; message: string }
  /** Unsolicited submission: the user started annotating from the browser. */
  | { type: 'submit'; result: AnnotationResult }

/** Host-to-extension frames. */
export type ServerMessage =
  | { type: 'start'; requestId: string; url?: string }
  | { type: 'ack'; ok: boolean; elements?: number; sessionId?: string; message?: string }

/** Decode and minimally validate one browser message. */
export function parseClientMessage(data: Buffer, maxPayloadBytes: number): ClientMessage {
  if (data.byteLength > maxPayloadBytes) throw new Error('browser annotation payload is too large')
  const parsed: unknown = JSON.parse(data.toString('utf8'))
  if (typeof parsed !== 'object' || parsed === null || !('type' in parsed)) {
    throw new Error('browser annotation message must be an object')
  }
  const message = parsed as Record<string, unknown>
  if (message.type === 'hello' && message.version === 1 && typeof message.extensionId === 'string') {
    return message as ClientMessage
  }
  if ((message.type === 'cancel' || message.type === 'error') && typeof message.requestId === 'string') {
    if (message.type === 'error' && typeof message.message !== 'string') throw new Error('browser error message is invalid')
    return message as ClientMessage
  }
  if (message.type === 'result' && typeof message.requestId === 'string' && isAnnotationResult(message.result)) {
    return message as unknown as ClientMessage
  }
  if (message.type === 'submit' && isAnnotationResult(message.result)) {
    return message as unknown as ClientMessage
  }
  throw new Error('browser annotation message has an unsupported format')
}

function isAnnotationResult(value: unknown): value is AnnotationResult {
  if (typeof value !== 'object' || value === null) return false
  const result = value as Record<string, unknown>
  return typeof result.url === 'string'
    && isViewport(result.viewport)
    && Array.isArray(result.elements)
    && result.elements.every(isElementAnnotation)
    && (result.screenshotDataUrl === undefined || typeof result.screenshotDataUrl === 'string')
}

function isViewport(value: unknown): value is AnnotationResult['viewport'] {
  if (typeof value !== 'object' || value === null) return false
  const viewport = value as Record<string, unknown>
  return isFiniteNumber(viewport.width) && isFiniteNumber(viewport.height)
}

function isElementAnnotation(value: unknown): value is ElementAnnotation {
  if (typeof value !== 'object' || value === null) return false
  const element = value as Record<string, unknown>
  return typeof element.selector === 'string'
    && typeof element.tagName === 'string'
    && (element.id === undefined || typeof element.id === 'string')
    && Array.isArray(element.classes)
    && element.classes.every(item => typeof item === 'string')
    && typeof element.text === 'string'
    && typeof element.comment === 'string'
    && isRect(element.rect)
    && isStringRecord(element.attributes)
    && isStringRecord(element.styles)
    && isAccessibility(element.accessibility)
}

function isRect(value: unknown): value is ElementAnnotation['rect'] {
  if (typeof value !== 'object' || value === null) return false
  const rect = value as Record<string, unknown>
  return isFiniteNumber(rect.x)
    && isFiniteNumber(rect.y)
    && isFiniteNumber(rect.width)
    && isFiniteNumber(rect.height)
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return typeof value === 'object'
    && value !== null
    && !Array.isArray(value)
    && Object.values(value).every(item => typeof item === 'string')
}

function isAccessibility(value: unknown): value is ElementAnnotation['accessibility'] {
  if (typeof value !== 'object' || value === null) return false
  const accessibility = value as Record<string, unknown>
  return (accessibility.role === undefined || typeof accessibility.role === 'string')
    && (accessibility.name === undefined || typeof accessibility.name === 'string')
    && typeof accessibility.focusable === 'boolean'
    && typeof accessibility.disabled === 'boolean'
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

/** Decode a PNG data URL without accepting arbitrary media. */
export function decodePngDataUrl(value: string): Uint8Array {
  const prefix = 'data:image/png;base64,'
  if (!value.startsWith(prefix)) throw new Error('browser screenshot must be a PNG data URL')
  const data = Buffer.from(value.slice(prefix.length), 'base64')
  if (data.byteLength === 0) throw new Error('browser screenshot is empty')
  return new Uint8Array(data)
}

/** Render annotations as precise model-facing text. */
export function renderAnnotation(result: AnnotationResult): string {
  const lines = [
    `## Page annotation: ${result.url}`,
    `Viewport: ${result.viewport.width}x${result.viewport.height}`,
    '',
  ]

  result.elements.forEach((element, index) => {
    lines.push(`### ${index + 1}. ${element.selector}`)
    lines.push(`- Element: ${element.tagName}`)
    lines.push(`- Text: ${JSON.stringify(element.text)}`)
    lines.push(`- Bounds: ${element.rect.width}x${element.rect.height} at (${element.rect.x}, ${element.rect.y})`)
    if (element.id !== undefined) lines.push(`- ID: ${element.id}`)
    if (element.classes.length > 0) lines.push(`- Classes: ${element.classes.join(', ')}`)
    if (Object.keys(element.attributes).length > 0) lines.push(`- Attributes: ${JSON.stringify(element.attributes)}`)
    if (Object.keys(element.styles).length > 0) lines.push(`- Styles: ${JSON.stringify(element.styles)}`)
    lines.push(`- Accessibility: ${JSON.stringify(element.accessibility)}`)
    lines.push(`- Comment: ${element.comment}`)
    lines.push('')
  })
  return lines.join('\n').trim()
}
