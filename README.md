# zed-excalidraw-preview

Read-only previews of Excalidraw drawings in Zed, including Obsidian Excalidraw Markdown files. Render a temporary PNG in the editor or open a local browser canvas with pan, zoom, and reload.

**Status:** developer preview `v0.2.1`. Registry review is pending in [PR #7939](https://github.com/zed-industries/extensions/pull/7939); not yet published in the Zed extension registry. The registry extension ID is `excalidraw`; the GitHub project name is `zed-excalidraw-preview`.

## Zed extension

Install `zed-extension/` using **zed: install dev extension**. Open a drawing, invoke code actions (`Cmd+.` on macOS), and choose:

- **Preview Excalidraw as PNG**
- **Preview Excalidraw in Browser**
- **Excalidraw: View Download Log**

The extension downloads its versioned helper from this repository's GitHub release. Chromium is downloaded only on the first PNG preview. Setup stages, actual download percentages, cancellation, and detailed logs are exposed through Zed's native language-server UI. Bootstrap has stage-only status because Zed's extension API does not provide byte-progress callbacks.

Previews use the currently open editor document, including unsaved changes. No source edits or automatic keymap/settings changes are performed by the extension. Ordinary Markdown files are ignored.

## Supported files and limits

- `.excalidraw` JSON scenes and Excalidraw JSON documents.
- Obsidian `.md` / `.excalidraw.md` drawings containing a `## Drawing` section with `compressed-json` (LZ-String Base64) or `json` fenced data.
- Embedded image data and locally served drawing fonts.
- Obsidian external attachments and embedded notes are not resolved.
- The browser server is local/loopback-only and expires after 30 minutes without requests. Remote-worktree browser forwarding is not supported.
- PNG output is capped at 8192 pixels on its longest side; input and decoded scenes are capped at 50 MiB.
- Tested locally on macOS Apple Silicon. Windows has not been manually verified.

## Standalone Tasks

With Node.js 22.12 or later:

```sh
npm ci
npm run setup
npm run install:zed
```

The optional installer backs up and preserves existing Zed configuration. It installs `Cmd+Ctrl+Option+P` for temporary PNG previews and `Cmd+Ctrl+Option+B` for browser previews. These are separate from the marketplace extension and are not installed automatically by it.

## Development checks

```sh
npm run build
npm test
npm audit
rustup target add wasm32-wasip2
cargo test --manifest-path zed-extension/Cargo.toml
cargo build --manifest-path zed-extension/Cargo.toml --target wasm32-wasip2 --release
npm run package:runtime
```

The self-contained runtime archive is written under `releases/`. It excludes private drawings, runtime state, project tests, development scripts, and internal notes. Selected dependency packages are preserved intact: directories named `test` may contain required runtime modules. Archive tests execute the packaged Playwright CLI, not just its development-directory counterpart. A required manual dev-extension check in Zed must precede a registry submission.

## License

Original project and extension code: MIT. Dependencies and fonts retain their original licenses; notices accompany the runtime archive and are maintained under `third-party/`.
