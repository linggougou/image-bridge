(() => {
  const MAIN_WORLD_FLAG = "data-image-bridge-main-world";
  const COMPOSER_SELECTORS = [
    "#prompt-textarea[contenteditable='true']",
    "div.ProseMirror[contenteditable='true']",
    "[contenteditable='true'][role='textbox']",
  ];

  document.documentElement?.setAttribute(MAIN_WORLD_FLAG, "1");

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

  function findComposer() {
    for (const selector of COMPOSER_SELECTORS) {
      const element = Array.from(document.querySelectorAll(selector)).find(isVisible);
      if (element) return element;
    }
    return null;
  }

  // Composer-scoped only: a page-wide fallback would let earlier turns satisfy
  // readiness, which is the false positive this bridge must not produce.
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

  // This reports composer-local readiness only. It is never proof that the
  // attachment survived submission; that check happens on the submitted turn.
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

  async function waitUntil(predicate, timeoutMs, intervalMs = 250) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (predicate()) return true;
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
    return false;
  }

  async function revealFileInput(composer) {
    let input = findFileInput(composer);
    if (input) return input;
    // 真实上传 input 可能只在打开附件菜单后才被创建。
    const trigger = composer
      .closest("form")
      ?.querySelector("#composer-plus-btn, [data-testid='composer-plus-btn'], button[aria-label*='添加']");
    if (!trigger) return null;
    for (const type of ["pointerdown", "mousedown", "mouseup", "click"]) {
      trigger.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, composed: true }));
    }
    await waitUntil(() => Boolean(findFileInput(composer)), 2_000, 200);
    return findFileInput(composer);
  }

  async function attachReferenceImages(composer, inputs, timeoutMs) {
    const fileInput = await revealFileInput(composer);
    if (!fileInput || typeof DataTransfer === "undefined") {
      throw new Error("REFERENCE_IMAGE_UPLOAD_FAILED");
    }

    const existingFiles = Array.from(fileInput.files || []);
    const transfer = new DataTransfer();
    for (const file of existingFiles) transfer.items.add(file);
    for (const input of inputs) {
      const bytes = decodeBase64(input.bytesBase64);
      transfer.items.add(
        new File([bytes], input.name || "reference-image", { type: input.mimeType }),
      );
    }

    const expectedFiles = existingFiles.length + inputs.length;
    const baselineAttachments = composerAttachmentCount(composer);
    const expectedAttachments = baselineAttachments + inputs.length;

    // ChatGPT's composer is React-driven. A synthetic drop goes through the
    // component's own drop handler, which is the path that actually starts an
    // upload; writing to the file input only produces a local preview in some
    // page states and the attachment is then dropped on submit.
    const dropped = (() => {
      try {
        for (const type of ["dragenter", "dragover", "drop"]) {
          composer.dispatchEvent(
            new DragEvent(type, {
              bubbles: true,
              cancelable: true,
              composed: true,
              dataTransfer: transfer,
            }),
          );
        }
        return true;
      } catch {
        return false;
      }
    })();
    if (dropped) {
      const droppedReady = await waitUntil(
        () => composerAttachmentCount(composer) >= expectedAttachments,
        4_000,
      );
      if (droppedReady) return inputs.length;
    }

    // Fallback: assign through the composer's file input.
    fileInput.files = transfer.files;
    fileInput.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
    fileInput.dispatchEvent(new Event("change", { bubbles: true, composed: true }));

    const ready = await waitUntil(
      () =>
        (fileInput.files?.length || 0) >= expectedFiles &&
        composerAttachmentCount(composer) >= expectedAttachments,
      timeoutMs,
    );
    if (!ready) throw new Error("REFERENCE_IMAGE_UPLOAD_FAILED");
    return inputs.length;
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const message = event.data;
    if (
      message?.source !== "image-bridge-extension" ||
      message.type !== "attachReferenceImages" ||
      typeof message.requestId !== "string" ||
      !Array.isArray(message.inputs)
    ) {
      return;
    }

    void (async () => {
      try {
        const composer = findComposer();
        if (!composer) throw new Error("TAB_NOT_READY");
        const count = await attachReferenceImages(
          composer,
          message.inputs,
          Number(message.timeoutMs) || 300_000,
        );
        window.postMessage(
          {
            source: "image-bridge-page",
            type: "attachReferenceImagesResult",
            requestId: message.requestId,
            ok: true,
            count,
          },
          "*",
        );
      } catch (error) {
        window.postMessage(
          {
            source: "image-bridge-page",
            type: "attachReferenceImagesResult",
            requestId: message.requestId,
            ok: false,
            error: error instanceof Error ? error.message : "REFERENCE_IMAGE_UPLOAD_FAILED",
          },
          "*",
        );
      }
    })();
  });
})();
