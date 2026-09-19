# Image Bridge Chrome Extension

This unpacked Manifest V3 extension connects one explicitly designated
`chatgpt.com` tab in normal Chrome to the local `image-bridge` daemon.

## Install

1. Start the bridge:

   ```bash
   node dist/cli.js bridge
   ```

2. Read the local bridge token:

   ```bash
   node dist/cli.js bridge token
   ```

3. Open `chrome://extensions`.
4. Enable Developer mode.
5. Choose `Load unpacked`.
6. Select this `extension/` directory.
7. Open the extension settings.
8. Set the bridge URL to `http://127.0.0.1:47831`.
9. Paste the bridge token and save.
10. Click `打开专用 ChatGPT 标签页`.
11. Log in to ChatGPT normally in that tab.

The extension only polls jobs when the marked dedicated tab reports readiness.
It does not read cookies, passwords, browser history, or unrelated ChatGPT
tabs. If ChatGPT presents a human challenge, the job fails with
`HUMAN_VERIFICATION_REQUIRED` and no attempt is made to bypass it.

## Content Scripts

`manifest.json` loads two content scripts:

- `chatgpt-main-world.js` runs in the page `MAIN` world at `document_start`.
  It marks the document with `data-image-bridge-main-world` and answers
  attachment requests posted from the isolated content script.
- `content-core.js` and `chatgpt-content.js` run in the isolated world at
  `document_idle`. They own job execution, prompt submission, and result
  retrieval.

The page `MAIN` world is necessary because the composer's file input lives on
the ChatGPT page, and only page-world JavaScript can build the `File` objects
and dispatch the `input` / `change` events against that input reliably. The
isolated content script forwards the decoded reference files with
`window.postMessage` and waits for the page world's result.

## Reference Images

Jobs may include up to four reference images. The page-world script appends
them to the composer's file input through a `DataTransfer`, dispatches `input`
and `change`, and reports success only once the file input and the visible
attachment previews both reflect every requested image. The isolated content
script keeps an equivalent fallback path for pages where the page-world bridge
is unavailable.

If the upload UI cannot be confirmed, the job fails with
`REFERENCE_IMAGE_UPLOAD_FAILED` without sending a partial prompt.
