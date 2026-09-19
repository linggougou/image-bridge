const DEFAULT_BRIDGE_URL = "http://127.0.0.1:47831";
const POLL_INTERVAL_MS = 2000;

let pollInFlight = false;
let lastAuthenticated = false;
let lastStatus = "starting";

async function getConfig() {
  const stored = await chrome.storage.local.get([
    "bridgeUrl",
    "token",
    "dedicatedTabId",
  ]);
  return {
    bridgeUrl: stored.bridgeUrl || DEFAULT_BRIDGE_URL,
    token: stored.token || "",
    dedicatedTabId: Number.isInteger(stored.dedicatedTabId)
      ? stored.dedicatedTabId
      : null,
  };
}

async function bridgeFetch(path, init = {}) {
  const config = await getConfig();
  if (!config.token) throw new Error("Bridge token is not configured.");
  const response = await fetch(`${config.bridgeUrl.replace(/\/$/, "")}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${config.token}`,
      "Content-Type": "application/json",
      ...(init.headers || {}),
    },
  });
  return response;
}

async function postExtensionStatus(authenticated, tabReady, url) {
  return bridgeFetch("/v1/extension/status", {
    method: "POST",
    body: JSON.stringify({
      authenticated,
      tabReady,
      url,
      version: chrome.runtime?.getManifest?.()?.version || "",
    }),
  });
}

async function reportContentReady(sender, message) {
  const tabId = sender.tab?.id;
  const url = sender.tab?.url || message.url || "";
  if (!tabId || !url.startsWith("https://chatgpt.com/")) return;

  const config = await getConfig();
  const marked = new URL(url).searchParams.get("image-bridge") === "1";
  const alreadyDedicated = config.dedicatedTabId === tabId;
  if (!marked && !alreadyDedicated) return;

  // Only an explicitly marked tab may claim the dedicated slot. A previously
  // registered tab may keep reporting status, but must not steal the slot back
  // from the tab the user selected with ?image-bridge=1.
  if (marked && (!config.dedicatedTabId || config.dedicatedTabId === tabId)) {
    await chrome.storage.local.set({ dedicatedTabId: tabId });
  } else if (!alreadyDedicated) {
    return;
  }
  lastAuthenticated = message.authenticated === true;
  lastStatus = lastAuthenticated ? "ready" : "login-required";
  await postExtensionStatus(lastAuthenticated, true, url).catch(() => undefined);
}

async function failClaimedJob(job, code, message) {
  await bridgeFetch(`/v1/jobs/${encodeURIComponent(job.id)}/result`, {
    method: "POST",
    body: JSON.stringify({ ok: false, error: { code, message } }),
  }).catch(() => undefined);
}

async function pollBridge() {
  if (pollInFlight) return;
  pollInFlight = true;
  try {
    const config = await getConfig();
    if (!config.token) {
      lastStatus = "not-configured";
      return;
    }

    const statusResponse = await bridgeFetch("/v1/status");
    if (!statusResponse.ok) {
      lastStatus = "bridge-error";
      return;
    }
    lastStatus = "bridge-connected";

    const claimResponse = await bridgeFetch("/v1/jobs/claim", { method: "POST" });
    if (claimResponse.status === 204 || claimResponse.status === 409) return;
    if (!claimResponse.ok) {
      lastStatus = "claim-failed";
      return;
    }

    const job = await claimResponse.json();
    const latest = await getConfig();
    if (!latest.dedicatedTabId) {
      await failClaimedJob(job, "TAB_NOT_READY", "No dedicated ChatGPT tab is registered.");
      return;
    }

    const tab = await chrome.tabs.get(latest.dedicatedTabId).catch(() => null);
    if (!tab?.id || !tab.url?.startsWith("https://chatgpt.com/")) {
      await failClaimedJob(job, "TAB_NOT_READY", "The dedicated ChatGPT tab is closed or on another site.");
      return;
    }

    const result = await chrome.tabs.sendMessage(tab.id, { type: "executeJob", job });
    if (result?.ok === true) {
      await bridgeFetch(`/v1/jobs/${encodeURIComponent(job.id)}/result`, {
        method: "POST",
        body: JSON.stringify(result),
      });
    } else {
      await failClaimedJob(
        job,
        result?.error?.code || "EXTENSION_FAILED",
        result?.error?.message || "ChatGPT content script failed.",
      );
    }
  } catch (error) {
    lastStatus = error instanceof Error ? error.message : "bridge-unavailable";
  } finally {
    pollInFlight = false;
  }
}

setInterval(() => void pollBridge(), POLL_INTERVAL_MS);
void pollBridge();

chrome.action?.onClicked.addListener(() => {
  void chrome.runtime.openOptionsPage();
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "contentReady") {
    void reportContentReady(sender, message).then(
      () => sendResponse({ ok: true }),
      (error) => sendResponse({ ok: false, error: String(error) }),
    );
    return true;
  }

  if (message?.type === "getState") {
    void getConfig().then((config) => {
      sendResponse({
        bridgeUrl: config.bridgeUrl,
        tokenConfigured: Boolean(config.token),
        dedicatedTabId: config.dedicatedTabId,
        authenticated: lastAuthenticated,
        status: lastStatus,
      });
    });
    return true;
  }

  if (message?.type === "saveConfig") {
    void chrome.storage.local
      .set({
        bridgeUrl: String(message.bridgeUrl || DEFAULT_BRIDGE_URL),
        token: String(message.token || ""),
      })
      .then(() => sendResponse({ ok: true }), (error) => sendResponse({ ok: false, error: String(error) }));
    return true;
  }

  if (message?.type === "testBridge") {
    void bridgeFetch("/v1/status").then(async (response) => {
      sendResponse({
        ok: response.ok,
        status: response.status,
        body: await response.json().catch(() => null),
      });
    }, (error) => sendResponse({ ok: false, error: String(error) }));
    return true;
  }

  if (message?.type === "openDedicatedTab") {
    void chrome.tabs
      .create({ url: "https://chatgpt.com/?image-bridge=1", active: true })
      .then(async (tab) => {
        if (tab.id) await chrome.storage.local.set({ dedicatedTabId: tab.id });
        sendResponse({ ok: true, tabId: tab.id ?? null });
      }, (error) => sendResponse({ ok: false, error: String(error) }));
    return true;
  }

  return false;
});

chrome.tabs.onRemoved.addListener((tabId) => {
  void chrome.storage.local.get("dedicatedTabId").then((stored) => {
    if (stored.dedicatedTabId === tabId) {
      void chrome.storage.local.remove("dedicatedTabId");
      lastAuthenticated = false;
      lastStatus = "tab-closed";
    }
  });
});
