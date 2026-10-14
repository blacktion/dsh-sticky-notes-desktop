/**
 * dsh-sticky-notes — 便签闹钟 popup page.
 *
 * Renders either text or an image, reports nothing, and closes on
 * 关闭 / Esc / right-click. The alarm's own state (schedule, whether it already fired) is
 * never touched from here; that belongs to the host.
 */
(function () {
  'use strict';

  var bridge = window.alarm;
  var el = {
    card: document.getElementById('card'),
    label: document.getElementById('label'),
    body: document.getElementById('body'),
    text: document.getElementById('text'),
    image: document.getElementById('image'),
    foot: document.getElementById('foot'),
    close: document.getElementById('close'),
    fallback: document.getElementById('fallback'),
  };

  var closing = false;

  /** Say something went wrong instead of showing an empty card. */
  function showFallback(message) {
    if (el.fallback === null) return;
    el.fallback.hidden = false;
    el.fallback.textContent = message;
  }

  /** Ask the main process to close this alarm. Safe to call repeatedly. */
  function dismiss() {
    if (closing) return;
    closing = true;
    if (bridge === undefined || bridge === null) return;
    void bridge.close();
  }

  function render(alarm) {
    var isImage = alarm.kind === 'image';

    if (el.label !== null) {
      el.label.textContent = alarm.label && alarm.label.length > 0 ? alarm.label : '便签闹钟';
    }

    if (isImage) {
      if (el.text !== null) el.text.hidden = true;
      if (el.image === null) return;
      if (typeof alarm.imageUrl !== 'string' || alarm.imageUrl.length === 0) {
        showFallback('这条闹钟是图片类型，但没有可显示的图片。');
        return;
      }
      el.image.onerror = function () {
        showFallback('图片无法加载：' + alarm.imageUrl);
      };
      el.image.setAttribute('src', alarm.imageUrl);
      el.image.hidden = false;
      // Keep a caption available for an image alarm that also carries text.
      if (typeof alarm.text === 'string' && alarm.text.length > 0 && el.text !== null) {
        el.text.textContent = alarm.text;
        el.text.hidden = false;
        el.text.classList.add('caption');
      }
      return;
    }

    if (el.image !== null) el.image.hidden = true;
    if (el.text !== null) {
      el.text.textContent = typeof alarm.text === 'string' ? alarm.text : '';
      el.text.hidden = false;
    }
  }

  if (el.close !== null) el.close.addEventListener('click', dismiss);
  document.addEventListener('keydown', function (event) {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    dismiss();
  });
  // A right click inside the card means "go away", matching the screenshot overlay.
  document.addEventListener('contextmenu', function (event) {
    event.preventDefault();
    dismiss();
  });

  if (bridge === undefined || bridge === null) {
    showFallback('闹钟桥接不可用（preload 未加载）。按 Esc 关闭。');
    return;
  }

  bridge
    .init()
    .then(function (payload) {
      if (payload && typeof payload === 'object' && typeof payload.error === 'string') {
        showFallback('读取闹钟失败：' + payload.error);
        return;
      }
      if (!payload || typeof payload.alarm !== 'object' || payload.alarm === null) {
        showFallback('主进程未返回闹钟内容。');
        return;
      }
      render(payload.alarm);
    })
    .catch(function (error) {
      showFallback('读取闹钟失败：' + String((error && error.message) || error));
    });
})();
