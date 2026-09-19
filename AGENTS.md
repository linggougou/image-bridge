# AGENTS.md — 给 Agent 的搭建与使用说明

你是被要求"在用户本地搭好 image-bridge"的 agent。按本文执行即可，不需要读其他文档。
用户会把它当作本地 MCP/CLI 工具使用：让 Codex / Multica 提交提示词，经用户**已登录的 ChatGPT 网页会话**生成图片，
结果落到本地文件并回传。

## 0. 红线（任何情况下都不得违反）

- 不自动登录、不代填账号密码、不解人机验证；遇到时**停下来交给人工**
- 不引入未公开接口、私有 API、第三方中转
- 参考图任务**不得降级**为"无参考图生成"；证据不足时按错误码失败
- 不把 token、Cookie、会话存储、参考图字节写进仓库或日志

## 1. 前置

- macOS / Linux / Windows，Node.js >= 20，Google Chrome
- 用户**已在其日常 Chrome 中登录 ChatGPT**

## 2. 搭建（逐条执行）

```bash
git clone <本仓库地址> image-bridge && cd image-bridge
npm install
npm run build
npm run typecheck && npm test        # 期望：全部通过
```

启动本地桥（它是扩展与 CLI 之间的回环服务）：

```bash
node dist/cli.js bridge                 # 默认 127.0.0.1:47831
```

> 需要长期运行时，请使用系统服务方式（launchd / systemd / Windows 服务）；
> 不要用 `nohup ... &`，进程可能随终端会话退出。

加载扩展到用户**日常使用的那个 Chrome**：

1. 打开 `chrome://extensions` → 开启"开发者模式" → "加载已解压的扩展程序"
2. 选择本仓库的 `extension/` 目录
3. 点开扩展选项，填写桥地址 `http://127.0.0.1:47831`
4. 取 token 并粘贴：
   ```bash
   node dist/cli.js bridge token
   ```
5. 点「打开专用 ChatGPT 标签页」，该标签页在用户已登录的 ChatGPT 中打开
6. 只保留**一个** Chrome 配置里的这个扩展（多个实例会互抢任务）

## 3. 验证搭建成功

```bash
node dist/cli.js status --backend chrome-extension
```

期望 `"ok": true` 且 `authenticated: true`。同时用桥的原始状态确认扩展版本：

```bash
TOKEN=$(cat ~/.image-bridge/extension-bridge-token)
curl -s -H "Authorization: Bearer $TOKEN" http://127.0.0.1:47831/v1/status
```

关键字段：`extensionConnected` / `tabReady` / `chatgptAuthenticated` 均为 `true`，
`extensionVersion` 等于 `extension/manifest.json` 里的 `version`。
**若 `extensionVersion` 不匹配，说明扩展未重新加载**，让用户在 `chrome://extensions` 点一次「重新加载」。

## 4. 生成图片

```bash
node dist/cli.js generate \
  --backend chrome-extension \
  --prompt "一只奶油色 chibi 小狗，纯白背景，无文字" \
  --output outputs/dog.png
```

带参考图（最多 4 张，单张 ≤8 MiB，总计 ≤20 MiB，支持 PNG/JPEG/WebP/GIF）：

```bash
node dist/cli.js generate \
  --backend chrome-extension \
  --input ref-1.png --input ref-2.jpg \
  --prompt "以第一张为主体，参考第二张的配色，生成新图" \
  --output outputs/out.png
```

约束：

- 输出路径已存在时任务会失败，除非显式加 `--force`
- stdout 是**单行 JSON**；失败时退出码非 0 且 `ok: false`
- `--input` 仅 `chrome-extension` 后端支持；`gemini` / Playwright `chatgpt` 后端会返回 `UNSUPPORTED_INPUT`

## 5. 参考图任务的执行契约（不要绕过）

带 `--input` 的任务会：

1. 若专用标签页处于已有会话，**先新开对话**（避免历史上下文压过参考图）
2. 通过 composer 的真实附件入口附加文件（必要时先点附件控件把 input 唤出）
3. 上传就绪等待**有界**（约 30 秒），超时报 `REFERENCE_IMAGE_UPLOAD_FAILED`
4. 提交后校验**新提交的用户轮次**里恰好有 N 个附件单元，不符则报 `REFERENCE_IMAGE_NOT_SUBMITTED`
5. 只有以上都通过才等待并取回图片

**验收的唯一权威证据：用户在 web 端能亲眼看到消息里的参考图缩略图。**
扩展返回 `ok: true` 不等于用户看到了图——历史上有过假阳性。

## 6. 常见故障

| 现象 | 处理 |
| --- | --- |
| `BRIDGE_UNAVAILABLE` / `Failed to fetch` | 桥没在跑或被重启中断：重新 `node dist/cli.js bridge`，确认真实监听 47831 |
| `TAB_NOT_READY`（No dedicated ChatGPT tab） | 专用标签页被关闭导致注册清空：让用户点扩展的「打开专用 ChatGPT 标签页」 |
| `TAB_NOT_READY`（无法隔离会话） | 找不到新聊天控件：让用户确认专用标签页在 ChatGPT 首页且已登录 |
| `REFERENCE_IMAGE_UPLOAD_FAILED` | 消息带诊断 JSON（输入框数量、accept、预览数、路由、原因），据此定位；通常是 ChatGPT UI 改版 |
| `REFERENCE_IMAGE_NOT_SUBMITTED` | 提交后轮次里没有附件：**不要重试成无参考图生成**，如实报告 |
| 人机检测 | 让用户在该标签页手工完成，不要绕过 |
| 版本不匹配 | 让用户在 `chrome://extensions` 重新加载扩展 |

## 7. 与 Multica 配合

仓库内含 Multica skill：`skills/image-bridge/SKILL.md`。
它调用本 CLI、解析单行 JSON，并把 `outputPath` 作为附件回贴到对应 issue 或评论。
用 Multica CLI 创建/更新：

```bash
multica skill create --name image-bridge \
  --description "Generate images through the local image-bridge CLI" \
  --content-file skills/image-bridge/SKILL.md
```
