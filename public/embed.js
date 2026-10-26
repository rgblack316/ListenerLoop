/* ListenerLoop embed loader.
 * <script src="https://YOUR-APP/embed.js" data-site-key="pk_..." async></script>
 * Optional: data-target="#some-element" mounts the button there instead of after the script tag.
 */
(function () {
  'use strict';

  var script = document.currentScript;
  if (!script) return;
  var key = script.getAttribute('data-site-key');
  if (!key) {
    console.error('[ListenerLoop] Missing data-site-key on the embed script tag.');
    return;
  }
  var base = new URL(script.src, location.href).origin;
  var targetSelector = script.getAttribute('data-target');

  var button = document.createElement('button');
  button.type = 'button';
  button.textContent = script.getAttribute('data-label') || 'Leave a voicemail';
  button.setAttribute('aria-haspopup', 'dialog');
  var accent = '#21649e';
  var onAccent = '#ffffff';

  function styleButton() {
    var s = button.style;
    s.cssText = '';
    s.background = accent;
    s.color = onAccent;
    s.border = '0';
    s.borderRadius = '999px';
    s.padding = '12px 22px';
    s.font = '600 16px/1.2 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
    s.cursor = 'pointer';
  }
  styleButton();

  function mount() {
    var target = targetSelector ? document.querySelector(targetSelector) : null;
    if (target) target.appendChild(button);
    else if (script.parentNode) script.parentNode.insertBefore(button, script.nextSibling);
    else document.body.appendChild(button);
  }

  // Best effort: pick up the show's label and color. Without CORS access the defaults stay.
  fetch(base + '/api/public/config?key=' + encodeURIComponent(key))
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (data) {
      if (!data || !data.show) return;
      if (!script.getAttribute('data-label') && data.show.buttonLabel) button.textContent = data.show.buttonLabel;
      var c = data.show.accentColor;
      if (/^#[0-9a-f]{6}$/i.test(c)) {
        var lum = (0.299 * parseInt(c.slice(1, 3), 16) + 0.587 * parseInt(c.slice(3, 5), 16) + 0.114 * parseInt(c.slice(5, 7), 16)) / 255;
        accent = c;
        onAccent = lum > 0.6 ? '#111111' : '#ffffff';
        styleButton();
      }
    })
    .catch(function () { /* keep defaults */ });

  var overlay = null;
  var previousOverflow = '';

  function close() {
    if (!overlay) return;
    window.removeEventListener('message', onMessage);
    document.removeEventListener('keydown', onKey, true);
    overlay.remove();
    overlay = null;
    document.documentElement.style.overflow = previousOverflow;
    button.focus();
  }

  function onKey(e) {
    if (e.key === 'Escape') { e.stopPropagation(); close(); }
  }

  function onMessage(e) {
    if (e.origin !== base) return;
    var d = e.data;
    if (!d || d.source !== 'listenerloop') return;
    if (d.type === 'vm:close') close();
    if (d.type === 'vm:submitted') {
      button.dispatchEvent(new CustomEvent('listenerloop:submitted', { bubbles: true }));
    }
  }

  function open() {
    if (overlay) return;
    overlay = document.createElement('div');
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-label', 'Leave a voicemail');
    overlay.style.cssText = 'position:fixed;inset:0;z-index:2147483000;display:flex;align-items:center;justify-content:center;background:rgba(10,15,20,.6);padding:16px;';
    overlay.addEventListener('click', function (e) { if (e.target === overlay) close(); });

    var frame = document.createElement('iframe');
    frame.src = base + '/widget?key=' + encodeURIComponent(key);
    frame.title = 'Leave a voicemail';
    frame.setAttribute('allow', 'microphone');
    frame.style.cssText = 'border:0;border-radius:16px;background:#fff;width:100%;max-width:460px;height:min(680px,100%);box-shadow:0 20px 60px rgba(0,0,0,.35);';
    overlay.appendChild(frame);

    previousOverflow = document.documentElement.style.overflow;
    document.documentElement.style.overflow = 'hidden';
    document.body.appendChild(overlay);
    window.addEventListener('message', onMessage);
    document.addEventListener('keydown', onKey, true);
    frame.focus();
  }

  button.addEventListener('click', open);
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
  else mount();
})();
