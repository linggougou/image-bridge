import { readFile } from "node:fs/promises";

import { chromium } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

let browser: Awaited<ReturnType<typeof chromium.launch>>;

beforeAll(async () => {
  browser = await chromium.launch({ headless: true });
});

afterAll(async () => {
  await browser?.close();
});

async function loadExtensionPage(body: string, script = "", mainWorld = false) {
  const page = await browser.newPage();
  await page.addInitScript(() => {
    globalThis.__bridgeMessages = [];
    globalThis.__bridgeListener = null;
    globalThis.chrome = {
      storage: {
        local: {
          __data: {},
          async get(key) {
            return { [key]: this.__data[key] };
          },
          async set(items) {
            Object.assign(this.__data, items);
          },
          async remove(key) {
            delete this.__data[key];
          },
        },
      },
      runtime: {
        sendMessage(message) {
          globalThis.__bridgeMessages.push(message);
          return Promise.resolve({ ok: true });
        },
        onMessage: {
          addListener(listener) {
            globalThis.__bridgeListener = listener;
          },
        },
      },
    };
  });
  await page.route("https://chatgpt.com/**", async (route) => {
    await route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><meta charset="utf-8">${body}<script>${script}</script>`,
    });
  });
  await page.goto("https://chatgpt.com/?image-bridge=1");
  if (mainWorld) {
    const mainWorldPath = new URL("../extension/chatgpt-main-world.js", import.meta.url).pathname;
    await page.addScriptTag({ content: await readFile(mainWorldPath, "utf8") });
  }
  const corePath = new URL("../extension/content-core.js", import.meta.url).pathname;
  const contentPath = new URL("../extension/chatgpt-content.js", import.meta.url).pathname;
  await page.addScriptTag({ content: await readFile(corePath, "utf8") });
  await page.addScriptTag({ content: await readFile(contentPath, "utf8") });
  return page;
}

async function executeThroughContentScript(
  page: import("playwright").Page,
  prompt: string,
  inputs: Array<{ name: string; mimeType: string; byteLength: number; bytesBase64: string }> = [],
  timeoutMs = 5_000,
) {
  return page.evaluate(
    async ({ prompt, inputs, timeoutMs }) =>
      await new Promise((resolve) => {
        const listener = globalThis.__bridgeListener;
        if (!listener) throw new Error("content script listener missing");
        listener({ type: "executeJob", job: { prompt, inputs, timeoutMs } }, {}, resolve);
      }),
    { prompt, inputs, timeoutMs },
  );
}

const composer = `
  <form id="composer-form">
    <div id="prompt-textarea" contenteditable="true" role="textbox"></div>
    <input id="text-file-input" type="file" accept=".pdf" />
    <input id="file-input" type="file" accept="image/*" multiple />
    <div id="attachments"></div>
    <button id="composer-submit-button" type="button">Send</button>
  </form>
`;

const pngBase64 = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString(
  "base64",
);

describe("Chrome extension content script", () => {
  it("authenticates, ignores stale images, and returns the new assistant image", async () => {
    const page = await loadExtensionPage(
      `<main>${composer}<section id="thread">
        <article data-testid="conversation-turn-1">
          <div data-message-author-role="assistant"><img id="old-image" alt="old"></div>
        </article>
      </section></main>`,
      `
        const canvas = document.createElement('canvas');
        canvas.width = 256; canvas.height = 256;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#2f7d5c'; ctx.fillRect(0, 0, 256, 256);
        const dataUrl = canvas.toDataURL('image/png');
        document.querySelector('#old-image').src = dataUrl;
        document.querySelector('#composer-submit-button').addEventListener('click', () => {
          const turn = document.createElement('article');
          turn.dataset.testid = 'conversation-turn-2';
          const message = document.createElement('div');
          message.dataset.messageAuthorRole = 'assistant';
          const image = document.createElement('img');
          image.id = 'new-image'; image.src = dataUrl;
          message.appendChild(image); turn.appendChild(message);
          document.querySelector('#thread').appendChild(turn);
        });
      `,
    );

    const result = (await executeThroughContentScript(page, "draw a leaf")) as {
      ok: boolean;
      bytesBase64: string;
    };
    expect(result.ok).toBe(true);
    expect(result.bytesBase64.length).toBeGreaterThan(0);
    expect(
      await page.evaluate(
        () => globalThis.ImageBridgeContentCore.findGeneratedImage(
          globalThis.ImageBridgeContentCore.latestAssistantTurn(),
        ).id,
      ),
    ).toBe("new-image");
    await page.close();
  });

  it("rejects a logged-out page", async () => {
    const page = await loadExtensionPage(
      `<main><button>Log in</button>${composer}</main>`,
    );
    expect(
      await page.evaluate(() => globalThis.ImageBridgeContentCore.isAuthenticated()),
    ).toBe(false);
    const result = (await executeThroughContentScript(page, "test")) as {
      ok: boolean;
      error: { code: string };
    };
    expect(result).toMatchObject({ ok: false, error: { code: "NOT_AUTHENTICATED" } });
    await page.close();
  });

  it("maps session expiry to SESSION_EXPIRED", async () => {
    const page = await loadExtensionPage(
      `<main>${composer}</main>`,
      `
        document.querySelector('#composer-submit-button').addEventListener('click', () => {
          setTimeout(() => { document.body.innerHTML = '<button>Log in</button>'; }, 200);
        });
      `,
    );
    const result = (await executeThroughContentScript(page, "test")) as {
      ok: boolean;
      error: { code: string };
    };
    expect(result).toMatchObject({ ok: false, error: { code: "SESSION_EXPIRED" } });
    await page.close();
  });

  it("fails safely when a human challenge appears", async () => {
    const page = await loadExtensionPage(
      `<main>${composer}</main>`,
      `
        document.querySelector('#composer-submit-button').addEventListener('click', () => {
          setTimeout(() => {
            const challenge = document.createElement('div');
            challenge.textContent = 'Verify you are human';
            document.body.appendChild(challenge);
          }, 200);
        });
      `,
    );
    const result = (await executeThroughContentScript(page, "test")) as {
      ok: boolean;
      error: { code: string; message: string };
    };
    expect(result).toMatchObject({ ok: false, error: { code: "BROWSER_FAILED" } });
    expect(result.error.message).toContain("manual human verification");
    await page.close();
  });

  it("attaches multiple reference images before submitting the prompt", async () => {
    const page = await loadExtensionPage(
      `<main>${composer}</main>`,
      `
        globalThis.__events = [];
        document.querySelector('#file-input').addEventListener('change', (event) => {
          globalThis.__events.push('attachments:' + event.target.files.length);
          const preview = document.createElement('div');
          for (const file of event.target.files) {
            const image = document.createElement('img');
            image.alt = 'Uploaded image';
            image.src = URL.createObjectURL(file);
            preview.appendChild(image);
          }
          document.querySelector('#attachments').appendChild(preview);
        });
        document.querySelector('#composer-submit-button').addEventListener('click', () => {
          globalThis.__events.push('send');
          const userTurn = document.createElement('article');
          userTurn.dataset.testid = 'conversation-turn-2';
          const userMessage = document.createElement('div');
          userMessage.dataset.messageAuthorRole = 'user';
          for (const file of document.querySelector('#file-input').files) {
            const attachment = document.createElement('div');
            attachment.dataset.testid = 'attachment-preview';
            const thumb = document.createElement('img');
            thumb.alt = 'Uploaded image';
            thumb.src = URL.createObjectURL(file);
            attachment.appendChild(thumb);
            userMessage.appendChild(attachment);
          }
          userTurn.appendChild(userMessage);
          document.body.appendChild(userTurn);

          const turn = document.createElement('article');
          turn.dataset.testid = 'conversation-turn-3';
          const message = document.createElement('div');
          message.dataset.messageAuthorRole = 'assistant';
          const image = document.createElement('img');
          image.id = 'new-image';
          image.src = 'data:image/png;base64,${pngBase64}';
          image.width = 256;
          image.height = 256;
          message.appendChild(image);
          turn.appendChild(message);
          document.body.appendChild(turn);
        });
      `,
    );

    const result = (await executeThroughContentScript(page, "use references", [
      { name: "one.png", mimeType: "image/png", byteLength: 8, bytesBase64: pngBase64 },
      { name: "two.png", mimeType: "image/png", byteLength: 8, bytesBase64: pngBase64 },
    ])) as { ok: boolean };
    expect(result.ok).toBe(true);
    expect(
      await page.evaluate(() => {
        const input = document.querySelector("#file-input");
        return {
          files: input.files.length,
          events: globalThis.__events,
        };
      }),
    ).toEqual({
      files: 2,
      events: ["attachments:2", "send"],
    });
    await page.close();
  });

  it("does not submit when reference attachment confirmation never appears", async () => {
    const page = await loadExtensionPage(
      `<main>${composer}</main>`,
      `
        globalThis.__sendCount = 0;
        document.querySelector('#composer-submit-button').addEventListener('click', () => {
          globalThis.__sendCount += 1;
        });
      `,
    );
    const result = (await executeThroughContentScript(
      page,
      "use reference",
      [{ name: "one.png", mimeType: "image/png", byteLength: 8, bytesBase64: pngBase64 }],
      500,
    )) as { ok: boolean; error: { code: string } };
    expect(result).toMatchObject({
      ok: false,
      error: { code: "REFERENCE_IMAGE_UPLOAD_FAILED" },
    });
    expect(await page.evaluate(() => globalThis.__sendCount)).toBe(0);
    await page.close();
  });

  it("does not treat a file-status element as an uploaded image preview", async () => {
    const page = await loadExtensionPage(
      `<main>${composer}<div id="file-status" data-testid="upload-file-status" style="display:none;width:40px;height:40px"></div></main>`,
      `
        globalThis.__sendCount = 0;
        document.querySelector('#file-input').addEventListener('change', () => {
          document.querySelector('#file-status').style.display = 'block';
        });
        document.querySelector('#composer-submit-button').addEventListener('click', () => {
          globalThis.__sendCount += 1;
        });
      `,
    );
    const result = (await executeThroughContentScript(
      page,
      "use reference",
      [{ name: "one.png", mimeType: "image/png", byteLength: 8, bytesBase64: pngBase64 }],
      500,
    )) as { ok: boolean; error: { code: string } };
    expect(result).toMatchObject({
      ok: false,
      error: { code: "REFERENCE_IMAGE_UPLOAD_FAILED" },
    });
    expect(await page.evaluate(() => globalThis.__sendCount)).toBe(0);
    await page.close();
  });

  it("attaches references through the ChatGPT page main-world bridge", async () => {
    const page = await loadExtensionPage(
      `<main>${composer}</main>`,
      `
        globalThis.__events = [];
        document.querySelector('#file-input').addEventListener('change', (event) => {
          globalThis.__events.push('attachments:' + event.target.files.length);
          const preview = document.createElement('div');
          for (const file of event.target.files) {
            const image = document.createElement('img');
            image.alt = 'Uploaded image';
            image.src = URL.createObjectURL(file);
            preview.appendChild(image);
          }
          document.querySelector('#attachments').appendChild(preview);
        });
        document.querySelector('#composer-submit-button').addEventListener('click', () => {
          globalThis.__events.push('send');
          const userTurn = document.createElement('article');
          userTurn.dataset.testid = 'conversation-turn-2';
          const userMessage = document.createElement('div');
          userMessage.dataset.messageAuthorRole = 'user';
          for (const file of document.querySelector('#file-input').files) {
            const attachment = document.createElement('div');
            attachment.dataset.testid = 'attachment-preview';
            const thumb = document.createElement('img');
            thumb.alt = 'Uploaded image';
            thumb.src = URL.createObjectURL(file);
            attachment.appendChild(thumb);
            userMessage.appendChild(attachment);
          }
          userTurn.appendChild(userMessage);
          document.body.appendChild(userTurn);

          const turn = document.createElement('article');
          turn.dataset.testid = 'conversation-turn-3';
          const message = document.createElement('div');
          message.dataset.messageAuthorRole = 'assistant';
          const image = document.createElement('img');
          image.id = 'new-image';
          image.src = 'data:image/png;base64,${pngBase64}';
          image.width = 256;
          image.height = 256;
          message.appendChild(image);
          turn.appendChild(message);
          document.body.appendChild(turn);
        });
      `,
      true,
    );

    const result = (await executeThroughContentScript(page, "use references", [
      { name: "one.png", mimeType: "image/png", byteLength: 8, bytesBase64: pngBase64 },
      { name: "two.png", mimeType: "image/png", byteLength: 8, bytesBase64: pngBase64 },
    ])) as { ok: boolean };
    expect(result.ok).toBe(true);
    expect(
      await page.evaluate(() => ({
        files: (document.querySelector("#file-input") as HTMLInputElement).files?.length,
        events: globalThis.__events,
      })),
    ).toEqual({
      files: 2,
      events: ["attachments:2", "send"],
    });
    await page.close();
  });
  it("fails when the submitted turn does not carry the reference attachment", async () => {
    const page = await loadExtensionPage(
      `<main>${composer}</main>`,
      `
        globalThis.__events = [];
        document.querySelector('#file-input').addEventListener('change', (event) => {
          const preview = document.createElement('div');
          for (const file of event.target.files) {
            const image = document.createElement('img');
            image.alt = 'Uploaded image';
            image.src = URL.createObjectURL(file);
            preview.appendChild(image);
          }
          document.querySelector('#attachments').appendChild(preview);
        });
        document.querySelector('#composer-submit-button').addEventListener('click', () => {
          globalThis.__events.push('send');
          const userTurn = document.createElement('article');
          userTurn.dataset.testid = 'conversation-turn-2';
          const userMessage = document.createElement('div');
          userMessage.dataset.messageAuthorRole = 'user';
          userMessage.textContent = 'use reference';
          userTurn.appendChild(userMessage);
          document.body.appendChild(userTurn);
          const turn = document.createElement('article');
          turn.dataset.testid = 'conversation-turn-3';
          const message = document.createElement('div');
          message.dataset.messageAuthorRole = 'assistant';
          const image = document.createElement('img');
          image.id = 'new-image';
          image.src = 'data:image/png;base64,${pngBase64}';
          image.width = 256;
          image.height = 256;
          message.appendChild(image);
          turn.appendChild(message);
          document.body.appendChild(turn);
        });
      `,
    );
    const result = (await executeThroughContentScript(
      page,
      "use reference",
      [{ name: "one.png", mimeType: "image/png", byteLength: 8, bytesBase64: pngBase64 }],
      600,
    )) as { ok: boolean; error: { code: string } };
    expect(result).toMatchObject({
      ok: false,
      error: { code: "REFERENCE_IMAGE_NOT_SUBMITTED" },
    });
    await page.close();
  });

  it("does not fall back to page-wide file inputs or previews", async () => {
    const page = await loadExtensionPage(
      `<main>
        <div id="composer-shell">
          <div id="prompt-textarea" contenteditable="true" role="textbox"></div>
          <button id="composer-submit-button" type="button">Send</button>
        </div>
        <div id="stale"><div data-testid="attachment-preview">
          <img alt="Uploaded image" src="blob:https://chatgpt.com/stale" />
        </div></div>
      </main>`,
      `globalThis.__sendCount = 0;
       document.querySelector('#composer-submit-button').addEventListener('click', () => {
         globalThis.__sendCount += 1;
       });`,
    );
    const result = (await executeThroughContentScript(
      page,
      "use reference",
      [{ name: "one.png", mimeType: "image/png", byteLength: 8, bytesBase64: pngBase64 }],
      600,
    )) as { ok: boolean; error: { code: string } };
    expect(result).toMatchObject({
      ok: false,
      error: { code: "REFERENCE_IMAGE_UPLOAD_FAILED" },
    });
    expect(await page.evaluate(() => globalThis.__sendCount)).toBe(0);
    await page.close();
  });

  it("starts a clean conversation before a reference job", async () => {
    const page = await loadExtensionPage(
      `<main>${composer}</main>
       <button id="new-chat" data-testid="create-new-chat-button" type="button">New chat</button>
       <section id="thread">
         <article data-testid="conversation-turn-1">
           <div data-message-author-role="user">old turn</div>
         </article>
       </section>`,
      `
        globalThis.__events = [];
        document.querySelector('#new-chat').addEventListener('click', () => {
          globalThis.__events.push('new-chat');
          document.querySelector('#thread').remove();
        });
        document.querySelector('#file-input').addEventListener('change', (event) => {
          globalThis.__events.push('attachments:' + event.target.files.length);
          const preview = document.createElement('div');
          for (const file of event.target.files) {
            const image = document.createElement('img');
            image.alt = 'Uploaded image';
            image.src = URL.createObjectURL(file);
            preview.appendChild(image);
          }
          document.querySelector('#attachments').appendChild(preview);
        });
        document.querySelector('#composer-submit-button').addEventListener('click', () => {
          globalThis.__events.push('send');
          const userTurn = document.createElement('article');
          userTurn.dataset.testid = 'conversation-turn-2';
          const userMessage = document.createElement('div');
          userMessage.dataset.messageAuthorRole = 'user';
          for (const file of document.querySelector('#file-input').files) {
            const attachment = document.createElement('div');
            attachment.dataset.testid = 'attachment-preview';
            const thumb = document.createElement('img');
            thumb.alt = 'Uploaded image';
            thumb.src = URL.createObjectURL(file);
            attachment.appendChild(thumb);
            userMessage.appendChild(attachment);
          }
          userTurn.appendChild(userMessage);
          document.body.appendChild(userTurn);
          const turn = document.createElement('article');
          turn.dataset.testid = 'conversation-turn-3';
          const message = document.createElement('div');
          message.dataset.messageAuthorRole = 'assistant';
          const image = document.createElement('img');
          image.id = 'new-image';
          image.src = 'data:image/png;base64,${pngBase64}';
          image.width = 256;
          image.height = 256;
          message.appendChild(image);
          turn.appendChild(message);
          document.body.appendChild(turn);
        });
      `,
    );
    const result = (await executeThroughContentScript(page, "use reference", [
      { name: "one.png", mimeType: "image/png", byteLength: 8, bytesBase64: pngBase64 },
    ])) as { ok: boolean };
    expect(result.ok).toBe(true);
    expect(await page.evaluate(() => globalThis.__events)).toEqual([
      "new-chat",
      "attachments:1",
      "send",
    ]);
    await page.close();
  });

  it("fails a reference job when the conversation cannot be isolated", async () => {
    const page = await loadExtensionPage(
      `<main>${composer}</main>
       <section id="thread">
         <article data-testid="conversation-turn-1">
           <div data-message-author-role="user">old turn</div>
         </article>
       </section>`,
      `globalThis.__sendCount = 0;
       document.querySelector('#composer-submit-button').addEventListener('click', () => {
         globalThis.__sendCount += 1;
       });`,
    );
    const result = (await executeThroughContentScript(
      page,
      "use reference",
      [{ name: "one.png", mimeType: "image/png", byteLength: 8, bytesBase64: pngBase64 }],
      600,
    )) as { ok: boolean; error: { code: string } };
    expect(result).toMatchObject({
      ok: false,
      error: { code: "TAB_NOT_READY" },
    });
    expect(await page.evaluate(() => globalThis.__sendCount)).toBe(0);
    await page.close();
  });

  it("keeps text-only jobs on the current conversation", async () => {
    const page = await loadExtensionPage(
      `<main>${composer}</main>
       <button id="new-chat" data-testid="create-new-chat-button" type="button">New chat</button>
       <section id="thread">
         <article data-testid="conversation-turn-1">
           <div data-message-author-role="user">old turn</div>
         </article>
       </section>`,
      `
        globalThis.__events = [];
        document.querySelector('#new-chat').addEventListener('click', () => {
          globalThis.__events.push('new-chat');
        });
        document.querySelector('#composer-submit-button').addEventListener('click', () => {
          globalThis.__events.push('send');
          const turn = document.createElement('article');
          turn.dataset.testid = 'conversation-turn-2';
          const message = document.createElement('div');
          message.dataset.messageAuthorRole = 'assistant';
          const image = document.createElement('img');
          image.id = 'new-image';
          image.src = 'data:image/png;base64,${pngBase64}';
          image.width = 256;
          image.height = 256;
          message.appendChild(image);
          turn.appendChild(message);
          document.body.appendChild(turn);
        });
      `,
    );
    const result = (await executeThroughContentScript(page, "text only")) as { ok: boolean };
    expect(result.ok).toBe(true);
    expect(await page.evaluate(() => globalThis.__events)).toEqual(["send"]);
    await page.close();
  });
  it("fails when only one of two submitted references survives in the user turn", async () => {
    const page = await loadExtensionPage(
      `<main>${composer}</main>`,
      `
        document.querySelector('#file-input').addEventListener('change', (event) => {
          for (const file of event.target.files) {
            const preview = document.createElement('div');
            preview.dataset.testid = 'attachment-preview';
            const image = document.createElement('img');
            image.alt = 'Uploaded image';
            image.src = URL.createObjectURL(file);
            preview.appendChild(image);
            document.querySelector('#attachments').appendChild(preview);
          }
        });
        document.querySelector('#composer-submit-button').addEventListener('click', () => {
          const userTurn = document.createElement('article');
          userTurn.dataset.testid = 'conversation-turn-2';
          const userMessage = document.createElement('div');
          userMessage.dataset.messageAuthorRole = 'user';
          const attachment = document.createElement('div');
          attachment.dataset.testid = 'attachment-preview';
          const thumb = document.createElement('img');
          thumb.alt = 'Uploaded image';
          thumb.src = 'blob:https://chatgpt.com/one';
          attachment.appendChild(thumb);
          userMessage.appendChild(attachment);
          userTurn.appendChild(userMessage);
          document.body.appendChild(userTurn);
          const turn = document.createElement('article');
          turn.dataset.testid = 'conversation-turn-3';
          const message = document.createElement('div');
          message.dataset.messageAuthorRole = 'assistant';
          const image = document.createElement('img');
          image.id = 'new-image';
          image.src = 'data:image/png;base64,${pngBase64}';
          image.width = 256;
          image.height = 256;
          message.appendChild(image);
          turn.appendChild(message);
          document.body.appendChild(turn);
        });
      `,
    );
    const result = (await executeThroughContentScript(
      page,
      "use two references",
      [
        { name: "one.png", mimeType: "image/png", byteLength: 8, bytesBase64: pngBase64 },
        { name: "two.png", mimeType: "image/png", byteLength: 8, bytesBase64: pngBase64 },
      ],
      800,
    )) as { ok: boolean; error: { code: string } };
    expect(result).toMatchObject({
      ok: false,
      error: { code: "REFERENCE_IMAGE_NOT_SUBMITTED" },
    });
    await page.close();
  });
  it("does not accept a hidden status element as submitted attachment evidence", async () => {
    const page = await loadExtensionPage(
      `<main>${composer}</main>`,
      `
        document.querySelector('#file-input').addEventListener('change', (event) => {
          for (const file of event.target.files) {
            const preview = document.createElement('div');
            preview.dataset.testid = 'attachment-preview';
            const image = document.createElement('img');
            image.alt = 'Uploaded image';
            image.src = URL.createObjectURL(file);
            preview.appendChild(image);
            document.querySelector('#attachments').appendChild(preview);
          }
        });
        document.querySelector('#composer-submit-button').addEventListener('click', () => {
          const userTurn = document.createElement('article');
          userTurn.dataset.testid = 'conversation-turn-2';
          const userMessage = document.createElement('div');
          userMessage.dataset.messageAuthorRole = 'user';
          userMessage.textContent = 'use reference';
          const status = document.createElement('div');
          status.dataset.testid = 'upload-file-status';
          status.style.display = 'none';
          userMessage.appendChild(status);
          userTurn.appendChild(userMessage);
          document.body.appendChild(userTurn);
          const turn = document.createElement('article');
          turn.dataset.testid = 'conversation-turn-3';
          const message = document.createElement('div');
          message.dataset.messageAuthorRole = 'assistant';
          const image = document.createElement('img');
          image.id = 'new-image';
          image.src = 'data:image/png;base64,${pngBase64}';
          image.width = 256;
          image.height = 256;
          message.appendChild(image);
          turn.appendChild(message);
          document.body.appendChild(turn);
        });
      `,
    );
    const result = (await executeThroughContentScript(
      page,
      "use reference",
      [{ name: "one.png", mimeType: "image/png", byteLength: 8, bytesBase64: pngBase64 }],
      1500,
    )) as { ok: boolean; error: { code: string } };
    expect(result).toMatchObject({
      ok: false,
      error: { code: "REFERENCE_IMAGE_NOT_SUBMITTED" },
    });
    await page.close();
  });
  it("fails a strict reuse job when no eligible conversation exists", async () => {
    const page = await loadExtensionPage(
      `<main>${composer}</main>`,
      `globalThis.__sendCount = 0;
       document.querySelector('#composer-submit-button').addEventListener('click', () => {
         globalThis.__sendCount += 1;
       });`,
    );
    const result = (await page.evaluate(
      async ({ fingerprint }) =>
        await new Promise((resolve) => {
          const listener = globalThis.__bridgeListener;
          listener(
            {
              type: "executeJob",
              job: {
                prompt: "use reference",
                inputs: [
                  { name: "one.png", mimeType: "image/png", byteLength: 8, bytesBase64: "iVBORw0KGgo=" },
                ],
                timeoutMs: 800,
                referenceFingerprint: fingerprint,
                conversationMode: "reuse",
              },
            },
            {},
            resolve,
          );
        }),
      { fingerprint: "sha256:v1:deadbeef" },
    )) as { ok: boolean; error: { code: string } };

    expect(result).toMatchObject({
      ok: false,
      error: { code: "CONVERSATION_REUSE_UNAVAILABLE" },
    });
    expect(await page.evaluate(() => globalThis.__sendCount)).toBe(0);
    await page.close();
  });
  it("does not block a reference job when storage never resolves", async () => {
    const page = await loadExtensionPage(
      `<main>${composer}</main>`,
      `
        document.querySelector('#file-input').addEventListener('change', (event) => {
          for (const file of event.target.files) {
            const preview = document.createElement('div');
            preview.dataset.testid = 'attachment-preview';
            const image = document.createElement('img');
            image.alt = 'Uploaded image';
            image.src = URL.createObjectURL(file);
            preview.appendChild(image);
            document.querySelector('#attachments').appendChild(preview);
          }
        });
        document.querySelector('#composer-submit-button').addEventListener('click', () => {
          const userTurn = document.createElement('article');
          userTurn.dataset.testid = 'conversation-turn-2';
          const userMessage = document.createElement('div');
          userMessage.dataset.messageAuthorRole = 'user';
          for (const file of document.querySelector('#file-input').files) {
            const attachment = document.createElement('div');
            attachment.dataset.testid = 'attachment-preview';
            const thumb = document.createElement('img');
            thumb.alt = 'Uploaded image';
            thumb.src = URL.createObjectURL(file);
            attachment.appendChild(thumb);
            userMessage.appendChild(attachment);
          }
          userTurn.appendChild(userMessage);
          document.body.appendChild(userTurn);
          const turn = document.createElement('article');
          turn.dataset.testid = 'conversation-turn-3';
          const message = document.createElement('div');
          message.dataset.messageAuthorRole = 'assistant';
          const image = document.createElement('img');
          image.id = 'new-image';
          image.src = 'data:image/png;base64,${pngBase64}';
          image.width = 256;
          image.height = 256;
          message.appendChild(image);
          turn.appendChild(message);
          document.body.appendChild(turn);
        });
      `,
    );
    // Simulate the extension-context promise that never settles.
    await page.evaluate(() => {
      globalThis.chrome.storage.local.get = () => new Promise(() => {});
      globalThis.chrome.storage.local.set = () => new Promise(() => {});
      globalThis.chrome.storage.local.remove = () => new Promise(() => {});
    });

    const result = (await executeThroughContentScript(
      page,
      "use reference",
      [{ name: "one.png", mimeType: "image/png", byteLength: 8, bytesBase64: pngBase64 }],
      6000,
    )) as { ok: boolean };

    expect(result.ok).toBe(true);
    await page.close();
  });
});
