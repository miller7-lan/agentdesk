'use strict';
// Windows：Bridge 常驻，不依赖打开 AgentDesk 窗口（微信管理员助理要随时能操作这台电脑）。
// - 配了 Bridge 的电脑登录 Windows 后以 --background 启动：不开窗口，只连主控、托盘里有图标。
// - 关掉窗口不退出，留在托盘；托盘菜单「退出」才真正退出。
// - %APPDATA%\AgentDesk\config.json 里 "bridgeAtLogin": false 可关掉开机启动。Mac 用 LaunchAgent 跑独立 Bridge，不走这里。
const BACKGROUND_ARG = '--background';

function startedInBackground(argv = process.argv, platform = process.platform) {
  return platform === 'win32' && argv.includes(BACKGROUND_ARG);
}

function wantsLoginItem({ platform = process.platform, packaged, bridgeConfigured, setting }) {
  return platform === 'win32' && Boolean(packaged) && Boolean(bridgeConfigured) && setting !== false;
}

// 只在和现状不一致时写注册表（HKCU\…\Run），返回是否改了。
function syncLoginItem(app, enabled) {
  const options = { path: process.execPath, args: [BACKGROUND_ARG] };
  if (Boolean(app.getLoginItemSettings(options).openAtLogin) === enabled) return false;
  app.setLoginItemSettings({ ...options, openAtLogin: enabled });
  return true;
}

function createTray({ Tray, Menu, icon, open, quit }) {
  const tray = new Tray(icon);
  tray.setToolTip('AgentDesk（后台保持连接）');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '打开 AgentDesk', click: open },
    { type: 'separator' },
    { label: '退出（断开远程连接）', click: quit },
  ]));
  tray.on('click', open);
  tray.on('double-click', open);
  return tray;
}

module.exports = { BACKGROUND_ARG, startedInBackground, wantsLoginItem, syncLoginItem, createTray };
