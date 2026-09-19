# 同类项目对比与可借鉴项（2026-09-19）

对比对象：`leixyou/chatgpt-web-image-mcp`（v0.3.0，MIT，Node ≥20，MCP + CLI）。
结论来源：**实际克隆并阅读代码**（`src/chatgpt-page.js`、`src/generator.js`、`src/local-settings.js`、`src/errors.js` 等），
不是只读 README。其余四个同类项目仅来自二手调研摘要，未实测，故未纳入结论。

## 对方实现里已核实的关键事实

- 参考图支持：`src/chatgpt-page.js:98` 使用 Playwright `input.setInputFiles(sourceImages, { timeout: 15000 })`
- 选择器宽松：同处使用 `page.locator("input[type='file']").last()`
- 任务串行化：`src/generator.js:42` 用 promise 链 `this.tail.then(...)` 保证一次一个任务
- 权限位：profile 目录 `0o700`；设置文件与抓取的图片均 `0o600`（`src/local-settings.js:47-53`、`src/image-capture.js:71`）
- 错误码较少：`CHROME_NOT_FOUND` / `CDP_UNREACHABLE` / `AUTOMATION_ERROR`（`src/errors.js`）
- 多 surface 适配：`src/surface-adapters.js` + `src/surface-config.js`，覆盖固定 Project 与 `/images/` 入口
- 一致性档案：`src/consistency-profiles.js`（人物 / 画风档案）

## 本项目（image-bridge）强于对方之处

- **提交后校验**：对方上传后仅等待结果，没有"提交后的用户轮次是否真的携带附件"这一层验证
  → 本项目已实现并真机验证（`REFERENCE_IMAGE_NOT_SUBMITTED`）
- **错误码 taxonomy**：本项目 18 个码，对方 3~4 个
- **Multica 集成**：对方完全没有该层
- **选择器严谨度**：本项目为 composer 作用域 + 附件控件唤出，优于对方的 `.last()`

## 可借鉴项（按价值排序）

1. **CDP 上传通道（最高价值）**：扩展可用 `chrome.debugger` + `DOM.setFileInputFiles`，
   等价于 Playwright 的真实文件选择路径，替代当前"构造 FileList + 派发事件"的近似做法，
   对页面改版的鲁棒性更高
2. **多 surface 适配**：把 composer 流程抽象成 surface（新会话 / 固定项目 / `/images/`），
   而非单一硬编码路径
3. **一致性档案**：人物 / 画风档案；但与本项目"参考图任务强制干净会话"存在张力，
   需设计成"档案提供描述与参考图"而非依赖会话记忆
4. **逐任务输出目录**：`outputs/<job>/` + JSON 清单，便于多图与复现
5. **权限位一致性**：输出图片也用 `0o600`；profile 目录 `0o700`
6. **独立 SECURITY.md + 显眼的条款声明**

## 待讨论的问题

- CDP 路径需要 `chrome.debugger` 权限，会带来"扩展正在调试此浏览器"的常驻提示与新的权限面，
  是否值得用它换取鲁棒性？是否存在不需要该权限的等价通道？
- 若引入 CDP，`chrome.debugger.attach` 的时机与 detach 策略如何设计，避免与其他调试器冲突？
- 多 surface 是否真的有必要，还是先只做 CDP 一项收益最高？
