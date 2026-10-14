/**
 * Popup renderer: draw the rows and report a click.
 *
 * The page owns no state beyond "has this been answered", because answering twice
 * (a fast double click, or a click racing the pointer-outside dismissal) must not
 * dispatch two actions.
 */
(function () {
  'use strict';

  var bridge = window.popup;
  var sheet = document.getElementById('sheet');
  var fallback = document.getElementById('fallback');

  var answered = false;

  /** Show a blocking, non-throwing explanation instead of a blank window. */
  function showFallback(message) {
    if (fallback === null) return;
    fallback.hidden = false;
    fallback.textContent = message;
  }

  function answer(id) {
    if (answered) return;
    answered = true;
    if (bridge === undefined || bridge === null) return;
    void bridge.choose(id);
  }

  function render(items) {
    if (sheet === null) return;
    sheet.textContent = '';
    for (var i = 0; i < items.length; i += 1) {
      var item = items[i];
      var row = document.createElement('button');
      row.type = 'button';
      row.className = 'row';
      row.setAttribute('data-id', String(item.id));
      row.setAttribute('role', 'menuitem');

      var glyph = document.createElement('span');
      glyph.className = 'glyph';
      glyph.textContent = typeof item.glyph === 'string' ? item.glyph : '';
      row.appendChild(glyph);

      var label = document.createElement('span');
      label.textContent = typeof item.label === 'string' ? item.label : String(item.id);
      row.appendChild(label);

      row.addEventListener('click', function (event) {
        answer(String(event.currentTarget.getAttribute('data-id')));
      });
      sheet.appendChild(row);
    }
  }

  document.addEventListener('keydown', function (event) {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    if (answered) return;
    answered = true;
    if (bridge !== undefined && bridge !== null) void bridge.dismiss();
  });

  // A right click inside the popup means "go away", matching the screenshot overlay.
  document.addEventListener('contextmenu', function (event) {
    event.preventDefault();
    if (answered) return;
    answered = true;
    if (bridge !== undefined && bridge !== null) void bridge.dismiss();
  });

  if (bridge === undefined || bridge === null) {
    showFallback('弹窗桥接不可用（preload 未加载），请按 Esc 关闭。');
    return;
  }

  bridge
    .items()
    .then(function (items) {
      if (!Array.isArray(items) || items.length === 0) {
        showFallback('没有可用的菜单项。');
        return;
      }
      render(items);
    })
    .catch(function (error) {
      showFallback('加载菜单项失败：' + String((error && error.message) || error));
    });
})();
