import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";

import { describe, expect, it } from "vitest";

type MessageListener = (
  message: unknown,
  sender: unknown,
  sendResponse: (response: unknown) => void,
) => boolean;

async function loadBackground(initialDedicatedTabId: number | null) {
  const source = await readFile(
    new URL("../extension/background.js", import.meta.url),
    "utf8",
  );
  const state = {
    dedicatedTabId: initialDedicatedTabId,
    token: "",
  };
  const setCalls: Array<Record<string, unknown>> = [];
  const fetchCalls: string[] = [];
  let listener: MessageListener | null = null;

  const chrome = {
    storage: {
      local: {
        async get() {
          return {
            bridgeUrl: "http://127.0.0.1:47831",
            token: state.token,
            dedicatedTabId: state.dedicatedTabId,
          };
        },
        async set(values: Record<string, unknown>) {
          setCalls.push(values);
          if (Number.isInteger(values.dedicatedTabId)) {
            state.dedicatedTabId = values.dedicatedTabId as number;
          }
        },
        async remove(key: string) {
          if (key === "dedicatedTabId") state.dedicatedTabId = null;
        },
      },
    },
    runtime: {
      onMessage: {
        addListener(candidate: MessageListener) {
          listener = candidate;
        },
      },
    },
    tabs: {
      onRemoved: {
        addListener() {},
      },
    },
  };

  const context = {
    chrome,
    fetch: async (url: string) => {
      fetchCalls.push(url);
      return { ok: true, status: 200 };
    },
    setInterval: () => 1,
    clearInterval: () => {},
    setTimeout,
    clearTimeout,
    URL,
    console,
  };
  runInNewContext(source, context);
  await new Promise((resolve) => setTimeout(resolve, 0));

  return {
    state,
    setCalls,
    fetchCalls,
    send(
      tabId: number,
      url = "https://chatgpt.com/?image-bridge=1",
    ) {
      if (!listener) throw new Error("background message listener is missing");
      listener(
        { type: "contentReady", authenticated: true, url },
        { tab: { id: tabId, url } },
        () => {},
      );
    },
  };
}

describe("Chrome extension background tab ownership", () => {
  it("does not let a second marked tab steal the dedicated slot", async () => {
    const background = await loadBackground(1);
    background.state.token = "test-token";

    background.send(2);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(background.state.dedicatedTabId).toBe(1);
    expect(background.setCalls).toEqual([]);
    expect(background.fetchCalls).toEqual([]);
  });

  it("accepts the first marked tab while no dedicated tab is registered", async () => {
    const background = await loadBackground(null);
    background.state.token = "test-token";

    background.send(2);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(background.state.dedicatedTabId).toBe(2);
    expect(background.setCalls).toContainEqual({ dedicatedTabId: 2 });
    expect(background.fetchCalls).toContain(
      "http://127.0.0.1:47831/v1/extension/status",
    );
  });

  it("keeps reporting only from the registered dedicated tab", async () => {
    const background = await loadBackground(2);
    background.state.token = "test-token";

    background.send(2);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(background.setCalls).toEqual([{ dedicatedTabId: 2 }]);
    expect(background.fetchCalls).toEqual([
      "http://127.0.0.1:47831/v1/extension/status",
    ]);
  });
});
