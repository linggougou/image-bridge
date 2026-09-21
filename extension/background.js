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

// Last decision, kept so the reuse chain can be observed from outside without
// running a job (and therefore without creating any conversation).
let lastConversationDecision = null;

async function postExtensionStatus(authenticated, tabReady, url) {
  const record = await readReuseRecord();
  return bridgeFetch("/v1/extension/status", {
    method: "POST",
    body: JSON.stringify({
      authenticated,
      tabReady,
      url,
      version: chrome.runtime?.getManifest?.()?.version || "",
      reuseRecord: record
        ? {
            fingerprint: String(record.fingerprint || "").slice(0, 80),
            conversationId: String(record.conversationId || "").slice(0, 80),
            successfulJobs: Number(record.successfulJobs || 0),
            lastSuccessAt: Number(record.lastSuccessAt || 0),
          }
        : null,
      lastDecision: lastConversationDecision,
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

const REUSE_KEY = "imageBridgeReferenceReuse";
const REUSE_STORAGE_TIMEOUT_MS = 1500;

// Conversation reuse is decided HERE, not in the content script: chrome.storage
// is reliable in the service worker, while a content script's extension context
// can stay pending forever after an extension reload.
function withStorageTimeout(promise, timeoutMs = REUSE_STORAGE_TIMEOUT_MS) {
  return Promise.race([
    promise,
    new Promise((resolve) => setTimeout(() => resolve(null), timeoutMs)),
  ]);
}

function conversationIdFromUrl(url) {
  const match = /\/c\/([^/?#]+)/.exec(url || "");
  return match ? match[1] : null;
}

async function readReuseRecord() {
  try {
    const stored = await withStorageTimeout(chrome.storage.local.get(REUSE_KEY));
    return stored?.[REUSE_KEY] ?? null;
  } catch {
    return null;
  }
}

async function writeReuseRecord(record) {
  try {
    await withStorageTimeout(chrome.storage.local.set({ [REUSE_KEY]: record }));
  } catch {
    /* eligibility is best-effort */
  }
}

async function clearReuseRecord() {
  try {
    await withStorageTimeout(chrome.storage.local.remove(REUSE_KEY));
  } catch {
    /* ignore */
  }
}

// Returns { decision, reason, details }; decision is "reuse" | "new" | null
// (null = a strict reuse request that cannot be met). The reasons are kept so
// the choice is observable from outside instead of having to be inferred.
async function evaluateConversationDecision(job, tabUrl) {
  const mode = job.conversationMode || "auto";
  const fingerprint = job.referenceFingerprint || null;
  const currentConversationId = conversationIdFromUrl(tabUrl);
  const details = {
    mode,
    hasFingerprint: Boolean(fingerprint),
    currentConversationId,
  };

  if (mode === "new") {
    return { decision: "new", reason: "mode_new", details };
  }

  const record = await readReuseRecord();
  details.hasRecord = Boolean(record);
  details.recordFingerprintMatches = Boolean(record && fingerprint && record.fingerprint === fingerprint);
  details.recordConversationId = record?.conversationId ?? null;
  details.recordConversationMatches = Boolean(
    record?.conversationId && record.conversationId === currentConversationId,
  );

  const eligible =
    Boolean(record && fingerprint) &&
    record.fingerprint === fingerprint &&
    Boolean(record.conversationId) &&
    record.conversationId === currentConversationId;

  if (eligible) return { decision: "reuse", reason: "record_matches", details };
  if (!record) return mode === "reuse"
    ? { decision: null, reason: "no_record", details }
    : { decision: "new", reason: "no_record", details };
  if (!fingerprint) return mode === "reuse"
    ? { decision: null, reason: "no_fingerprint", details }
    : { decision: "new", reason: "no_fingerprint", details };
  if (record.fingerprint !== fingerprint) return mode === "reuse"
    ? { decision: null, reason: "fingerprint_changed", details }
    : { decision: "new", reason: "fingerprint_changed", details };
  return mode === "reuse"
    ? { decision: null, reason: "conversation_mismatch", details }
    : { decision: "new", reason: "conversation_mismatch", details };
}

async function recordReuseSuccess(job, tabId) {
  const fingerprint = job.referenceFingerprint || null;
  if (!fingerprint) return;
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  const conversationId = conversationIdFromUrl(tab?.url || "");
  if (!conversationId) return;
  const existing = await readReuseRecord();
  const same =
    existing?.fingerprint === fingerprint && existing?.conversationId === conversationId;
  const now = Date.now();
  await writeReuseRecord({
    fingerprint,
    conversationId,
    firstSuccessAt: same ? existing.firstSuccessAt : now,
    lastSuccessAt: now,
    successfulJobs: same ? (existing.successfulJobs || 0) + 1 : 1,
  });
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

    if ((job.inputs?.length ?? 0) > 0) {
      const evaluated = await evaluateConversationDecision(job, tab.url);
      if (evaluated.decision === null) {
        await failClaimedJob(
          job,
          "CONVERSATION_REUSE_UNAVAILABLE",
          `No eligible conversation for --conversation reuse; refusing to open a new one. ${JSON.stringify({
            reason: evaluated.reason,
            ...evaluated.details,
          })}`,
        );
        return;
      }
      job.conversationDecision = evaluated.decision;
      lastConversationDecision = {
        at: Date.now(),
        decision: evaluated.decision,
        reason: evaluated.reason,
        details: evaluated.details,
      };
    }

    const result = await chrome.tabs.sendMessage(tab.id, { type: "executeJob", job });
    if (result?.ok === true) {
      if ((job.inputs?.length ?? 0) > 0) await recordReuseSuccess(job, tab.id);
      await bridgeFetch(`/v1/jobs/${encodeURIComponent(job.id)}/result`, {
        method: "POST",
        body: JSON.stringify(result),
      });
    } else {
      if ((job.inputs?.length ?? 0) > 0) await clearReuseRecord();
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
