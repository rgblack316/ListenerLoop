/* Small progressive enhancements for the admin. htmx handles the live updates. */
(function () {
  'use strict';
  // Only same-site paths (like /messages/1/audio) may be used as a media or download address.
  function sitePath(v) {
    return typeof v === 'string' && /^\/(?!\/)[\w\-./?=&%]*$/.test(v) ? v : '';
  }

  function localizeTimes(root) {
    (root || document).querySelectorAll('time[data-local]').forEach(function (t) {
      var d = new Date(t.getAttribute('datetime'));
      if (!isNaN(d)) t.textContent = d.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
    });
  }

  localizeTimes();
  document.body.addEventListener('htmx:afterSwap', function (e) { localizeTimes(e.target); });

  // Playback speed
  var speed = document.querySelector('[data-speed]');
  var player = document.querySelector('[data-player]');
  if (speed && player) {
    speed.addEventListener('change', function () { player.playbackRate = Number(speed.value); });
    player.addEventListener('play', function () { player.playbackRate = Number(speed.value); });
  }

  // Processed / original: switch the recording but keep the place, speed and play state, so the two can be compared.
  var version = document.querySelector('[data-version]');
  var dlLink = document.querySelector('[data-download-link]');
  if (version && player) {
    version.addEventListener('change', function () {
      var at = player.currentTime;
      var wasPlaying = !player.paused;
      var original = version.selectedIndex === 1;
      var target = sitePath(version.value);
      if (!target) return;
      player.src = target;
      player.load();
      player.addEventListener('loadedmetadata', function restore() {
        player.removeEventListener('loadedmetadata', restore);
        try { player.currentTime = at; } catch (e) { /* not seekable yet */ }
        if (speed) player.playbackRate = Number(speed.value);
        if (wasPlaying) { var p = player.play(); if (p && p.catch) p.catch(function () {}); }
      });
      if (dlLink) {
        dlLink.href = target + (original ? '&' : '?') + 'download=1';
        dlLink.textContent = original ? 'Download original' : 'Download MP3';
      }
    });
  }

  // Waveform: draw the stored peaks, show progress, and seek on click or drag.
  var wave = document.querySelector('[data-wave]');
  if (wave && player) {
    var peaks = wave.getAttribute('data-wave').split(',').map(Number);
    var NS = 'http://www.w3.org/2000/svg';
    var svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 ' + peaks.length + ' 100');
    svg.setAttribute('preserveAspectRatio', 'none');
    svg.setAttribute('aria-hidden', 'true');
    var bars = peaks.map(function (p, i) {
      var r = document.createElementNS(NS, 'rect');
      r.setAttribute('x', String(i + 0.15));
      r.setAttribute('width', '0.7');
      r.setAttribute('y', String(50 - p / 2));
      r.setAttribute('height', String(Math.max(p, 2)));
      svg.appendChild(r);
      return r;
    });
    wave.appendChild(svg);
    var length = function () {
      var d = player.duration;
      if (d && isFinite(d)) return d;
      var known = Number(player.getAttribute('data-duration'));
      return known > 0 ? known : 0;
    };
    var paint = function () {
      var d = length();
      var upto = d && isFinite(d) ? Math.round((player.currentTime / d) * bars.length) : 0;
      bars.forEach(function (r, i) { r.setAttribute('class', i < upto ? 'played' : ''); });
    };
    var seek = function (e) {
      var d = length();
      if (!d) return;
      var box = wave.getBoundingClientRect();
      player.currentTime = Math.min(1, Math.max(0, (e.clientX - box.left) / box.width)) * d;
      paint();
    };
    var dragging = false;
    wave.addEventListener('pointerdown', function (e) { dragging = true; seek(e); });
    window.addEventListener('pointermove', function (e) { if (dragging) seek(e); });
    window.addEventListener('pointerup', function () { dragging = false; });
    player.addEventListener('timeupdate', paint);
    player.addEventListener('seeked', paint);
    player.addEventListener('loadedmetadata', paint);
  }

  // Bulk download: select all, and keep the button honest about how many are ticked.
  var bulkButton = document.querySelector('[data-bulk-button]');
  var pickAll = document.querySelector('[data-pick-all]');
  var picks = function () { return Array.prototype.slice.call(document.querySelectorAll('.pick:not(:disabled)')); };
  var refreshBulk = function () {
    if (!bulkButton) return;
    var n = picks().filter(function (c) { return c.checked; }).length;
    bulkButton.disabled = n === 0;
    bulkButton.textContent = n > 0 ? 'Download ' + n + ' selected (.zip)' : 'Download selected (.zip)';
    if (pickAll) pickAll.checked = n > 0 && n === picks().length;
  };
  if (bulkButton) {
    document.addEventListener('change', function (e) {
      if (e.target === pickAll) picks().forEach(function (c) { c.checked = pickAll.checked; });
      if (e.target === pickAll || (e.target.classList && e.target.classList.contains('pick'))) refreshBulk();
    });
    document.body.addEventListener('htmx:afterSwap', refreshBulk);
    refreshBulk();
  }

  // Confirm before destructive plain-form actions
  document.addEventListener('submit', function (e) {
    var message = e.target && e.target.getAttribute && e.target.getAttribute('data-confirm');
    if (message && !window.confirm(message)) e.preventDefault();
  });

  // Auto-submit filters
  document.querySelectorAll('[data-autosubmit]').forEach(function (s) {
    s.addEventListener('change', function () { s.form.submit(); });
  });

  // Embed code helpers
  document.querySelectorAll('[data-select-on-focus]').forEach(function (t) {
    t.addEventListener('focus', function () { t.select(); });
  });
  document.querySelectorAll('[data-copy]').forEach(function (b) {
    b.addEventListener('click', function () {
      var text = b.getAttribute('data-copy');
      var done = function () {
        var old = b.textContent;
        b.textContent = 'Copied';
        setTimeout(function () { b.textContent = old; }, 1500);
      };
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done);
    });
  });

  // Live preview in the show editor: send the form's values to the preview frame as they change.
  var previewForm = document.querySelector('form[data-preview]');
  var previewFrame = document.getElementById('preview-frame');
  if (previewForm && previewFrame) {
    var sendPreview = function () {
      var f = previewForm.elements;
      var values = {
        buttonLabel: f.button_label.value, promptText: f.prompt_text.value, maxSeconds: f.max_seconds.value,
        askEmail: f.ask_email.checked, consentText: f.consent_text.value, thanksText: f.thanks_text.value, accentColor: f.accent_color.value,
      };
      if (previewFrame.contentWindow) previewFrame.contentWindow.postMessage({ source: 'listenerloop-admin', values: values }, location.origin);
    };
    previewForm.addEventListener('input', sendPreview);
    previewForm.addEventListener('change', sendPreview);
    window.addEventListener('message', function (e) {
      if (e.origin === location.origin && e.data && e.data.source === 'listenerloop-preview') sendPreview();
    });
    previewFrame.addEventListener('load', sendPreview);
  }
})();
