const BRIDGE_TAB_KEY = "imageBridgeDedicatedTab";

if (new URL(location.href).searchParams.get("image-bridge") === "1") {
  sessionStorage.setItem(BRIDGE_TAB_KEY, "1");
}

const dedicatedTab = sessionStorage.getItem(BRIDGE_TAB_KEY) === "1";
const core = globalThis.ImageBridgeContentCore;

if (!core) {
  throw new Error("Image Bridge content core failed to load.");
}

if (dedicatedTab) {
  const reportReady = () => {
    void chrome.runtime.sendMessage({
      type: "contentReady",
      authenticated: core.isAuthenticated(),
      url: location.href,
    });
  };
  reportReady();
  setInterval(reportReady, 5_000);
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "executeJob" || !dedicatedTab) return false;
  void core.executeJob(message.job).then(
    (result) => sendResponse(result),
    (error) => {
      const messageText = error instanceof Error ? error.message : String(error);
      // 错误消息可能带诊断后缀（例如 "CODE {json}"），按首段匹配错误码。
      const codeText = messageText.split(/\s/)[0];
      const code =
        codeText === "HUMAN_VERIFICATION_REQUIRED"
          ? "BROWSER_FAILED"
          : codeText === "SESSION_EXPIRED" || codeText === "NOT_AUTHENTICATED"
            ? codeText
          : codeText === "TAB_NOT_READY" ||
                codeText === "TIMEOUT" ||
                codeText === "IMAGE_NOT_FOUND" ||
                codeText === "REFERENCE_IMAGE_UPLOAD_FAILED" ||
                codeText === "REFERENCE_IMAGE_NOT_SUBMITTED"
              ? codeText
              : "IMAGE_RETRIEVAL_FAILED";
      sendResponse({
        ok: false,
        error: {
          code,
          message:
            code === "BROWSER_FAILED"
              ? "ChatGPT requires manual human verification. Complete it in the dedicated tab and retry."
              : messageText,
        },
      });
    },
  );
  return true;
});
