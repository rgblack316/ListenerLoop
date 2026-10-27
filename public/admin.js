/* Small progressive enhancements for the admin. htmx handles the live updates. */
(function () {
  'use strict';

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
