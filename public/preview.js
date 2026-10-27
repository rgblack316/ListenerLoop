/* Live preview for the show editor: the admin page posts the form values here as they change. */
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };

  function fmt(seconds) {
    var s = Math.max(0, Math.floor(seconds));
    return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
  }

  function applyAccent(color) {
    if (!/^#[0-9a-f]{6}$/i.test(color)) return;
    var r = parseInt(color.slice(1, 3), 16), g = parseInt(color.slice(3, 5), 16), b = parseInt(color.slice(5, 7), 16);
    var luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
    document.documentElement.style.setProperty('--accent', color);
    document.documentElement.style.setProperty('--on-accent', luminance > 0.6 ? '#111111' : '#ffffff');
  }

  function apply(v) {
    var label = v.buttonLabel || 'Leave a voicemail';
    $('pv-button').textContent = label;
    $('pv-title').textContent = label;
    $('pv-prompt').textContent = v.promptText || '';
    var seconds = parseInt(v.maxSeconds, 10);
    $('pv-limit').textContent = fmt(isFinite(seconds) ? seconds : 180);
    $('pv-email').hidden = !v.askEmail;
    var consent = (v.consentText || '').trim();
    $('pv-consent').hidden = !consent;
    $('pv-consent-text').textContent = consent;
    $('pv-thanks').textContent = v.thanksText || '';
    applyAccent(v.accentColor);
  }

  window.addEventListener('message', function (e) {
    if (e.origin !== location.origin || !e.data || e.data.source !== 'listenerloop-admin') return;
    apply(e.data.values || {});
  });
  try { parent.postMessage({ source: 'listenerloop-preview', type: 'ready' }, location.origin); } catch (err) { /* not framed */ }
})();
