# dsh Browser Control Extension (Chrome MV3)

English | [中文](README.zh.md)

The **browser-operation end** of dsh: the model reads and operates the browser page you have open — extract content, click elements, fill forms, scroll, and navigate, all in the real page with your login state preserved. The side panel is the conversation entry.

**Text-only mode**: DeepSeek models cannot see images, so the page is rendered as structured text (a numbered interactive-element inventory) and the model addresses elements by number; the pipeline deliberately never produces images.

## What the model can do

| Capability | Action | Notes |
|---|---|---|
| Read page | `browser_snapshot` | Title/URL/main text/numbered inventory/form fields (sensitive values masked); `delta: true` returns only changes |
| Click element | `browser_click` | Click by inventory number (links/buttons/checkboxes…), React/Vue compatible |
| Fill forms | `browser_type` | Type text; `replace` clears first |
| Keys | `browser_press` | Enter/Tab/Escape/arrows etc. |
| Scroll | `browser_scroll` | Viewport scrolling (up/down/top/bottom) |
| Navigate | `browser_navigate` / `back` / `forward` / `reload` | In-tab navigation, login state preserved |
| Read region | `browser_get_text` | Lazy-loaded content / partial text |
| Wait | `browser_wait` | Page load and render-settle detection |

## Architecture

```
side panel (React) ◄─port─► background SW ◄─WS─► dsh bridge plugin
                                 │
                  tabs.sendMessage (DSH_ACTION)
                                 ▼
                        content script (snapshot/actions/privacy)
```

- **background** (`src/background/`): bridge connection (token auth + exponential-backoff reconnect + keepalive), gateway RPC client, **tool dispatch to the active tab**.
- **content script** (`src/content/`): text-only snapshot (readability main text + numbered interactive inventory + form fields), **stable element numbers** (`data-dsh-el`), delta changes, click/type/press/scroll/navigate actions, sensitive-field masking.
- **panel** (`src/panel/`): React conversation UI (session list/history/live events/settings); messages render as Markdown (headings/lists/code blocks/tables, sanitized).
- **Protocol**: `protocol.ts` in the `@deepseek-ai/dsh-bridge-browser` plugin is the single source of truth, shared by both ends (tsconfig paths point at the plugin source).

## Build

```sh
pnpm install                 # in this directory (standalone workspace)
pnpm run build               # outputs dist/
pnpm run test                # unit tests
```

## Install and use

1. **Start dsh with the bridge plugin mounted** (in the host SDK checkout):

   ```sh
   dsh web --config <dsh-browser>/examples/browser-bridge.cordis.yml
   ```

   The boot log prints `browser bridge: new token generated and persisted at ~/.dsh/ext-bridge-token`.

2. **Load the extension**: Chrome → `chrome://extensions` → Developer mode → Load unpacked → select this directory's `dist/`.

3. **Configure**: click the extension icon to open the side panel → Settings → paste the Token (from the boot log or `~/.dsh/ext-bridge-token`) → save and connect.

4. **Use**: chat in the side panel. The model reads the current page via `browser_snapshot` (numbered inventory) and operates page elements directly with `browser_click`/`browser_type`/`browser_scroll` etc. The toolbar's "read page" button makes the model look at the current page first.

## Why text-only

- **Snapshot as the view**: the model's entire view of the page is structured text (title/URL/main/numbered elements/forms), budgeted at 12k chars (plugin-configurable, negotiated to the extension via `hello.ok`).
- **Stable numbering**: element numbers persist across snapshots (WeakMap + `data-dsh-el`), so the model can say "click 7"; a large page change explicitly reports "numbers reindexed".
- **Delta mode**: `browser_snapshot({delta:true})` returns only changed element numbers, saving tokens.
- **Privacy**: password/credit-card values always render as `••••` and never leave the page; accessible names never use a sensitive field's current value.

## Permissions

`sidePanel` (sidebar), `storage` (settings), `tabs` + `activeTab` + `scripting` (inject/message the active tab), `alarms` (SW keepalive), `http/https` (content-script injection everywhere). Only the **active tab** of the last-focused window is ever operated; the extension never switches tabs silently.

## Known limitations

- Only one extension connection at a time (a second window replaces the first).
- Cross-origin iframes are counted but not operated.
- Captcha/image-only controls cannot be handled — the tool result reports "elements with no accessible name" and asks the user to complete that step manually.
- No automatic token rotation.
