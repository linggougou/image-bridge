(() => {
  const MIN_IMAGE_EDGE = 128;

  const COMPOSER_SELECTORS = [
    "#prompt-textarea[contenteditable='true']",
    "div.ProseMirror[contenteditable='true']",
    "[contenteditable='true'][role='textbox']",
  ];

  const NEW_CHAT_SELECTORS = [
    "[data-testid='create-new-chat-button']",
    "a[href='/']",
    "a[href='https://chatgpt.com/']",
    "button[aria-label*='新聊天']",
    "button[aria-label*='New chat']",
    "a[aria-label*='新聊天']",
    "a[aria-label*='New chat']",
  ];

  const SEND_SELECTORS = [
    "button#composer-submit-button",
    "button[data-testid='send-button']",
    "button[aria-label*='Send']",
    "button[aria-label*='发送']",
  ];

  function isVisible(element) {
    const rect = element.getBoundingClientRect();
    return (
      element instanceof HTMLElement &&
      element.offsetParent !== null &&
      !element.hidden &&
      rect.width > 0 &&
      rect.height > 0 &&
      getComputedStyle(element).visibility !== "hidden"
    );
  }

  function findVisible(selectors, root = document) {
    for (const selector of selectors) {
      let matches = [];
      try {
        matches = Array.from(root.querySelectorAll(selector));
      } catch {
        continue;
      }
      for (const element of matches) {
        if (isVisible(element)) return element;
      }
    }
    return null;
  }

  function normalizedControlText(element) {
    return `${element.getAttribute("aria-label") || ""} ${element.textContent || ""}`
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
  }

  function hasSignedOutControl() {
    const controls = Array.from(document.querySelectorAll("button, a"));
    return controls.some((element) => {
      if (!isVisible(element)) return false;
      const text = normalizedControlText(element);
      return (
        text === "log in" ||
        text === "sign in" ||
        text === "sign up" ||
        text === "登录" ||
        text === "登陆" ||
        text.includes("免费注册")
      );
    });
  }

  function isAuthenticated() {
    return Boolean(findVisible(COMPOSER_SELECTORS)) && !hasSignedOutControl();
  }

  function pageHasHumanChallenge() {
    const text = document.body?.innerText || "";
    return (
      /verify (that )?you are human/i.test(text) ||
      /确认(你|您)是真人/.test(text) ||
      /正在验证(你|您)/.test(text) ||
      Boolean(document.querySelector("iframe[src*='captcha'], iframe[src*='turnstile']"))
    );
  }

  function assistantMessages() {
    return Array.from(
      document.querySelectorAll(
        "[data-testid^='conversation-turn-'] [data-message-author-role='assistant']",
      ),
    );
  }

  function countAssistantResponses() {
    return assistantMessages().length;
  }

  function latestAssistantTurn() {
    const messages = assistantMessages();
    return messages.at(-1)?.closest("[data-testid^='conversation-turn-']") || null;
  }

  function userMessages() {
    return Array.from(
      document.querySelectorAll(
        "[data-testid^='conversation-turn-'] [data-message-author-role='user']",
      ),
    );
  }

  function countUserTurns() {
    return userMessages().length;
  }

  function latestUserTurn() {
    return userMessages().at(-1)?.closest("[data-testid^='conversation-turn-']") || null;
  }

  // Post-submit proof lives on the submitted turn itself. Attachments are only
  // ever counted inside that turn, never from the surrounding page.
  function isTurnAttachmentEvidence(element) {
    if (element instanceof HTMLImageElement) {
      const alt = (element.getAttribute("alt") || "").toLowerCase();
      const testId = (element.getAttribute("data-testid") || "").toLowerCase();
      const parentTestId = (
        element.closest("[data-testid]")?.getAttribute("data-testid") || ""
      ).toLowerCase();
      const source = element.currentSrc || element.src || "";
      return (
        source.startsWith("blob:") ||
        alt.includes("uploaded") ||
        alt.includes("attachment") ||
        alt.includes("上传") ||
        testId.includes("attachment") ||
        testId.includes("upload") ||
        parentTestId.includes("attachment") ||
        parentTestId.includes("upload")
      );
    }
    const testId = (element.getAttribute?.("data-testid") || "").toLowerCase();
    return testId.includes("attachment") || testId.includes("upload");
  }

  // Evidence must be a rendered attachment image. Counting generic
  // [data-testid*=upload|attachment] nodes was a false positive: hidden status
  // chrome matched and certified a message that carried no image at all.
  function countTurnAttachments(turn) {
    if (!turn) return 0;
    const units = new Set();
    for (const image of turn.querySelectorAll("img")) {
      if (isTurnAttachmentEvidence(image)) units.add(image);
    }
    return units.size;
  }

  function imageDimensions(image) {
    return {
      width: image.naturalWidth || image.width,
      height: image.naturalHeight || image.height,
    };
  }

  function findGeneratedImage(turn) {
    const images = Array.from(turn.querySelectorAll("img"));
    for (let index = images.length - 1; index >= 0; index -= 1) {
      const image = images[index];
      const dimensions = imageDimensions(image);
      if (dimensions.width >= MIN_IMAGE_EDGE && dimensions.height >= MIN_IMAGE_EDGE) {
        return image;
      }
    }
    return null;
  }

  // Attachment evidence must stay scoped to the composer. Falling back to
  // `document` lets images from earlier turns satisfy the readiness check, which
  // is the false positive this module must never produce.
  function scopedComposerRoot(composer) {
    const form = composer.closest("form");
    if (form) return form;
    let node = composer.parentElement;
    let depth = 0;
    while (node && node !== document.body && node !== document.documentElement && depth < 6) {
      if (node.querySelector("input[type='file']")) return node;
      node = node.parentElement;
      depth += 1;
    }
    return null;
  }

  function findFileInput(composer) {
    const root = scopedComposerRoot(composer);
    if (!root) return null;
    const candidates = Array.from(root.querySelectorAll("input[type='file']")).filter(
      (input) => !input.disabled,
    );
    return (
      candidates.find((input) => (input.accept || "").toLowerCase().includes("image")) ||
      candidates.find((input) => input.accept) ||
      candidates[0] ||
      null
    );
  }

  function isReferencePreviewImage(element) {
    if (!(element instanceof HTMLImageElement) || !isVisible(element)) return false;
    const alt = (element.getAttribute("alt") || "").toLowerCase();
    const testId = (element.getAttribute("data-testid") || "").toLowerCase();
    const parentTestId = (
      element.closest("[data-testid]")?.getAttribute("data-testid") || ""
    ).toLowerCase();
    const source = element.currentSrc || element.src || "";
    return (
      source.startsWith("blob:") ||
      alt.includes("uploaded") ||
      alt.includes("attachment") ||
      alt.includes("上传") ||
      testId.includes("attachment") ||
      testId.includes("upload") ||
      parentTestId.includes("attachment") ||
      parentTestId.includes("upload")
    );
  }

  function composerAttachmentCount(composer) {
    const root = scopedComposerRoot(composer);
    if (!root) return 0;
    const elements = new Set();
    for (const image of root.querySelectorAll("img")) {
      if (isReferencePreviewImage(image)) elements.add(image);
    }
    return elements.size;
  }

  function decodeBase64(value) {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
  }

  function requestMainWorldReferenceUpload(inputs, timeoutMs) {
    const requestId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    return new Promise((resolve, reject) => {
      const listener = (event) => {
        if (event.source !== window) return;
        const message = event.data;
        if (
          message?.source !== "image-bridge-page" ||
          message.type !== "attachReferenceImagesResult" ||
          message.requestId !== requestId
        ) {
          return;
        }
        window.removeEventListener("message", listener);
        clearTimeout(timer);
        if (message.ok === true) resolve(Number(message.count) || inputs.length);
        else reject(new Error(message.error || "REFERENCE_IMAGE_UPLOAD_FAILED"));
      };
      const timer = setTimeout(() => {
        window.removeEventListener("message", listener);
        reject(new Error("REFERENCE_IMAGE_UPLOAD_FAILED"));
      }, timeoutMs + 1_000);
      window.addEventListener("message", listener);
      window.postMessage(
        {
          source: "image-bridge-extension",
          type: "attachReferenceImages",
          requestId,
          inputs,
          timeoutMs,
        },
        "*",
      );
    });
  }

  function attachmentDiagnostics(composer, extras = {}) {
    const root = scopedComposerRoot(composer);
    const inputs = root
      ? Array.from(root.querySelectorAll("input[type='file']")).map((input) => ({
          id: input.id || "",
          accept: (input.accept || "").slice(0, 40),
          disabled: Boolean(input.disabled),
        }))
      : [];
    return {
      inputsInComposer: inputs.length,
      inputs,
      composerRootFound: Boolean(root),
      previewsInComposer: composerAttachmentCount(composer),
      conversationRoute: isExistingConversationRoute(),
      ...extras,
    };
  }

  // 上传等待必须有界：用整个任务预算等待会让上传失败伪装成 TIMEOUT。
  const ATTACHMENT_TIMEOUT_MS = 30_000;

  async function attachReferenceImages(composer, inputs, timeoutMs) {
    if (!inputs?.length) return 0;
    const bounded = Math.min(timeoutMs, ATTACHMENT_TIMEOUT_MS);
    const diagnostics = attachmentDiagnostics(composer);
    if (document.documentElement.hasAttribute("data-image-bridge-main-world")) {
      try {
        return await requestMainWorldReferenceUpload(inputs, bounded);
      } catch (error) {
        const detail = error instanceof Error ? error.message : "REFERENCE_IMAGE_UPLOAD_FAILED";
        throw new Error(
          `REFERENCE_IMAGE_UPLOAD_FAILED ${JSON.stringify({ ...diagnostics, mainWorld: detail })}`,
        );
      }
    }
    const fileInput = findFileInput(composer);
    if (!fileInput || typeof DataTransfer === "undefined") {
      throw new Error(
        `REFERENCE_IMAGE_UPLOAD_FAILED ${JSON.stringify({ ...diagnostics, reason: "no-scoped-file-input" })}`,
      );
    }

    const existingFiles = Array.from(fileInput.files || []);
    const transfer = new DataTransfer();
    for (const file of existingFiles) transfer.items.add(file);
    for (const input of inputs) {
      const bytes = decodeBase64(input.bytesBase64);
      transfer.items.add(new File([bytes], input.name || "reference-image", { type: input.mimeType }));
    }

    const expectedFiles = existingFiles.length + inputs.length;
    const expectedAttachments = composerAttachmentCount(composer) + inputs.length;
    fileInput.files = transfer.files;
    fileInput.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
    fileInput.dispatchEvent(new Event("change", { bubbles: true, composed: true }));

    const ready = await waitUntil(
      () =>
        (fileInput.files?.length || 0) >= expectedFiles &&
          composerAttachmentCount(composer) >= expectedAttachments,
      bounded,
    );
    if (!ready) {
      throw new Error(
        `REFERENCE_IMAGE_UPLOAD_FAILED ${JSON.stringify({
          ...diagnostics,
          reason: "preview-never-appeared",
          filesAfterAssign: fileInput.files?.length || 0,
          previewsAfterAssign: composerAttachmentCount(composer),
        })}`,
      );
    }
    return inputs.length;
  }

  function setComposerValue(composer, prompt) {
    composer.focus();
    let inserted = false;
    try {
      inserted =
        document.execCommand("selectAll", false) &&
        document.execCommand("insertText", false, prompt);
    } catch {
      inserted = false;
    }
    if (!inserted) {
      composer.textContent = prompt;
      composer.dispatchEvent(
        new InputEvent("input", {
          bubbles: true,
          inputType: "insertText",
          data: prompt,
        }),
      );
    }
  }

  async function waitUntil(predicate, timeoutMs, intervalMs = 250) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const value = await predicate();
      if (value) return value;
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
    return null;
  }

  async function imageToBase64(image) {
    const source = image.currentSrc || image.src;
    if (!source) throw new Error("Generated image has no source.");
    const response = await fetch(source);
    if (!response.ok) throw new Error(`Image fetch failed: ${response.status}`);
    const blob = await response.blob();
    const dataUrl = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : null);
      reader.onerror = () => reject(reader.error || new Error("Image read failed."));
      reader.readAsDataURL(blob);
    });
    const match = /^data:([^;,]+);base64,(.+)$/s.exec(dataUrl || "");
    if (!match) throw new Error("Generated image returned invalid data.");
    return { bytesBase64: match[2], mimeType: match[1] };
  }

  function isExistingConversationRoute() {
    return /^\/c\//.test(location.pathname);
  }

  // 水合期的瞬时 0 轮次不能当作"干净会话"，必须等轮次数连续两次读数一致。
  async function waitForConversationSettled(timeoutMs = 4_000) {
    let previous = -1;
    return waitUntil(() => {
      const current = countUserTurns();
      const settled = current === previous;
      previous = current;
      return settled;
    }, timeoutMs, 600);
  }

  async function startCleanConversation(timeoutMs) {
    await waitForConversationSettled(Math.min(timeoutMs, 4_000));
    // 只看轮次数会在页面未渲染完时把历史会话误判成新会话；路由是更硬的判据。
    if (countUserTurns() === 0 && !isExistingConversationRoute()) return;
    const control = findVisible(NEW_CHAT_SELECTORS);
    if (!control) throw new Error("TAB_NOT_READY");
    control.click();
    const clean = await waitUntil(
      () => countUserTurns() === 0 && Boolean(findVisible(COMPOSER_SELECTORS)),
      Math.min(timeoutMs, 30_000),
    );
    if (!clean) throw new Error("TAB_NOT_READY");
  }

  // Post-submit proof. The job may only continue once the submitted turn itself
  // shows the attachments it claims to have sent.
  async function waitForSubmittedAttachments(previousUserTurns, expected, timeoutMs) {
    return waitUntil(() => {
      if (pageHasHumanChallenge()) throw new Error("HUMAN_VERIFICATION_REQUIRED");
      if (countUserTurns() <= previousUserTurns) return false;
      const submitted = countTurnAttachments(latestUserTurn());
      if (submitted > expected) throw new Error("REFERENCE_IMAGE_NOT_SUBMITTED");
      return submitted === expected;
    }, Math.min(timeoutMs, 60_000));
  }

  const REUSE_KEY = "imageBridgeReferenceReuse";
  // No forced reuse cap: the caller decides with --conversation. A conversation
  // stays reusable while the ordered reference set is unchanged.
  const STORAGE_TIMEOUT_MS = 1_500;

  // Storage IO must never block a job. An extension-context promise can stay
  // pending forever (e.g. after an extension reload without a page reload), and
  // that previously turned every reference job into a 5-minute client timeout.
  function withTimeout(promise, timeoutMs) {
    return Promise.race([
      promise,
      new Promise((resolve) => setTimeout(() => resolve(null), timeoutMs)),
    ]);
  }

  function currentConversationId() {
    const match = location.pathname.match(/\/c\/([^/?#]+)/);
    return match ? match[1] : null;
  }

  // Reuse eligibility is stored extension-side: bridge job records expire and
  // are lost on bridge restart, so they cannot own this state.
  async function readReuseRecord() {
    try {
      const stored = await withTimeout(
        chrome.storage.local.get(REUSE_KEY),
        STORAGE_TIMEOUT_MS,
      );
      return stored?.[REUSE_KEY] ?? null;
    } catch {
      return null;
    }
  }

  async function writeReuseRecord(record) {
    try {
      await withTimeout(
        chrome.storage.local.set({ [REUSE_KEY]: record }),
        STORAGE_TIMEOUT_MS,
      );
    } catch {
      /* eligibility is best-effort; a storage error must not fail a job */
    }
  }

  async function clearReuseRecord() {
    try {
      await withTimeout(chrome.storage.local.remove(REUSE_KEY), STORAGE_TIMEOUT_MS);
    } catch {
      /* ignore */
    }
  }

  function reuseEligible(record, fingerprint) {
    if (!record || !fingerprint) return false;
    if (record.fingerprint !== fingerprint) return false;
    if (!record.conversationId || record.conversationId !== currentConversationId()) return false;
    return true;
  }

  // auto (default): reuse an eligible conversation, otherwise isolate.
  // new: always isolate. reuse: require an eligible conversation, never
  // silently fall back to a different one.
  async function resolveConversation(job, timeoutMs) {
    const mode = job.conversationMode || "auto";
    const fingerprint = job.referenceFingerprint || null;
    const eligible = reuseEligible(await readReuseRecord(), fingerprint);

    if (mode === "new") {
      await startCleanConversation(timeoutMs);
      return;
    }
    if (mode === "reuse") {
      if (!eligible) throw new Error("CONVERSATION_REUSE_UNAVAILABLE");
      return;
    }
    if (eligible) return;
    await startCleanConversation(timeoutMs);
  }

  async function recordReuseSuccess(job) {
    const fingerprint = job.referenceFingerprint || null;
    const conversationId = currentConversationId();
    if (!fingerprint || !conversationId) return;
    const existing = await readReuseRecord();
    const sameConversation =
      existing?.fingerprint === fingerprint && existing?.conversationId === conversationId;
    const now = Date.now();
    await writeReuseRecord({
      fingerprint,
      conversationId,
      firstSuccessAt: sameConversation ? existing.firstSuccessAt : now,
      lastSuccessAt: now,
      successfulJobs: sameConversation ? (existing.successfulJobs || 0) + 1 : 1,
    });
  }

  async function executeJob(job) {
    if (!isAuthenticated()) throw new Error("NOT_AUTHENTICATED");

    const referenceInputs = job.inputs ?? [];
    const hasReferences = referenceInputs.length > 0;

    try {
      if (hasReferences) {
        await resolveConversation(job, job.timeoutMs || 300_000);
      }
      const result = await runJobBody(job, referenceInputs, hasReferences);
      if (hasReferences) await recordReuseSuccess(job);
      return result;
    } catch (error) {
      // A failed or interrupted reference job invalidates reuse eligibility.
      if (hasReferences) await clearReuseRecord();
      throw error;
    }
  }

  async function runJobBody(job, referenceInputs, hasReferences) {

    const composer = findVisible(COMPOSER_SELECTORS);
    if (!composer) throw new Error("TAB_NOT_READY");

    const previousResponses = countAssistantResponses();
    const previousUserTurns = countUserTurns();
    if (hasReferences) {
      await attachReferenceImages(composer, referenceInputs, job.timeoutMs || 300_000);
    }
    setComposerValue(composer, job.prompt);

    const sendButton = await waitUntil(() => {
      const button = findVisible(SEND_SELECTORS);
      return button && !button.disabled ? button : null;
    }, 5_000);
    if (sendButton) sendButton.click();
    else {
      composer.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true }),
      );
    }

    if (hasReferences) {
      const verified = await waitForSubmittedAttachments(
        previousUserTurns,
        referenceInputs.length,
        job.timeoutMs || 300_000,
      );
      if (!verified) throw new Error("REFERENCE_IMAGE_NOT_SUBMITTED");
    }

    const response = await waitUntil(() => {
      if (pageHasHumanChallenge()) throw new Error("HUMAN_VERIFICATION_REQUIRED");
      if (!isAuthenticated()) throw new Error("SESSION_EXPIRED");
      return countAssistantResponses() > previousResponses ? latestAssistantTurn() : null;
    }, job.timeoutMs || 300_000);
    if (!response) throw new Error("TIMEOUT");

    const image = await waitUntil(() => findGeneratedImage(response), job.timeoutMs || 300_000);
    if (!image) throw new Error("IMAGE_NOT_FOUND");

    return {
      ok: true,
      ...(await imageToBase64(image)),
      retrieval: "data-url",
      modelUrl: location.href,
    };
  }

  globalThis.ImageBridgeContentCore = {
    findVisible,
    hasSignedOutControl,
    isAuthenticated,
    pageHasHumanChallenge,
    countAssistantResponses,
    latestAssistantTurn,
    findGeneratedImage,
    attachReferenceImages,
    executeJob,
  };
})();
