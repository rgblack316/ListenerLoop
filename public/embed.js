/* ListenerLoop embed loader.
 * <script src="https://YOUR-APP/embed.js" data-site-key="pk_..." async></script>
 *
 * Optional attributes on the script tag:
 *   data-target="#some-element"   mount there instead of after the script tag
 *   data-style="card|button"      a card with a short message (default), or just the button
 *   data-label="Leave a voicemail" button text (overrides the show's setting)
 *   data-blurb="..."              the short message above the button (overrides the show's setting)
 *   data-theme="light|dark"       card colors (default light)
 *   data-align="left|center"      where the card sits in its container (default left)
 *
 * Everything is styled through the CSSOM (no <style> tags, no inline style attributes), so strict
 * Content-Security-Policy headers on the host page do not block it. It lives in a shadow root, so
 * the site's own CSS cannot restyle it.
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
  var FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
  var BRAND_URL = 'https://github.com/rgblack316/ListenerLoop';
  var LOGO_PATH = 'M143 63C184 63 217 96 217 137L217 372L390 372C431 372 464 405 464 447C464 488 431 521 390 521L253 521C212 521 178 488 178 447L178 410L143 410C102 410 68 377 68 336L68 137C68 96 102 63 143 63ZM143 102C123 102 107 118 107 137L107 336C107 356 123 372 143 372L178 372L178 137C178 118 162 102 143 102ZM217 411L217 447C217 467 233 482 253 482L390 482C410 482 425 467 425 447C425 427 410 411 390 411Z';

  var dark = script.getAttribute('data-theme') === 'dark';
  var center = script.getAttribute('data-align') === 'center';
  var state = {
    name: '',
    style: script.getAttribute('data-style') === 'button' ? 'button' : script.getAttribute('data-style') === 'card' ? 'card' : null,
    blurb: script.getAttribute('data-blurb') || '',
    label: script.getAttribute('data-label') || '',
    accent: '#21649e',
    onAccent: '#ffffff',
  };
  var theme = dark
    ? { bg: '#14181d', text: '#eef2f6', muted: '#a3afbb', line: '#2b343e', logo: '#31aaa5' }
    : { bg: '#ffffff', text: '#1b2733', muted: '#5b6773', line: '#dfe5ec', logo: '#21649e' };

  // Sets styles one property at a time: assigning style.cssText counts as an inline style and is
  // blocked by strict CSPs, while setProperty is not. Properties from a previous call that are no longer wanted are removed.
  function css(el, props) {
    var before = el.__ll || [];
    before.forEach(function (k) { if (!(k in props)) el.style.removeProperty(k); });
    var now = [];
    for (var k in props) { el.style.setProperty(k, props[k]); now.push(k); }
    el.__ll = now;
  }

  // ---- build the elements
  var host = document.createElement('div');
  host.setAttribute('data-listenerloop', '');
  var root = host.attachShadow ? host.attachShadow({ mode: 'open' }) : host;

  var card = document.createElement('section');
  var title = document.createElement('p');
  var blurb = document.createElement('p');
  var button = document.createElement('button');
  var foot = document.createElement('a');
  button.type = 'button';
  button.setAttribute('aria-haspopup', 'dialog');

  var svgNS = 'http://www.w3.org/2000/svg';
  var logo = document.createElementNS(svgNS, 'svg');
  logo.setAttribute('viewBox', '0 0 575 575');
  logo.setAttribute('width', '16');
  logo.setAttribute('height', '16');
  logo.setAttribute('aria-hidden', 'true');
  var logoPath = document.createElementNS(svgNS, 'path');
  logoPath.setAttribute('d', LOGO_PATH);
  logoPath.setAttribute('fill', theme.logo);
  logoPath.setAttribute('fill-rule', 'evenodd');
  logo.appendChild(logoPath);
  var footText = document.createElement('span');
  foot.appendChild(logo);
  foot.appendChild(footText);
  foot.href = BRAND_URL;
  foot.target = '_blank';
  foot.rel = 'noopener noreferrer';
  footText.appendChild(document.createTextNode('Powered by '));
  var brandName = document.createElement('strong');
  brandName.textContent = 'ListenerLoop';
  footText.appendChild(brandName);

  card.appendChild(title);
  card.appendChild(blurb);
  card.appendChild(button);
  card.appendChild(foot);
  root.appendChild(card);

  function isCard() { return state.style !== 'button'; }

  function defaultBlurb() {
    return 'Have a question, a comment or a story to share? Record a voicemail right from your browser. It may be played on the show.';
  }

  function paint() {
    var withCard = isCard();
    css(host, withCard
      ? { display: 'block', margin: center ? '16px auto' : '16px 0', 'max-width': '380px', width: '100%', 'box-sizing': 'border-box' }
      : { display: 'inline-block', margin: '0' });
    css(card, withCard
      ? { 'box-sizing': 'border-box', background: theme.bg, color: theme.text, border: '1px solid ' + theme.line, 'border-radius': '16px', padding: '20px', 'text-align': 'center', font: '400 15px/1.45 ' + FONT, 'box-shadow': dark ? 'none' : '0 1px 3px rgba(20,30,40,.06)' }
      : { display: 'inline-block', font: '400 15px/1.45 ' + FONT });
    css(title, { display: withCard ? 'block' : 'none', margin: '0 0 6px', font: '700 18px/1.3 ' + FONT, color: theme.text });
    css(blurb, { display: withCard ? 'block' : 'none', margin: '0 0 16px', font: '400 14.5px/1.5 ' + FONT, color: theme.muted });
    css(button, {
      display: withCard ? 'block' : 'inline-block', width: withCard ? '100%' : 'auto', 'box-sizing': 'border-box',
      background: state.accent, color: state.onAccent, border: '0', 'border-radius': '999px', padding: '13px 22px',
      font: '600 16px/1.2 ' + FONT, cursor: 'pointer', margin: '0',
    });
    css(foot, withCard
      ? { display: 'inline-flex', 'align-items': 'center', gap: '6px', 'margin-top': '14px', font: '400 12px/1 ' + FONT, color: theme.muted, 'text-decoration': 'none' }
      : { display: 'none' });
    css(brandName, { 'font-weight': '600', color: theme.text });
    title.textContent = state.name ? 'Leave a message for ' + state.name : 'Leave us a message';
    blurb.textContent = state.blurb || defaultBlurb();
    button.textContent = state.label || 'Leave a voicemail';
  }
  paint();

  button.addEventListener('mouseenter', function () { button.style.setProperty('filter', 'brightness(0.92)'); });
  button.addEventListener('mouseleave', function () { button.style.removeProperty('filter'); });
  button.addEventListener('focus', function () {
    var visible = true;
    try { visible = button.matches(':focus-visible'); } catch (e) { /* older browsers: always show */ }
    if (visible) button.style.setProperty('box-shadow', '0 0 0 3px ' + theme.bg + ', 0 0 0 5px ' + state.accent);
  });
  button.addEventListener('blur', function () { button.style.removeProperty('box-shadow'); });
  foot.addEventListener('mouseenter', function () { foot.style.setProperty('text-decoration', 'underline'); });
  foot.addEventListener('mouseleave', function () { foot.style.setProperty('text-decoration', 'none'); });

  // ---- mount once the show's settings have arrived (or after a short wait, so the card does not jump around)
  var mounted = false;
  function mount() {
    if (mounted) return;
    mounted = true;
    var target = targetSelector ? document.querySelector(targetSelector) : null;
    if (target) target.appendChild(host);
    else if (script.parentNode) script.parentNode.insertBefore(host, script.nextSibling);
    else document.body.appendChild(host);
  }
  var pageReady = new Promise(function (resolve) {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', resolve);
    else resolve();
  });
  var settled = new Promise(function (resolve) { setTimeout(resolve, 900); });

  // Best effort: pick up the show's name, message, label and color. Without CORS access the defaults stay.
  var loaded = fetch(base + '/api/public/config?key=' + encodeURIComponent(key))
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (data) {
      if (!data || !data.show) return;
      var s = data.show;
      state.name = typeof s.name === 'string' ? s.name : '';
      if (!state.label && s.buttonLabel) state.label = s.buttonLabel;
      if (!state.blurb && s.blurb) state.blurb = s.blurb;
      if (!state.style) state.style = s.embedStyle === 'button' ? 'button' : 'card';
      var c = s.accentColor;
      if (/^#[0-9a-f]{6}$/i.test(c)) {
        var lum = (0.299 * parseInt(c.slice(1, 3), 16) + 0.587 * parseInt(c.slice(3, 5), 16) + 0.114 * parseInt(c.slice(5, 7), 16)) / 255;
        state.accent = c;
        state.onAccent = lum > 0.6 ? '#111111' : '#ffffff';
      }
      paint();
    })
    .catch(function () { /* keep defaults */ });
  Promise.all([pageReady, Promise.race([loaded, settled])]).then(mount);
  // A late answer still updates the card.
  loaded.then(function () { if (mounted) paint(); });

  // ---- the recorder dialog
  var overlay = null;
  var previousOverflow = '';

  function close() {
    if (!overlay) return;
    window.removeEventListener('message', onMessage);
    document.removeEventListener('keydown', onKey, true);
    overlay.remove();
    overlay = null;
    document.documentElement.style.setProperty('overflow', previousOverflow);
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
      host.dispatchEvent(new CustomEvent('listenerloop:submitted', { bubbles: true, composed: true }));
    }
  }

  function open() {
    if (overlay) return;
    overlay = document.createElement('div');
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-label', 'Leave a voicemail');
    css(overlay, { position: 'fixed', inset: '0', 'z-index': '2147483000', display: 'flex', 'align-items': 'center', 'justify-content': 'center', background: 'rgba(10,15,20,.6)', padding: '16px' });
    overlay.addEventListener('click', function (e) { if (e.target === overlay) close(); });

    var frame = document.createElement('iframe');
    frame.src = base + '/widget?key=' + encodeURIComponent(key);
    frame.title = 'Leave a voicemail';
    frame.setAttribute('allow', 'microphone');
    css(frame, { border: '0', 'border-radius': '16px', background: '#fff', width: '100%', 'max-width': '460px', height: 'min(680px,100%)', 'box-shadow': '0 20px 60px rgba(0,0,0,.35)' });
    overlay.appendChild(frame);

    previousOverflow = document.documentElement.style.overflow;
    document.documentElement.style.setProperty('overflow', 'hidden');
    document.body.appendChild(overlay);
    window.addEventListener('message', onMessage);
    document.addEventListener('keydown', onKey, true);
    frame.focus();
  }

  button.addEventListener('click', open);
})();
