import { describe, expect, it } from 'vitest'
import { decodePngDataUrl, parseClientMessage, renderAnnotation } from '../src/protocol.js'

describe('annotation protocol', () => {
  it('validates hello and result messages', () => {
    expect(parseClientMessage(Buffer.from(JSON.stringify({
      type: 'hello', version: 1, extensionId: 'abc',
    })), 1_000)).toEqual({ type: 'hello', version: 1, extensionId: 'abc' })

    expect(() => parseClientMessage(Buffer.from('{}'), 1_000)).toThrow('must be an object')
    expect(() => parseClientMessage(Buffer.alloc(10), 5)).toThrow('too large')
    expect(() => parseClientMessage(Buffer.from(JSON.stringify({
      type: 'result',
      requestId: 'request-1',
      result: {
        url: 'https://example.com',
        viewport: { width: 1280, height: 720 },
        elements: [{ selector: '#submit', comment: 'Missing the remaining captured facts.' }],
      },
    })), 1_000)).toThrow('unsupported format')
  })

  it('decodes only non-empty PNG data URLs', () => {
    expect(decodePngDataUrl('data:image/png;base64,AQID')).toEqual(Uint8Array.from([1, 2, 3]))
    expect(() => decodePngDataUrl('data:image/jpeg;base64,AQID')).toThrow('PNG')
  })

  it('renders element facts and comments', () => {
    const text = renderAnnotation({
      url: 'https://example.com',
      viewport: { width: 1280, height: 720 },
      elements: [{
        selector: '#submit',
        tagName: 'button',
        id: 'submit',
        classes: ['primary'],
        text: 'Submit',
        comment: 'Use the accent color.',
        rect: { x: 10, y: 20, width: 100, height: 40 },
        attributes: { type: 'submit' },
        styles: { color: 'rgb(0, 0, 0)' },
        accessibility: { role: 'button', name: 'Submit', focusable: true, disabled: false },
      }],
    })
    expect(text).toContain('### 1. #submit')
    expect(text).toContain('Use the accent color.')
  })
})
