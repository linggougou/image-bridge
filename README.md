# image-bridge

`image-bridge` is a local CLI for generating images through a manually
authenticated Gemini session, a Playwright ChatGPT session, or a dedicated
ChatGPT tab in normal Chrome through a local extension bridge.

The repository stays independent from FlowWeave. FlowWeave remains a reference
for browser automation patterns, not a runtime dependency.

## Requirements

- Node.js 20 or newer
- Google Chrome (recommended) or Microsoft Edge
- An account that can generate images in the selected web application

## Install

```bash
npm install
npm run build
```

The CLI uses system Google Chrome by default. To use Playwright-bundled
Chromium instead, run `npx playwright install chromium` and set
`IMAGE_BRIDGE_BROWSER_CHANNEL=bundled`.

## Backends

Gemini remains the compatibility default:

```bash
node dist/cli.js status
```

Select ChatGPT explicitly:

```bash
node dist/cli.js status --backend chatgpt
```

You can also select the backend through the environment:

```bash
IMAGE_BRIDGE_BACKEND=chatgpt node dist/cli.js status
```

Supported backend values are `gemini`, `chatgpt`, and `chrome-extension`.
Playwright backends use separate persistent browser profiles:

```text
~/.image-bridge/chrome-profile/gemini
~/.image-bridge/chrome-profile/chatgpt
~/.image-bridge/chrome-extension
```

The `chrome-extension` backend does not launch Playwright or control Chrome. It
uses a loopback service plus a Manifest V3 extension running in your normal
Chrome session.

## One-Time Login

Gemini:

```bash
node dist/cli.js login --backend gemini
```

ChatGPT:

```bash
node dist/cli.js login --backend chatgpt
```

Chrome extension bridge:

```bash
node dist/cli.js bridge
```

The command opens a headed browser using the selected backend profile. Complete
the provider's login manually. The command exits after the authenticated prompt
composer appears. Credentials, CAPTCHA challenges, and browser safety checks are
never automated or bypassed.

## Check Status

```bash
node dist/cli.js status --backend chatgpt
```

Example:

```json
{
  "ok": true,
  "command": "status",
  "backend": "chatgpt",
  "authenticated": true,
  "url": "https://chatgpt.com/",
  "profileDir": "/Users/example/.image-bridge/chrome-profile/chatgpt"
}
```

An unauthenticated status result exits with code `2` and reports
`"authenticated": false`.

## Normal Chrome Extension Bridge

Start the local bridge:

```bash
node dist/cli.js bridge
```

Get the bridge token for extension setup:

```bash
node dist/cli.js bridge token
```

Load the extension from the repository's `extension/` directory:

1. Open `chrome://extensions`.
2. Enable Developer mode.
3. Choose `Load unpacked`.
4. Select the repository's `extension/` directory.
5. Open the extension settings.
6. Set the bridge URL to `http://127.0.0.1:47831`.
7. Paste the token from `bridge token`.
8. Click `打开专用 ChatGPT 标签页`.
9. Sign in to ChatGPT normally in that tab.

The extension only polls jobs from the explicitly marked dedicated tab. It does
not read cookies or browser storage, and it stops with
`HUMAN_VERIFICATION_REQUIRED` if ChatGPT presents a human check.

Check readiness:

```bash
node dist/cli.js status --backend chrome-extension
```

Generate:

```bash
node dist/cli.js generate \
  --backend chrome-extension \
  --prompt "A calm green leaf icon on a white background, no text" \
  --output outputs/leaf.png
```

## Generate An Image

ChatGPT backend:

```bash
node dist/cli.js generate \
  --backend chatgpt \
  --prompt "A calm green leaf icon on a white background, no text" \
  --output outputs/leaf.png
```

Gemini backend:

```bash
node dist/cli.js generate \
  --backend gemini \
  --prompt "A calm green leaf icon on a white background, no text" \
  --output outputs/leaf.png
```

Use `--headed` when the provider needs a visible browser or when debugging its
current page structure:

```bash
node dist/cli.js generate \
  --backend chatgpt \
  --prompt "..." \
  --output outputs/leaf.png \
  --headed
```

Use `--force` only when intentionally replacing the exact output path:

```bash
node dist/cli.js generate \
  --backend chatgpt \
  --prompt "..." \
  --output outputs/leaf.png \
  --force
```

Successful generation emits one JSON object:

```json
{
  "ok": true,
  "command": "generate",
  "outputPath": "/workspace/image-bridge/outputs/leaf.png",
  "mimeType": "image/png",
  "bytes": 123456,
  "retrieval": "download",
  "prompt": "A calm green leaf icon on a white background, no text",
  "modelUrl": "https://chatgpt.com/"
}
```

Stdout is machine-readable. Login and diagnostic guidance go to stderr.

## Reference Images

Reference images are supported by the `chrome-extension` backend. Pass one or
more with repeated `--input` flags:

```bash
node dist/cli.js generate \
  --backend chrome-extension \
  --input outputs/ref-1.png \
  --input outputs/ref-2.jpg \
  --prompt "Use the first image as the subject and the second image for its color palette" \
  --output outputs/result.png
```

Limits:

- Up to 4 reference images per request.
- PNG, JPEG, WebP, or GIF.
- Up to 8 MiB per image and 20 MiB total decoded input.

The CLI validates files before submitting a job. Reference jobs always start
from a clean conversation: if the dedicated tab already holds prior turns, the
extension opens a new chat first, so stale context cannot dominate the new
reference and attachment evidence stays attributable to this job.

Visible composer confirmation is only a pre-submit readiness check. After
submission, the newly created user turn must show exactly the expected number
of attachments; one attachment unit per reference, counted without
double-counting a container and its inner image. If readiness or post-submit
verification fails, the job terminates with `REFERENCE_IMAGE_UPLOAD_FAILED` or
`REFERENCE_IMAGE_NOT_SUBMITTED`. It never falls back to generating without the
references.

Gemini and the Playwright ChatGPT backend remain text-only. Supplying `--input`
to those backends returns `UNSUPPORTED_INPUT` instead of silently ignoring the
reference images.

## Configuration

| Variable | Default |
| --- | --- |
| `IMAGE_BRIDGE_HOME` | `~/.image-bridge` |
| `IMAGE_BRIDGE_BACKEND` | `gemini` (`gemini` or `chatgpt`) |
| `IMAGE_BRIDGE_PROFILE_DIR` | Legacy Gemini profile override |
| `IMAGE_BRIDGE_GEMINI_PROFILE_DIR` | `$IMAGE_BRIDGE_HOME/chrome-profile/gemini` |
| `IMAGE_BRIDGE_CHATGPT_PROFILE_DIR` | `$IMAGE_BRIDGE_HOME/chrome-profile/chatgpt` |
| `IMAGE_BRIDGE_EXTENSION_DIR` | `$IMAGE_BRIDGE_HOME/chrome-extension` |
| `IMAGE_BRIDGE_EXTENSION_HOST` | `127.0.0.1` |
| `IMAGE_BRIDGE_EXTENSION_PORT` | `47831` |
| `IMAGE_BRIDGE_EXTENSION_TOKEN_PATH` | `$IMAGE_BRIDGE_HOME/extension-bridge-token` |
| `IMAGE_BRIDGE_EXTENSION_JOB_TIMEOUT_MS` | `300000` |
| `IMAGE_BRIDGE_OUTPUT_DIR` | `<current directory>/outputs` |
| `IMAGE_BRIDGE_TIMEOUT_MS` | `180000` |
| `IMAGE_BRIDGE_NAVIGATION_TIMEOUT_MS` | `45000` |
| `IMAGE_BRIDGE_LOGIN_TIMEOUT_MS` | `300000` |
| `IMAGE_BRIDGE_HEADLESS` | `true` |
| `IMAGE_BRIDGE_BROWSER_CHANNEL` | `chrome` (`chrome`, `msedge`, or `bundled`) |
| `GEMINI_WEB_URL` | `https://gemini.google.com/app` |
| `CHATGPT_WEB_URL` | `https://chatgpt.com/` |

`IMAGE_BRIDGE_GEMINI_PROFILE_DIR` and
`IMAGE_BRIDGE_CHATGPT_PROFILE_DIR` take precedence for their backend. The
generic `IMAGE_BRIDGE_PROFILE_DIR` is retained only as a Gemini compatibility
override. ChatGPT always uses either `IMAGE_BRIDGE_CHATGPT_PROFILE_DIR` or its
dedicated default profile, so the two backends cannot accidentally share a
profile.

## Failure Contract

Failures use a stable JSON shape and a nonzero exit code:

```json
{
  "ok": false,
  "command": "generate",
  "error": {
    "code": "NOT_AUTHENTICATED",
    "message": "ChatGPT 登录态不可用，请先运行 image-bridge login --backend chatgpt。"
  }
}
```

Important codes include:

- `INVALID_ARGUMENT`
- `NOT_AUTHENTICATED`
- `SESSION_EXPIRED`
- `TIMEOUT`
- `UI_CHANGED`
- `IMAGE_NOT_FOUND`
- `IMAGE_RETRIEVAL_FAILED`
- `OUTPUT_EXISTS`
- `BROWSER_FAILED`
- `BRIDGE_UNAVAILABLE`
- `EXTENSION_UNAVAILABLE`
- `TAB_NOT_READY`
- `PROTOCOL_ERROR`
- `UNSUPPORTED_INPUT`
- `REFERENCE_IMAGE_UPLOAD_FAILED`
- `REFERENCE_IMAGE_NOT_SUBMITTED`

If a session expires, run the matching `login --backend ...` command again. The
CLI never attempts to bypass sign-in, CAPTCHA, account checks, or other browser
safety controls.

## Multica

The repository includes a thin Multica skill at:

```text
skills/image-bridge/SKILL.md
```

The skill calls the built CLI, parses its one-line JSON, and attaches the
returned `outputPath` to the relevant Multica issue or reply. It defaults to the
`chrome-extension` backend, does not reimplement browser automation, and does not
use Codex built-in image generation.

Create or update the workspace skill with the Multica CLI:

```bash
multica skill create \
  --name image-bridge \
  --description "Generate images through the local image-bridge CLI" \
  --content-file skills/image-bridge/SKILL.md
```

Assign it to an agent only after the agent runtime can access the built CLI path
documented in the skill.

## Development

```bash
npm test
npm run typecheck
npm run build
```

Automated tests use synthetic ChatGPT and Gemini pages and do not require a real
account or network access. Live smoke tests are manual because both web UIs are
private, changeable interfaces rather than stable public APIs.

## Scope

This repository does not use the Gemini API, ChatGPT API, Codex built-in image
generation, or FlowWeave as a dependency. It automates only the user's manually
authenticated web sessions through narrow, backend-specific modules.
