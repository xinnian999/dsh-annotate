# dsh-annotate

Visual browser feedback for DeepSeek Harness. `/annotate` asks the companion Chrome extension to enter selection mode; each selected element contributes a selector, DOM facts, computed style highlights, accessibility data, a comment, and an optional viewport screenshot to the agent's next turn.

## Install

Add the plugin project to a Harness profile:

```sh
dsh plugin --profile demo add ./dsh-annotate
```

Then install the companion extension:

1. Open `chrome://extensions` in Chrome or Chromium.
2. Enable **Developer mode**.
3. Choose **Load unpacked** and select this project's `browser-extension` directory.
4. Open the extension popup and keep the default bridge endpoint.

For tighter local authorization, copy the extension ID shown in the popup into `allowedExtensionId` in a later Harness patch layer.

## Use

```text
/annotate
/annotate http://localhost:3000
```

Click an element, enter its comment, and repeat as needed. **Submit** sends all captured facts and the visible-tab screenshot to the agent. **Escape** cancels.

## Configure

```yaml
- id: dsh-annotate
  name: dsh-annotate
  config:
    host: 127.0.0.1
    port: 43119
    allowedExtensionId: abcdefghijklmnopqrstuvwxyzabcdef
    requestTimeoutMs: 300000
    maxPayloadBytes: 16777216
    includeScreenshot: true
```

The server refuses non-loopback hosts and browser connections whose origin is not `chrome-extension://`. An empty `allowedExtensionId` accepts any locally installed Chrome extension; set the exact ID for stricter isolation.

## Develop

```sh
pnpm install
pnpm run check
```

Reload the unpacked browser extension after editing its files.

## Scope

Version 0.1 targets one local Chrome/Chromium browser, one active tab, and visible-viewport screenshots. Remote browsers, full-page capture, edit recording, and inline draggable note cards are deferred.

## License

MIT

## Credits

The interaction is inspired by [`pi-annotate`](https://github.com/nicobailon/pi-annotate). This implementation is built around Harness's human-command, attachment, and Agent APIs and uses a small loopback WebSocket bridge instead of a native-messaging host.
