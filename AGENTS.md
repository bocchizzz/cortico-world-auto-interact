# AGENTS.md

面向这个包的发布清单。写法的规矩见 Cortico 的
[docs/worlds.md](https://github.com/Pal-AI-Lab/Cortico/blob/main/docs/worlds.md) 与
[docs/extensions.md](https://github.com/Pal-AI-Lab/Cortico/blob/main/docs/extensions.md)。

- [ ] **契约版本**：`cortico.api` 与 `pnpm check:extension` 打印的 world 契约版本一致（现在 6）。
- [ ] **自描述**：改过工具、事件类型或 `src/ENV_PROMPT.md` 后跑 `pnpm describe:extension`，提交 `describe.json`。
- [ ] **面板产物**：改过 `src/webui/` 后跑 `pnpm build:webui`，提交 `dist/webui.js` 与 `dist/webui.css`。
- [ ] **标签**：`cortico.tags` 按索引仓 [TAGS.md](https://github.com/Pal-AI-Lab/cortico-extensions/blob/main/TAGS.md) 选；没有合适的就留空。
- [ ] **CHANGELOG.md** 有要发布版本的 `## <版本>` 一节。
- [ ] **`os`**：这个包只用 Windows API，保持 `"os": ["win32"]`。
- [ ] **`pnpm test` 与 `pnpm typecheck`** 通过。
- [ ] **`pnpm check:extension <包目录>`**（在 Cortico 检出根下）通过；它核对 `describe.json` 与代码一致。
- [ ] 发布由包所有者决定；本包未发布到 npm。
