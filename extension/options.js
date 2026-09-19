const bridgeUrl = document.querySelector("#bridgeUrl");
const token = document.querySelector("#token");
const status = document.querySelector("#status");

function setStatus(value) {
  status.textContent = typeof value === "string" ? value : JSON.stringify(value, null, 2);
}

async function send(message) {
  const response = await chrome.runtime.sendMessage(message);
  if (!response) throw new Error("扩展后台没有返回结果，请重新加载扩展。");
  return response;
}

async function loadState() {
  try {
    const state = await send({ type: "getState" });
    bridgeUrl.value = state.bridgeUrl || "http://127.0.0.1:47831";
    setStatus(state);
  } catch (error) {
    setStatus(`加载失败：${error instanceof Error ? error.message : String(error)}`);
  }
}

document.querySelector("#save").addEventListener("click", async () => {
  try {
    const result = await send({
      type: "saveConfig",
      bridgeUrl: bridgeUrl.value,
      token: token.value,
    });
    setStatus(result);
  } catch (error) {
    setStatus(`保存失败：${error instanceof Error ? error.message : String(error)}`);
  }
});

document.querySelector("#test").addEventListener("click", async () => {
  try {
    const result = await send({ type: "testBridge" });
    setStatus(result);
  } catch (error) {
    setStatus(`测试失败：${error instanceof Error ? error.message : String(error)}`);
  }
});

document.querySelector("#open").addEventListener("click", async () => {
  try {
    const result = await send({ type: "openDedicatedTab" });
    setStatus(result);
  } catch (error) {
    setStatus(`打开失败：${error instanceof Error ? error.message : String(error)}`);
  }
});

void loadState();
