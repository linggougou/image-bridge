---
name: image-bridge
description: Generate an image through the local image-bridge Chrome extension backend and attach the resulting PNG to Multica. Use when a Multica issue or comment explicitly asks to generate, create, or render an image with image-bridge.
---

# Image Bridge

Use the local `image-bridge` CLI as the only generation entry point. Do not use
Codex built-in image generation, Gemini API keys, ChatGPT API keys, or FlowWeave.

The CLI is machine-oriented: stdout contains exactly one JSON object. Treat a
nonzero exit code or `ok: false` as failure and report the structured error.

## Resolve The CLI

Resolve the command before doing any work:

```bash
if [ -n "${IMAGE_BRIDGE_CLI:-}" ]; then
  image_bridge() { "${IMAGE_BRIDGE_NODE:-node}" "$IMAGE_BRIDGE_CLI" "$@"; }
elif command -v image-bridge >/dev/null 2>&1; then
  image_bridge() { image-bridge "$@"; }
else
  echo "image-bridge CLI is unavailable; set IMAGE_BRIDGE_CLI or install the package binary." >&2
  exit 1
fi
```

`IMAGE_BRIDGE_BACKEND` should be set to `chrome-extension` for this skill. Do not
guess a repository path or depend on a developer-machine absolute path.

## Check readiness

```bash
image_bridge status --backend "${IMAGE_BRIDGE_BACKEND:-chrome-extension}"
```

If `authenticated` is false, do not automate login or bypass a security check.
Report that a human must start the bridge, open the dedicated ChatGPT tab in
normal Chrome, and complete login manually:

```bash
image_bridge bridge
```

## Generate

1. Create a unique output path inside the current Multica workspace, for example
   `outputs/image-bridge-$(date +%Y%m%d-%H%M%S).png`.
2. Run:

```bash
image_bridge generate \
  --backend "${IMAGE_BRIDGE_BACKEND:-chrome-extension}" \
  --prompt "<prompt from the issue>" \
  --output "<workspace-relative-output-path>"
```

## Reference Images

When the issue or triggering comment contains image attachments, materialize
each attachment locally through Multica's supported attachment download
mechanism. Do not scrape rendered image URLs from the issue HTML.

Pass every downloaded image to the CLI with a repeated `--input` argument:

```bash
image_bridge generate \
  --backend "${IMAGE_BRIDGE_BACKEND:-chrome-extension}" \
  --input "<local-reference-1>" \
  --input "<local-reference-2>" \
  --prompt "<prompt from the issue>" \
  --output "<workspace-relative-output-path>"
```

Support up to 4 reference images total. Accept only PNG, JPEG, WebP, or GIF,
with at most 8 MiB per image and 20 MiB total. If any attachment cannot be
downloaded or validated, fail explicitly instead of generating without it.

3. Parse the one-line JSON result.
4. On success, attach the returned absolute `outputPath` to the issue or reply
   comment with `multica issue comment add ... --attachment <outputPath>`.
5. On failure, do not claim an image was generated. Surface the CLI error code
   and message, especially `NOT_AUTHENTICATED`, `SESSION_EXPIRED`,
   `BROWSER_FAILED`, `TIMEOUT`, `IMAGE_NOT_FOUND`, and
   `IMAGE_RETRIEVAL_FAILED`.

Never reproduce browser selectors or Playwright automation in this skill.
