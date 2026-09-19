# image-bridge 使用说明（交给 Agent）

本文是**独立文档**：把本文件（或它的链接）连同下面那句指令交给你的 agent，
它就能在任意项目里调用本机的 image-bridge 生成图片。

> **交给 agent 的指令（可直接复制）**
>
> 读 `docs/agent-usage.md`，按它调用本机 image-bridge 生成图片。
> 严格遵守其中的硬性规则与验收标准；遇到错误码按表处理，不要自行绕过或降级。

---

## 1. 这是什么

本机运行的命令行工具：把提示词（可选参考图）通过**用户已登录的 ChatGPT 网页会话**生成图片，
保存到本地文件并返回路径。

- 不是官方 API；不需要额外购买额度
- 只自动化用户**已手动登录**的网页会话
- 生成的图片会落盘，路径由调用方指定

## 2. 前置检查（每次使用前先做）

先确认命令位置与桥状态：

```bash
# CLI：以下任一可用即可
command -v image-bridge || ls <仓库路径>/dist/cli.js

# 桥必须正在运行（默认 127.0.0.1:47831）
image-bridge status --backend chrome-extension     # 或 node <仓库路径>/dist/cli.js status --backend chrome-extension
```

期望：`{"ok":true,...,"authenticated":true}`。

- 若返回 `BRIDGE_UNAVAILABLE` 或命令本身报 `Failed to fetch` → **桥没在运行**，
  让用户执行 `node <仓库路径>/dist/cli.js bridge`（需常驻）
- 若 `authenticated:false` → 让用户在 Chrome 里完成登录、并点扩展的「打开专用 ChatGPT 标签页」

## 3. 生成图片

**无参考图**

```bash
image-bridge generate \
  --backend chrome-extension \
  --prompt "<提示词>" \
  --output <输出路径>.png
```

**带参考图**（最多 4 张；单张 ≤8 MiB、总计 ≤20 MiB；PNG / JPEG / WebP / GIF）

```bash
image-bridge generate \
  --backend chrome-extension \
  --input <参考图1> --input <参考图2> \
  --prompt "<提示词>" \
  --output <输出路径>.png
```

- 输出路径已存在时**会失败**；确需覆盖才加 `--force`
- 输出目录需已存在且可写
- stdout 是**单行 JSON**；退出码非 0 表示失败

## 4. 返回契约

成功：

```json
{"ok":true,"command":"generate","outputPath":"/abs/path.png","mimeType":"image/png",
 "bytes":1023334,"retrieval":"data-url","prompt":"...","modelUrl":"https://chatgpt.com/c/..."}
```

失败：

```json
{"ok":false,"command":"generate","error":{"code":"REFERENCE_IMAGE_NOT_SUBMITTED","message":"..."}}
```

解析时**以 `ok` 字段为准**，不要把非 0 退出码当成成功。

## 5. 错误码 → 处理动作

| 错误码 | 含义 | agent 该做什么 |
| --- | --- | --- |
| `INVALID_ARGUMENT` | 参数问题 | 修正参数后重试 |
| `BRIDGE_UNAVAILABLE` | 桥未运行 | 告知用户启动桥，不要反复重试 |
| `EXTENSION_UNAVAILABLE` / `TAB_NOT_READY` | 扩展或专用标签页未就绪 | 告知用户点「打开专用 ChatGPT 标签页」；不要尝试自动化登录 |
| `NOT_AUTHENTICATED` / `SESSION_EXPIRED` | ChatGPT 登录态失效 | 交回用户手工登录 |
| `UNSUPPORTED_INPUT` | 该后端不支持 `--input` | 改用 `chrome-extension` 后端 |
| `REFERENCE_IMAGE_UPLOAD_FAILED` | 参考图未能附上（消息里带诊断 JSON） | **不要重试成无参考图生成**；把诊断原样报告给用户 |
| `REFERENCE_IMAGE_NOT_SUBMITTED` | 提交后消息里没有参考图 | 同上：如实报告，**禁止降级** |
| `IMAGE_NOT_FOUND` / `TIMEOUT` | 未取到图片 | 可重试一次；仍失败则报告 |
| `OUTPUT_EXISTS` | 输出文件已存在 | 换路径或经用户同意后加 `--force` |
| `BROWSER_FAILED` | 出现人机检测等 | 让用户手动完成，**绝不绕过** |

## 6. 硬性规则（不得违反）

1. 不自动登录、不代填凭据、不解人机验证；遇到即交回人工
2. 参考图任务**不得降级**为无参考图生成
3. 不把 token、Cookie、会话信息、参考图字节写进日志或提交
4. 不调用未公开接口；只通过本 CLI 交互
5. 不开启 `--force` 覆盖用户的既有文件，除非用户明确同意
6. 不并发狂刷；一次一个任务（桥本身也是串行的）

## 7. 验收标准（重要）

**唯一权威证据：用户在 ChatGPT 网页端能亲眼看到消息里的参考图缩略图。**

- CLI 返回 `ok:true` 只代表它取到了图片，**不代表参考图被模型接收**
- 生成结果"看起来像参考图"只是旁证，提示词本身也可能描述出相似内容
- 凡是涉及参考图的交付，都应提示用户去看一眼缩略图

## 8. 典型调用（供 agent 参考）

```bash
# 1) 先确认可用
image-bridge status --backend chrome-extension

# 2) 生成（参考图来自本地已下载的文件）
image-bridge generate --backend chrome-extension \
  --input /tmp/ref-dog.png \
  --prompt "以参考图的角色为主体重绘，保持线条与配色，纯白背景，无文字" \
  --output outputs/dog-v2.png

# 3) 把返回 JSON 的 outputPath 作为产物交付/回贴
```
