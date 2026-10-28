'use strict';
// Nightmare Chat — voice bridge (runs INSIDE the muse.ai page).
//
// This script is injected by the main process into the Muse web app so
// Voice can be automatic: you talk, your words go straight into the
// composer and are sent; Muse replies, her words come straight back
// and are read aloud. No copy, no paste, no second box.
//
// It talks to the app through window.postMessage — the preload (which
// runs in the page's isolated world) forwards those messages to main
// over IPC. The page never gets Node or Electron access.
//
// Two jobs:
//   1. send(text) — put text into the composer and submit it.
//   2. watch() — a MutationObserver that reports new assistant
//      messages as they appear.
//
// Selectors are deliberately broad: muse.ai's DOM is a React app and
// its class names change. We try several composer shapes (textarea,
// contenteditable, role=textbox) and several ways of spotting an
// assistant message (data-message-author-role, data-testid, aria, and
// a last-resort "longest new text block"). If the composer is not
// found, send() reports back so the Voice window can say so instead
// of silently doing nothing.

(function () {
  if (window.__nightmareVoice) return; // already injected (page reloads re-inject)
  var NS = 'nightmare-voice';

  function post(type, payload) {
    try {
      // Post to window.parent: in a top-level window that is the window
      // itself (Nightmare Chat), in a <webview> guest it is the embedder
      // page (the embedder window), which forwards it on.
      var target = window.parent || window;
      target.postMessage({ __nightmareVoice: true, type: type, payload: payload }, '*');
    } catch (e) { /* page is gone */ }
  }

  // ------------------------------------------------------------ composer
  function findComposer() {
    var candidates = [
      'textarea[data-testid*="composer" i]',
      'textarea[placeholder*="Ask" i]',
      'textarea[placeholder*="Message" i]',
      'div[contenteditable="true"][role="textbox"]',
      '[contenteditable="true"]',
      'textarea'
    ];
    for (var i = 0; i < candidates.length; i++) {
      var els = document.querySelectorAll(candidates[i]);
      for (var j = 0; j < els.length; j++) {
        var el = els[j];
        if (el.offsetParent !== null) return el; // visible
      }
    }
    return null;
  }

  function setComposerText(el, text) {
    el.focus();
    if (el.isContentEditable) {
      // contenteditable: insertText fires the input event React listens for.
      try {
        document.execCommand('insertText', false, text);
        return true;
      } catch (e) {
        el.textContent = text;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
      }
    }
    // input / textarea: use the native setter so React's onChange fires.
    try {
      var proto = el.tagName === 'TEXTAREA'
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
      var setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
      setter.call(el, text);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    } catch (e) {
      el.value = text;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    }
  }

  function findSendButton(composer) {
    var btns = document.querySelectorAll('button[aria-label*="send" i], button[title*="send" i], button[data-testid*="send" i]');
    for (var i = 0; i < btns.length; i++) {
      if (!btns[i].disabled && btns[i].offsetParent !== null) return btns[i];
    }
    // Fallback: the last enabled button inside the composer's form.
    var form = composer && composer.closest ? composer.closest('form') : null;
    if (form) {
      var all = form.querySelectorAll('button[type="submit"], button');
      for (var k = all.length - 1; k >= 0; k--) {
        if (!all[k].disabled && all[k].offsetParent !== null) return all[k];
      }
    }
    return null;
  }

  function send(text) {
    var composer = findComposer();
    if (!composer) {
      post('send-error', { reason: 'composer-not-found' });
      return false;
    }
    if (!setComposerText(composer, text)) {
      post('send-error', { reason: 'set-text-failed' });
      return false;
    }
    var btn = findSendButton(composer);
    if (btn) {
      btn.click();
      post('sent', { text: text });
      return true;
    }
    // No button found — try Enter on the composer (single-line submit).
    try {
      composer.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true }));
      post('sent', { text: text });
      return true;
    } catch (e) {
      post('send-error', { reason: 'submit-failed' });
      return false;
    }
  }

  // ------------------------------------------------------------ replies
  var seenTexts = new Set();
  var lastReply = '';

  function isAssistantNode(node) {
    if (!node || node.nodeType !== 1) return false;
    var el = node;
    if (el.getAttribute) {
      var role = el.getAttribute('data-message-author-role');
      if (role === 'assistant') return true;
      var testid = el.getAttribute('data-testid') || '';
      if (/assistant/i.test(testid)) return true;
    }
    if (el.querySelector) {
      var inner = el.querySelector('[data-message-author-role="assistant"]');
      if (inner) return true;
    }
    return false;
  }

  function textOf(el) {
    return (el.innerText || el.textContent || '').trim();
  }

  function reportReply(text) {
    if (!text || text.length < 2) return;
    if (text === lastReply) return;
    lastReply = text;
    post('muse-reply', { text: text });
  }

  function scanNode(node) {
    if (!node) return;
    if (isAssistantNode(node)) {
      var t = textOf(node);
      if (t && !seenTexts.has(t)) {
        seenTexts.add(t);
        reportReply(t);
      }
      return;
    }
    if (node.querySelectorAll) {
      var found = node.querySelectorAll('[data-message-author-role="assistant"]');
      for (var i = 0; i < found.length; i++) {
        var ft = textOf(found[i]);
        if (ft && !seenTexts.has(ft)) {
          seenTexts.add(ft);
          reportReply(ft);
        }
      }
    }
  }

  function watch() {
    var observer = new MutationObserver(function (mutations) {
      for (var i = 0; i < mutations.length; i++) {
        var m = mutations[i];
        for (var j = 0; j < m.addedNodes.length; j++) {
          scanNode(m.addedNodes[j]);
        }
        // Streaming replies mutate text in place — re-check the target.
        if (m.type === 'characterData' && m.target && m.target.parentElement) {
          var parent = m.target.parentElement.closest
            ? m.target.parentElement.closest('[data-message-author-role="assistant"]')
            : null;
          if (parent) {
            var pt = textOf(parent);
            if (pt && !seenTexts.has(pt)) {
              seenTexts.add(pt);
              reportReply(pt);
            }
          }
        }
      }
    });
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true
    });
    // Catch any assistant messages already on screen.
    scanNode(document.body);
  }

  // ------------------------------------------------------------ boot
  window.__nightmareVoice = {
    send: send,
    status: function () {
      return { composer: !!findComposer(), replySeen: lastReply.length > 0 };
    }
  };

  function boot() {
    try {
      watch();
      post('bridge-ready', { composer: !!findComposer() });
    } catch (e) {
      post('bridge-error', { reason: String(e && e.message || e) });
    }
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
