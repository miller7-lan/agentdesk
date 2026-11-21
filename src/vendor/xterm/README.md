# xterm.js（终端面板）

- `xterm.js`、`xterm.css`：@xterm/xterm 6.0.0（MIT，见 LICENSE），取自 npm 包的 `lib/xterm.js`（UMD，暴露 `window.Terminal`）与 `css/xterm.css`。
- `addon-fit.js`：@xterm/addon-fit 0.11.0（MIT，见 LICENSE.addon-fit），UMD，暴露 `window.FitAddon.FitAddon`。
- 只删去了末行的 sourceMappingURL 注释；`scripts/prepare-desktop.js` 在安装了 devDependencies 时核对这三个文件与 node_modules 中的同版本一致。
