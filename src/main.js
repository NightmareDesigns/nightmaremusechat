'use strict';

const {
  app,
  BrowserWindow,
  Tray,
  Menu,
  globalShortcut,
  shell,
  Notification,
  nativeImage,
  ipcMain,
  session,
  dialog,
} = require('electron');
const path = require('path');
const fs = require('fs');

const MUSE_URL = process.env.MUSE_URL || 'https://muse.ai';
const CHROME_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const QUICK_CHAT_SHORTCUT = 'Alt+Space';
const FALLBACK_SHORTCUT = 'Control+Shift+Space';
const VOICE_SHORTCUT = 'Alt+V';
const VOICE_FALLBACK_SHORTCUT = 'Control+Shift+V';

// Hosts that should stay inside the app. Everything else opens in the
// user's default browser so Muse sign-in flows etc. keep working.
const INTERNAL_HOSTS = new Set([
  'muse.ai',
  'www.muse.ai',
  'auth.muse.ai', // muse.ai hands off here for sign-in — must stay in-app
  'auth.meta.ai',
  // NOTE: agent.meta.ai is deliberately NOT internal. Connector connect
  // links (Drive, Gmail, ...) must open in the system browser: in-app,
  // the connect page hands off to a Muse desktop-app deep link, and on
  // a PC with no Muse app Windows answers with the Microsoft Store
  // instead of finishing OAuth. In a real browser the flow completes
  // against the account, and the app picks the connection up on next load.
  'ai.meta.com',
  'www.meta.com',
  'meta.com',
  'accounts.meta.com',
  'www.facebook.com', // Meta account sign-in flows
  'm.facebook.com',
  'accounts.google.com', // Google sign-in for Gmail / Calendar connectors
]);

let mainWindow = null;
let quickWindow = null;
let voiceWindow = null;
let tray = null;
let isQuitting = false;
let shortcutInUse = null;
let voiceShortcutInUse = null;

// ---------------------------------------------------------------- settings

function settingsPath() {
  return path.join(app.getPath('userData'), 'settings.json');
}

function loadSettings() {
  try {
    return JSON.parse(fs.readFileSync(settingsPath(), 'utf8'));
  } catch {
    return { openAtLogin: false, closeToTray: true, notifiedAboutTray: false };
  }
}

function saveSettings(settings) {
  try {
    fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
    fs.writeFileSync(settingsPath(), JSON.stringify(settings, null, 2));
  } catch (err) {
    console.error('Could not save settings:', err);
  }
}

let settings = loadSettings();

function applyOpenAtLogin() {
  // setLoginItemSettings only does something meaningful on packaged builds,
  // but calling it in dev is harmless.
  app.setLoginItemSettings({ openAtLogin: Boolean(settings.openAtLogin) });
}

// ---------------------------------------------------------------- windows

function windowStatePath() {
  return path.join(app.getPath('userData'), 'window-state.json');
}

function loadWindowBounds() {
  try {
    const b = JSON.parse(fs.readFileSync(windowStatePath(), 'utf8'));
    if (Number.isFinite(b.width) && Number.isFinite(b.height)) return b;
  } catch {}
  return { width: 1180, height: 820 };
}

function saveWindowBounds() {
  if (!mainWindow || mainWindow.isDestroyed() || mainWindow.isMinimized()) return;
  try {
    fs.writeFileSync(windowStatePath(), JSON.stringify(mainWindow.getBounds()));
  } catch {}
}

function iconPath() {
  return path.join(__dirname, '..', 'assets', 'icon.png');
}

function bootstrapLog(line) {
  try {
    const dir = app.getPath('userData');
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(
      path.join(dir, 'bootstrap.log'),
      `${new Date().toISOString()} ${line}\n`
    );
  } catch {}
}

async function clearStaleWebCacheOnce() {
  const marker = path.join(app.getPath('userData'), 'cache-cleared-0.2.1');
  if (fs.existsSync(marker)) return;
  try {
    const { session } = require('electron');
    await session.defaultSession.clearStorageData({
      storages: ['serviceworkers', 'cachestorage'],
    });
    fs.writeFileSync(marker, '1');
    bootstrapLog('cleared stale service workers / cache storage for 0.2.1');
  } catch (err) {
    bootstrapLog('cache clear failed: ' + err.message);
  }
}

function createMainWindow() {
  const bounds = loadWindowBounds();
  mainWindow = new BrowserWindow({
    ...bounds,
    minWidth: 760,
    minHeight: 560,
    show: false,
    autoHideMenuBar: true,
    title: 'Nightmare Muse Chat',
    icon: iconPath(),
    backgroundColor: '#111111',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.webContents.setUserAgent(CHROME_UA);
  mainWindow.loadURL(MUSE_URL);
  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.on('resize', saveWindowBounds);
  mainWindow.on('move', saveWindowBounds);

  mainWindow.on('close', (event) => {
    if (!isQuitting && settings.closeToTray && tray) {
      event.preventDefault();
      mainWindow.hide();
      if (!settings.notifiedAboutTray) {
        settings.notifiedAboutTray = true;
        saveSettings(settings);
        if (Notification.isSupported()) {
          new Notification({
            title: 'Nightmare Muse Chat is still running',
            body: 'Nightmare Muse Chat was minimized to the system tray. Use the tray icon to reopen or quit.',
          }).show();
        }
      }
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  mainWindow.webContents.on('did-fail-load', (_e, code, desc, url) => {
    bootstrapLog(`did-fail-load ${code} ${desc} ${url}`);
  });
  mainWindow.webContents.on('did-finish-load', () => {
    bootstrapLog('did-finish-load ' + mainWindow.webContents.getURL());
    injectVoiceBridge();
  });

  wireNavigation(mainWindow, false);
  return mainWindow;
}

function createQuickWindow() {
  quickWindow = new BrowserWindow({
    width: 430,
    height: 600,
    show: false,
    frame: false,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    title: 'Nightmare Muse Chat — Quick Chat',
    icon: iconPath(),
    backgroundColor: '#111111',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  wireNavigation(quickWindow, false);
  quickWindow.loadFile(path.join(__dirname, 'quick-chat.html'));
  quickWindow.on('blur', () => quickWindow && quickWindow.hide());
  quickWindow.on('closed', () => {
    quickWindow = null;
  });
  return quickWindow;
}

function toggleQuickChat() {
  if (!quickWindow) createQuickWindow();
  if (quickWindow.isVisible()) {
    quickWindow.hide();
  } else {
    quickWindow.show();
    quickWindow.focus();
    quickWindow.webContents.send('quick-chat:focus');
  }
}

// ---------------------------------------------------------------- voice
// Voice is automatic: Talk sends your speech straight into the Muse
// composer, Hear reads Muse's replies aloud as they arrive. No copy,
// no paste, no second box.
//
// How it works: the main process injects src/voice-bridge.js into the
// muse.ai page (executeJavaScript). The bridge finds the composer and
// submits your words, and watches for new assistant messages with a
// MutationObserver. It talks back only through window.postMessage,
// which the preload forwards to main over IPC — the page never gets
// Node or Electron access. The messenger
// is not his code, it is Alder's house, so make it work — the old
// no-injection rule does not apply to the messenger.
//
// Talk uses Chromium's built-in speech recognition (needs internet);
// Hear uses Windows' own installed voices through speechSynthesis
// (works offline).

function loadVoiceBridgeSource() {
  try {
    return fs.readFileSync(path.join(__dirname, 'voice-bridge.js'), 'utf8');
  } catch (err) {
    bootstrapLog('voice bridge load failed: ' + err.message);
    return null;
  }
}

let voiceBridgeSource = loadVoiceBridgeSource();

function injectVoiceBridge() {
  if (!mainWindow || mainWindow.isDestroyed() || !voiceBridgeSource) return;
  var url = '';
  try { url = mainWindow.webContents.getURL(); } catch {}
  if (!/muse\.ai/.test(url)) return; // only the Muse page gets the bridge
  mainWindow.webContents.executeJavaScript(voiceBridgeSource).catch((err) => {
    bootstrapLog('voice bridge inject failed: ' + err.message);
  });
}

function sendToVoice(channel, payload) {
  if (voiceWindow && !voiceWindow.isDestroyed()) {
    voiceWindow.webContents.send(channel, payload);
  }
}

function createVoiceWindow() {
  // A normal Windows window: real frame, title bar, taskbar entry.
  // The old frameless / always-on-top / skip-taskbar window is one
  // Windows does not like — it vanishes from the taskbar, cannot be
  // Alt+Tabbed to, and the close button is easy to miss. A plain
  // window behaves like every other Windows program.
  voiceWindow = new BrowserWindow({
    width: 480,
    height: 660,
    show: false,
    resizable: true,
    minWidth: 380,
    minHeight: 520,
    title: 'Nightmare Muse Chat — Voice',
    icon: iconPath(),
    backgroundColor: '#111111',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  wireNavigation(voiceWindow, false);
  voiceWindow.loadFile(path.join(__dirname, 'voice.html'));
  voiceWindow.on('blur', () => {
    // Stay open while the user is pasting into Muse — only hide on Esc/✕.
  });
  voiceWindow.on('closed', () => {
    voiceWindow = null;
  });
  return voiceWindow;
}

function showVoiceWindow() {
  if (!voiceWindow) createVoiceWindow();
  if (voiceWindow.isMinimized()) voiceWindow.restore();
  voiceWindow.show();
  voiceWindow.focus();
}

function toggleVoice() {
  if (!voiceWindow) {
    showVoiceWindow();
    return;
  }
  if (voiceWindow.isVisible()) voiceWindow.hide();
  else showVoiceWindow();
}

// --- One crown: only one of Alder's houses is awake at a time ------------
// Shared with the companion app: a tiny lock file in
// %APPDATA%/NightmareDesigns says who's awake. When the other app takes the
// crown, this window hides (sleeps in the tray); opening the chat again
// takes the crown back and this app sleeps.
const CROWN_DIR = path.join(app.getPath('appData'), 'NightmareDesigns');
const CROWN_FILE = path.join(CROWN_DIR, 'surface-lock.json');
function readCrown() { try { return JSON.parse(fs.readFileSync(CROWN_FILE, 'utf8')); } catch { return null; } }
function claimCrown() {
  try { fs.mkdirSync(CROWN_DIR, { recursive: true }); fs.writeFileSync(CROWN_FILE, JSON.stringify({ holder: 'chat', ts: Date.now() })); } catch { /* best effort */ }
}
function watchCrown() {
  setInterval(() => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (mainWindow.isVisible() && mainWindow.isFocused()) { claimCrown(); return; }
    const crown = readCrown();
    if (crown && crown.holder !== 'chat' && Date.now() - crown.ts < 6000 && mainWindow.isVisible()) {
      mainWindow.hide(); // the other app has the crown — sleep
    }
  }, 2000);
}

function showMainWindow() {
  claimCrown();
  if (!mainWindow) createMainWindow();
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

// Keep Muse / Meta / Google sign-in inside the app; open everything else
// in the default browser. Two rules that keep link-outs (Drive, Gmail,
// any connector) from ever reaching the Microsoft Store:
//   - only http(s) URLs ever leave the app, via shell.openExternal;
//   - any other protocol (muse://, ms-windows-store://, ...) is denied
//     and logged, never handed to the OS, because an unhandled protocol
//     is precisely what makes Windows open the Store.
// Navigation rules, wired per window, in two flavors:
//   - main windows: outside hosts leave to the system browser;
//   - popups (window.open): the OAuth chain (agent.meta.ai) is allowed
//     inside the popup, because the connect page redirects through it
//     and yanking those redirects to the browser would stall the flow.
// Every window, popup or not, blocks non-http(s) protocols outright:
// an unhandled protocol is what summons the Microsoft Store.
// And no http(s) popup is ever denied: a denied window.open returns
// null to the page, and the page answers with "Couldn't open the
// connection page. Please allow pop-ups and try again."
// One more honest popup: about:blank. Connect buttons commonly open a
// blank popup synchronously on the click (to keep the user gesture),
// then navigate it to the connect URL once the API answers. Denying
// about:blank denies the whole flow before any URL is even involved —
// that is what v0.3.3 was still doing. Blank popups are allowed; what
// they navigate to is still ruled by will-navigate below.
const POPUP_HOSTS = new Set([...INTERNAL_HOSTS, 'agent.meta.ai']);
const wiredWindows = new WeakSet();
function wireNavigation(win, isPopup) {
  if (wiredWindows.has(win.webContents)) return;
  wiredWindows.add(win.webContents);
  const allowed = isPopup ? POPUP_HOSTS : INTERNAL_HOSTS;
  win.webContents.on('will-navigate', (event, url) => {
    let parsed = null;
    try {
      parsed = new URL(url);
    } catch {
      event.preventDefault();
      return;
    }
    if (url === 'about:blank') return; // a popup's blank start; ruled later
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      bootstrapLog('blocked non-http navigation: ' + parsed.protocol + ' ' + url.slice(0, 120));
      event.preventDefault();
      return;
    }
    if (!allowed.has(parsed.hostname)) {
      event.preventDefault();
      shell.openExternal(url);
    }
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url === 'about:blank') {
      bootstrapLog('popup about:blank -> allow');
      return { action: 'allow' };
    }
    let parsed = null;
    try {
      parsed = new URL(url);
    } catch {
      bootstrapLog('popup unparsable -> deny: ' + url.slice(0, 120));
      return { action: 'deny' };
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      bootstrapLog('blocked non-http popup: ' + parsed.protocol + ' ' + url.slice(0, 120));
      return { action: 'deny' };
    }
    bootstrapLog('popup ' + url.slice(0, 120) + ' -> allow');
    return { action: 'allow' };
  });
  // A window's own popups inherit popup rules.
  win.webContents.on('did-create-window', (child) => wireNavigation(child, true));
}

// ---------------------------------------------------------------- tray / menu

function buildTray() {
  const image = nativeImage
    .createFromPath(iconPath())
    .resize({ width: 20, height: 20 });
  tray = new Tray(image);
  tray.setToolTip('Nightmare Muse Chat');

  const refreshMenu = () => {
    const menu = Menu.buildFromTemplate([
      { label: 'Open Nightmare Muse Chat', click: showMainWindow },
      {
        label: `Quick Chat  (${shortcutInUse || QUICK_CHAT_SHORTCUT})`,
        click: toggleQuickChat,
      },
      {
        label: `Voice — talk & hear  (${voiceShortcutInUse || VOICE_SHORTCUT})`,
        click: toggleVoice,
      },
      { type: 'separator' },
      {
        label: 'Start on login',
        type: 'checkbox',
        checked: Boolean(settings.openAtLogin),
        click: (item) => {
          settings.openAtLogin = item.checked;
          saveSettings(settings);
          applyOpenAtLogin();
          refreshMenu();
        },
      },
      {
        label: 'Close button minimizes to tray',
        type: 'checkbox',
        checked: Boolean(settings.closeToTray),
        click: (item) => {
          settings.closeToTray = item.checked;
          saveSettings(settings);
          refreshMenu();
        },
      },
      { type: 'separator' },
      {
        label: 'Quit Nightmare Muse Chat',
        click: () => {
          isQuitting = true;
          app.quit();
        },
      },
    ]);
    tray.setContextMenu(menu);
  };

  refreshMenu();
  tray.on('click', showMainWindow);
  tray.on('double-click', showMainWindow);
}

function buildAppMenu() {
  const template = [
    {
      label: 'Nightmare Muse Chat',
      submenu: [
        { label: 'Open Nightmare Muse Chat', accelerator: 'Control+Shift+O', click: showMainWindow },
        { label: 'Quick Chat', click: toggleQuickChat },
        { label: 'Voice — talk & hear', accelerator: 'Alt+V', click: toggleVoice },
        { type: 'separator' },
        {
          label: 'Quit',
          accelerator: 'Control+Q',
          click: () => {
            isQuitting = true;
            app.quit();
          },
        },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Help',
      submenu: [
        {
          label: 'About Nightmare Muse Chat',
          click: () => {
            dialog.showMessageBox({
              type: 'info',
              title: 'About Nightmare Muse Chat',
              message: 'Nightmare Muse Chat v' + app.getVersion(),
              detail:
                'Unofficial community project. Not affiliated with Meta.\n' +
                'A Windows desktop client made for use with Muse.',
              buttons: ['OK'],
            });
          },
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ---------------------------------------------------------------- IPC

ipcMain.on('quick-chat:open-main', () => {
  if (quickWindow) quickWindow.hide();
  showMainWindow();
});
ipcMain.on('quick-chat:hide', () => {
  if (quickWindow) quickWindow.hide();
});
ipcMain.on('voice:open', () => {
  if (quickWindow) quickWindow.hide();
  showVoiceWindow();
});
ipcMain.on('voice:hide', () => {
  if (voiceWindow) voiceWindow.hide();
});

// Talk: the Voice window recognised speech — put it in the Muse
// composer and submit it. No clipboard, no pasting.
ipcMain.on('voice:send-message', (_event, text) => {
  if (!mainWindow || mainWindow.isDestroyed() || !text) return;
  var safe = String(text).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  mainWindow.webContents.executeJavaScript(
    "window.__nightmareVoice ? window.__nightmareVoice.send('" + safe + "') : false"
  ).catch((err) => {
    bootstrapLog('voice send failed: ' + err.message);
    sendToVoice('voice:send-result', { type: 'send-error', payload: { reason: 'inject-failed' } });
  });
});
// Hear: the bridge saw a new Muse reply — read it aloud in the Voice window.
ipcMain.on('voice:muse-reply', (_event, text) => {
  if (text) sendToVoice('voice:muse-reply', text);
});
ipcMain.on('voice:bridge-status', (_event, status) => {
  sendToVoice('voice:bridge-status', status);
});
ipcMain.on('voice:send-result', (_event, result) => {
  sendToVoice('voice:send-result', result);
});

// ---------------------------------------------------------------- lifecycle

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', showMainWindow);

  app.whenReady().then(async () => {
    bootstrapLog('Nightmare Muse Chat v' + app.getVersion() + ' starting');
    // Popups are born with Electron's default UA unless the session says
    // otherwise, and Google is picky about that. One UA for the whole
    // session: popups look like plain Chrome, same as the main window.
    session.defaultSession.setUserAgent(CHROME_UA);
    watchCrown();
    applyOpenAtLogin();
    buildAppMenu();
    await clearStaleWebCacheOnce();
    createMainWindow();
    createQuickWindow();
    createVoiceWindow();
    buildTray();

    shortcutInUse = QUICK_CHAT_SHORTCUT;
    if (!globalShortcut.register(QUICK_CHAT_SHORTCUT, toggleQuickChat)) {
      shortcutInUse = FALLBACK_SHORTCUT;
      if (!globalShortcut.register(FALLBACK_SHORTCUT, toggleQuickChat)) {
        shortcutInUse = null;
        console.warn('Could not register a quick-chat shortcut.');
      }
    }
    voiceShortcutInUse = VOICE_SHORTCUT;
    if (!globalShortcut.register(VOICE_SHORTCUT, toggleVoice)) {
      voiceShortcutInUse = VOICE_FALLBACK_SHORTCUT;
      if (!globalShortcut.register(VOICE_FALLBACK_SHORTCUT, toggleVoice)) {
        voiceShortcutInUse = null;
        console.warn('Could not register a voice shortcut.');
      }
    }
    buildTray(); // rebuild so the menu shows the shortcuts that actually registered

    app.on('activate', showMainWindow);
  });

  app.on('before-quit', () => {
    isQuitting = true;
  });

  app.on('will-quit', () => {
    globalShortcut.unregisterAll();
  });

  // On Windows the app lives in the tray, so don't quit when windows close.
  app.on('window-all-closed', () => {
    if (process.platform !== 'win32' && !settings.closeToTray) app.quit();
  });
}
