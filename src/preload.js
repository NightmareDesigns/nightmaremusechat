'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// Minimal, safe bridge for the bundled pages only (quick-chat, voice).
// The remote Muse web app itself gets no Node / Electron access — the
// voice bridge (src/voice-bridge.js) runs in the page and talks to us
// only through window.postMessage, which we forward to main over IPC.
contextBridge.exposeInMainWorld('museDesktop', {
  openMain: () => ipcRenderer.send('quick-chat:open-main'),
  hideQuickChat: () => ipcRenderer.send('quick-chat:hide'),
  onFocusQuickChat: (callback) => {
    if (typeof callback === 'function') {
      ipcRenderer.on('quick-chat:focus', callback);
    }
  },
  openVoice: () => ipcRenderer.send('voice:open'),
  hideVoice: () => ipcRenderer.send('voice:hide'),

  // --- Voice (automatic): Talk sends straight into the Muse composer,
  // Hear reads Muse's replies aloud as they arrive. No copy/paste.
  voice: {
    sendMessage: (text) => ipcRenderer.send('voice:send-message', text),
    onMuseReply: (callback) => {
      if (typeof callback === 'function') {
        ipcRenderer.on('voice:muse-reply', (_event, text) => callback(text));
      }
    },
    onBridgeStatus: (callback) => {
      if (typeof callback === 'function') {
        ipcRenderer.on('voice:bridge-status', (_event, status) => callback(status));
      }
    },
    onSendResult: (callback) => {
      if (typeof callback === 'function') {
        ipcRenderer.on('voice:send-result', (_event, result) => callback(result));
      }
    },
  },
});

// The voice bridge runs in the page's main world and posts messages
// here. Forward them to main over IPC. This listener only exists so
// the page can report replies / status — it cannot reach Node.
window.addEventListener('message', (event) => {
  var data = event && event.data;
  if (!data || data.__nightmareVoice !== true) return;
  if (data.type === 'muse-reply') {
    ipcRenderer.send('voice:muse-reply', data.payload && data.payload.text);
  } else if (data.type === 'bridge-ready' || data.type === 'bridge-error') {
    ipcRenderer.send('voice:bridge-status', { type: data.type, payload: data.payload || {} });
  } else if (data.type === 'sent' || data.type === 'send-error') {
    ipcRenderer.send('voice:send-result', { type: data.type, payload: data.payload || {} });
  }
});
