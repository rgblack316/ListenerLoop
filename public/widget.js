/* ListenerLoop recorder widget. Runs inside the iframe opened by embed.js. */
(function () {
  'use strict';

  var key = new URLSearchParams(location.search).get('key') || '';
  var $ = function (id) { return document.getElementById(id); };

  var el = {
    showName: $('show-name'), loading: $('loading'), unsupported: $('unsupported'), content: $('content'),
    prompt: $('prompt'), meterBar: $('meter-bar'), timer: $('timer'), limit: $('limit'),
    btnRecord: $('btn-record'), btnStop: $('btn-stop'), btnRedo: $('btn-redo'), playback: $('playback'),
    form: $('form'), name: $('name'), email: $('email'), emailField: $('email-field'),
    consentRow: $('consent-row'), consent: $('consent'), consentText: $('consent-text'),
    send: $('btn-send'), error: $('error'), status: $('status'),
    done: $('done'), doneText: $('done-text'), close: $('close'), closeDone: $('btn-close-done'),
  };

  var cfg = null;
  var stream = null, recorder = null, chunks = [], blob = null, mime = '';
  var startedAt = 0, timerId = 0, audioCtx = null, analyser = null, raf = 0, objectUrl = '';
  var turnstileId = null, token = '', busy = false;

  function post(type) {
    try { parent.postMessage({ source: 'listenerloop', type: type }, '*'); } catch (e) { /* not embedded */ }
  }

  function fmt(seconds) {
    var s = Math.max(0, Math.floor(seconds));
    return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
  }

  function showError(message) { el.error.textContent = message; el.error.hidden = !message; }
  function showStatus(message) { el.status.textContent = message; el.status.hidden = !message; }

  function pickMime() {
    if (typeof MediaRecorder === 'undefined' || !MediaRecorder.isTypeSupported) return '';
    var candidates = ['audio/webm;codecs=opus', 'audio/mp4;codecs=mp4a.40.2', 'audio/mp4', 'audio/webm', 'audio/ogg;codecs=opus'];
    for (var i = 0; i < candidates.length; i++) {
      if (MediaRecorder.isTypeSupported(candidates[i])) return candidates[i];
    }
    return '';
  }

  function extFor(type) {
    if (type.indexOf('mp4') !== -1) return 'm4a';
    if (type.indexOf('ogg') !== -1) return 'ogg';
    return 'webm';
  }

  function updateSubmit() {
    var ok = !!blob && el.name.value.trim().length > 0 && !!token && !busy && (!cfg || !cfg.consentText.trim() || el.consent.checked);
    el.send.disabled = !ok;
  }

  // ---- recording ----
  function stopStream() {
    if (stream) stream.getTracks().forEach(function (t) { t.stop(); });
    stream = null;
  }

  function startMeter() {
    try {
      var Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      audioCtx = new Ctx();
      if (audioCtx.state === 'suspended') audioCtx.resume();
      var source = audioCtx.createMediaStreamSource(stream);
      analyser = audioCtx.createAnalyser();
      analyser.fftSize = 512;
      source.connect(analyser);
      var data = new Uint8Array(analyser.fftSize);
      var draw = function () {
        analyser.getByteTimeDomainData(data);
        var sum = 0;
        for (var i = 0; i < data.length; i++) { var v = (data[i] - 128) / 128; sum += v * v; }
        var level = Math.min(1, Math.sqrt(sum / data.length) * 3);
        el.meterBar.style.width = Math.round(level * 100) + '%';
        raf = requestAnimationFrame(draw);
      };
      draw();
    } catch (e) { /* the meter is optional */ }
  }

  function stopMeter() {
    cancelAnimationFrame(raf);
    el.meterBar.style.width = '0%';
    if (audioCtx) { audioCtx.close().catch(function () {}); audioCtx = null; }
    analyser = null;
  }

  function tick() {
    var elapsed = (Date.now() - startedAt) / 1000;
    el.timer.textContent = fmt(elapsed);
    if (elapsed >= cfg.maxSeconds) stopRecording();
  }

  async function startRecording() {
    showError('');
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    } catch (err) {
      showError(err && err.name === 'NotAllowedError'
        ? 'Microphone access was blocked. Allow the microphone for this site, then try again.'
        : 'No microphone could be used on this device.');
      return;
    }
    mime = pickMime();
    try {
      recorder = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
    } catch (err) {
      stopStream();
      showError('Recording is not supported in this browser.');
      return;
    }
    mime = recorder.mimeType || mime || 'audio/webm';
    chunks = [];
    blob = null;
    recorder.ondataavailable = function (e) { if (e.data && e.data.size) chunks.push(e.data); };
    recorder.onstop = onStopped;
    recorder.start(250);
    startedAt = Date.now();
    timerId = setInterval(tick, 200);
    startMeter();
    el.btnRecord.hidden = true;
    el.btnRedo.hidden = true;
    el.btnStop.hidden = false;
    el.playback.hidden = true;
    el.timer.textContent = '0:00';
    updateSubmit();
  }

  function stopRecording() {
    if (recorder && recorder.state !== 'inactive') recorder.stop();
  }

  function onStopped() {
    clearInterval(timerId);
    stopMeter();
    stopStream();
    var seconds = (Date.now() - startedAt) / 1000;
    el.btnStop.hidden = true;
    if (!chunks.length || seconds < 1) {
      showError('That recording was too short. Please try again.');
      resetRecorder();
      return;
    }
    blob = new Blob(chunks, { type: mime });
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    objectUrl = URL.createObjectURL(blob);
    el.playback.src = objectUrl;
    el.playback.hidden = false;
    el.btnRedo.hidden = false;
    el.timer.textContent = fmt(Math.min(seconds, cfg.maxSeconds));
    updateSubmit();
  }

  function resetRecorder() {
    blob = null;
    chunks = [];
    if (objectUrl) { URL.revokeObjectURL(objectUrl); objectUrl = ''; }
    el.playback.removeAttribute('src');
    el.playback.hidden = true;
    el.btnRecord.hidden = false;
    el.btnRedo.hidden = true;
    el.btnStop.hidden = true;
    el.timer.textContent = '0:00';
    updateSubmit();
  }

  // ---- Turnstile ----
  function loadTurnstile(siteKey) {
    return new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
      s.async = true;
      s.onload = function () {
        try {
          turnstileId = window.turnstile.render('#turnstile', {
            sitekey: siteKey,
            theme: 'auto',
            callback: function (t) { token = t; updateSubmit(); },
            'expired-callback': function () { token = ''; updateSubmit(); },
            'error-callback': function () { token = ''; showError('The verification check could not load. Please reload and try again.'); updateSubmit(); },
          });
          resolve();
        } catch (e) { reject(e); }
      };
      s.onerror = function () { reject(new Error('Turnstile failed to load')); };
      document.head.appendChild(s);
    });
  }

  function resetTurnstile() {
    token = '';
    try { if (window.turnstile && turnstileId !== null) window.turnstile.reset(turnstileId); } catch (e) { /* ignore */ }
    updateSubmit();
  }

  // ---- submit ----
  async function submit(event) {
    event.preventDefault();
    if (el.send.disabled || !blob) return;
    busy = true;
    showError('');
    showStatus('Sending your message…');
    updateSubmit();
    var fd = new FormData();
    fd.append('key', key);
    fd.append('name', el.name.value.trim());
    if (cfg.askEmail && el.email.value.trim()) fd.append('email', el.email.value.trim());
    fd.append('consent', el.consent.checked ? 'true' : 'false');
    fd.append('cf-turnstile-response', token);
    fd.append('audio', blob, 'recording.' + extFor(blob.type || mime));
    try {
      var res = await fetch('/api/public/messages', { method: 'POST', body: fd });
      var data = {};
      try { data = await res.json(); } catch (e) { /* not JSON */ }
      if (res.status === 202) {
        el.content.hidden = true;
        el.done.hidden = false;
        el.doneText.textContent = data.message || cfg.thanksText;
        post('vm:submitted');
      } else {
        showError(data.message || 'Something went wrong. Please try again.');
        resetTurnstile();
      }
    } catch (e) {
      showError('Network problem. Check your connection and try again.');
      resetTurnstile();
    } finally {
      busy = false;
      showStatus('');
      updateSubmit();
    }
  }

  // ---- startup ----
  function applyAccent(color) {
    if (!/^#[0-9a-f]{6}$/i.test(color)) return;
    var r = parseInt(color.slice(1, 3), 16), g = parseInt(color.slice(3, 5), 16), b = parseInt(color.slice(5, 7), 16);
    var luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
    document.documentElement.style.setProperty('--accent', color);
    document.documentElement.style.setProperty('--on-accent', luminance > 0.6 ? '#111111' : '#ffffff');
  }

  async function init() {
    var supported = !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && typeof MediaRecorder !== 'undefined');
    var res, data;
    try {
      res = await fetch('/api/public/config?key=' + encodeURIComponent(key));
      if (!res.ok) throw new Error('config');
      data = await res.json();
    } catch (e) {
      el.loading.textContent = 'This voicemail form is not available right now.';
      el.loading.className = 'note error';
      return;
    }
    cfg = data.show;
    el.showName.textContent = cfg.buttonLabel || 'Leave a voicemail';
    document.title = cfg.buttonLabel || 'Leave a voicemail';
    el.prompt.textContent = cfg.promptText;
    el.limit.textContent = fmt(cfg.maxSeconds);
    el.emailField.hidden = !cfg.askEmail;
    if (cfg.consentText.trim()) {
      el.consentText.textContent = cfg.consentText;
      el.consentRow.hidden = false;
    }
    applyAccent(cfg.accentColor);
    el.loading.hidden = true;

    if (!supported) {
      el.unsupported.hidden = false;
      return;
    }
    el.content.hidden = false;
    try {
      await loadTurnstile(data.turnstileSiteKey);
    } catch (e) {
      showError('The verification check could not load. Please reload and try again.');
    }
    post('vm:ready');
  }

  el.btnRecord.addEventListener('click', startRecording);
  el.btnStop.addEventListener('click', stopRecording);
  el.btnRedo.addEventListener('click', function () { resetRecorder(); resetTurnstile(); startRecording(); });
  el.form.addEventListener('submit', submit);
  el.name.addEventListener('input', updateSubmit);
  el.consent.addEventListener('change', updateSubmit);
  el.close.addEventListener('click', function () { post('vm:close'); });
  el.closeDone.addEventListener('click', function () { post('vm:close'); });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') post('vm:close'); });
  window.addEventListener('pagehide', function () { stopStream(); stopMeter(); });

  init();
})();
