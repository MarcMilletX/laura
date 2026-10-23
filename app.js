/*
 * LAURA, de Marc Millet (https://marcmillet.com)
 * Licencia PolyForm Noncommercial 1.0.0
 * Required Notice: Copyright (c) 2026 Marc Millet (https://marcmillet.com)
 *
 * Mira una ventana compartida, detecta cuándo cambia el texto de la zona marcada,
 * lo reconoce (en el ordenador con Tesseract, o con Google Gemini si se elige ese modo)
 * y lo lee en voz alta con la voz de Cartesia. Todo funciona dentro de esta página.
 */
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);

  const CONFIG = Object.assign({
    cartesiaWs: 'wss://api.cartesia.ai/tts/websocket',
    cartesiaVersion: '2026-08-14',
    geminiBase: 'https://generativelanguage.googleapis.com/v1beta',
  }, window.LAURA_ENDPOINTS || {});

  const STORE_KEY = 'laura.ajustes.v1';
  const KEYS_STORE = 'laura.claves.v1';
  const SAMPLE_RATE = 44100;
  const TICK_MS = 400;
  const OCR_LANG = { es: 'spa', en: 'eng', fr: 'fra', it: 'ita', pt: 'por', de: 'deu' };
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const SETTING_IDS = [
    'speed', 'volume', 'testText', 'language', 'emotion', 'model',
    'readExisting', 'onlyNewLines', 'suffix', 'settleMs', 'sensitivity', 'minConfidence', 'minChars',
    'onlyLanguage', 'minWords', 'onlyOne',
    'instruction', 'geminiModel', 'geminiGap', 'interrupt',
  ];
  const LANGUAGE_NAMES = { es: 'español', en: 'inglés', fr: 'francés', it: 'italiano', pt: 'portugués', de: 'alemán' };
  const IS_MAC = /Mac|iPhone|iPad/i.test(navigator.platform || navigator.userAgent || '');

  const els = {
    preview: $('preview'),
    canvas: $('previewCanvas'),
    zoneBox: $('zoneBox'),
    zoneInfo: $('zoneInfo'),
    onair: $('onair'),
    statusText: $('statusText'),
    aiNote: $('aiNote'),
    message: $('message'),
    startBtn: $('startBtn'),
    stopBtn: $('stopBtn'),
    log: $('log'),
    logEmpty: $('logEmpty'),
    testVoice: $('testVoice'),
  };

  const storage = {
    get(key) {
      try { return JSON.parse(localStorage.getItem(key) || 'null'); } catch { return null; }
    },
    set(key, value) {
      try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* sin almacenamiento: no pasa nada */ }
    },
    remove(key) {
      try { localStorage.removeItem(key); } catch { /* nada */ }
    },
  };

  /* ================= Ajustes ================= */

  let zone = null; // { x, y, w, h } en proporciones de 0 a 1
  let zoneDecided = false; // se ha marcado zona (o elegido toda la ventana) para la ventana compartida

  function validZone(z) {
    return z && [z.x, z.y, z.w, z.h].every((n) => typeof n === 'number' && n >= 0 && n <= 1) && z.w > 0 && z.h > 0;
  }

  function loadSettings() {
    const saved = storage.get(STORE_KEY);
    if (!saved || typeof saved !== 'object') return;
    for (const id of SETTING_IDS) {
      if (!(id in saved)) continue;
      const el = $(id);
      if (!el) continue;
      if (el.type === 'checkbox') el.checked = Boolean(saved[id]);
      else el.value = saved[id];
    }
    if (saved.mode) {
      const radio = document.querySelector(`input[name="mode"][value="${saved.mode === 'ia' ? 'ia' : 'zona'}"]`);
      if (radio) radio.checked = true;
    }
    if (validZone(saved.zone)) zone = saved.zone;
  }

  let saveTimer = null;
  function saveSettings() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      const data = { mode: currentMode(), zone };
      for (const id of SETTING_IDS) {
        const el = $(id);
        data[id] = el.type === 'checkbox' ? el.checked : el.value;
      }
      storage.set(STORE_KEY, data);
    }, 250);
  }

  function currentMode() {
    const checked = document.querySelector('input[name="mode"]:checked');
    return checked ? checked.value : 'zona';
  }

  function readSettings() {
    const num = (id, fallback) => {
      const n = Number($(id).value);
      return Number.isFinite(n) ? n : fallback;
    };
    return {
      speed: num('speed', 1),
      volume: num('volume', 1),
      language: $('language').value || 'es',
      emotion: $('emotion').value,
      model: $('model').value.trim() || 'sonic-3.6',
      mode: currentMode(),
      readExisting: $('readExisting').checked,
      onlyNewLines: $('onlyNewLines').checked,
      suffix: $('suffix').value.trim(),
      settleMs: num('settleMs', 700),
      sensitivity: num('sensitivity', 6),
      minConfidence: num('minConfidence', 55),
      minChars: Math.max(1, num('minChars', 3)),
      onlyLanguage: $('onlyLanguage').checked,
      minWords: Math.max(1, num('minWords', 3)),
      onlyOne: $('onlyOne').checked,
      instruction: $('instruction').value.trim(),
      geminiModel: $('geminiModel').value.trim().replace(/^models\//, '') || 'gemini-3.5-flash-lite',
      geminiGap: num('geminiGap', 4),
      interrupt: $('interrupt').checked,
    };
  }

  /* ================= Interfaz ================= */

  const fmt = (n, digits) => n.toLocaleString('es-ES', { minimumFractionDigits: digits, maximumFractionDigits: digits });

  function updateOutputs() {
    $('speedOut').textContent = `${fmt(Number($('speed').value), 2)}×`;
    $('volumeOut').textContent = `${fmt(Number($('volume').value), 1)}×`;
    $('settleOut').textContent = `${fmt(Number($('settleMs').value) / 1000, 1)} s`;
    $('sensitivityOut').textContent = $('sensitivity').value;
    $('minConfidenceOut').textContent = $('minConfidence').value;
    $('geminiGapOut').textContent = `${$('geminiGap').value} s`;
  }

  function updateLanguageLabel() {
    const name = LANGUAGE_NAMES[$('language').value] || 'español';
    $('onlyLanguageLabel').textContent = `Leer solo frases en ${name}`;
  }

  function updateModeOptions() {
    const mode = currentMode();
    $('opts-zona').hidden = mode !== 'zona';
    $('opts-ia').hidden = mode !== 'ia';
  }

  function showMessage(text, kind = 'error') {
    els.message.textContent = text;
    els.message.dataset.kind = kind;
    els.message.hidden = false;
  }

  function hideMessage() {
    els.message.hidden = true;
    els.message.textContent = '';
  }

  function timeNow() {
    return new Date().toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }

  function addLog(text, kind = 'read', note = '') {
    const li = document.createElement('li');
    li.dataset.kind = kind;
    const time = document.createElement('time');
    time.textContent = timeNow();
    const body = document.createElement('span');
    body.className = 'log-text';
    body.textContent = text;
    if (note) {
      const small = document.createElement('span');
      small.className = 'log-note';
      small.textContent = note;
      body.appendChild(small);
    }
    li.append(time, body);
    if (kind === 'read') {
      const again = document.createElement('button');
      again.type = 'button';
      again.className = 'ghost small';
      again.textContent = 'Repetir';
      again.addEventListener('click', () => {
        voice.ensureAudio();
        speakText(text, readSettings(), {}, false);
      });
      li.appendChild(again);
    } else {
      li.appendChild(document.createElement('span'));
    }
    els.log.prepend(li);
    while (els.log.children.length > 200) els.log.lastElementChild.remove();
    els.logEmpty.hidden = els.log.children.length > 0;
  }

  const ui = { running: false, preparing: '' };

  function refreshStatus() {
    const speaking = voice.isSpeaking();
    document.body.dataset.speaking = String(speaking);
    let state = 'idle';
    let text = 'Parada';
    if (speaking) {
      state = 'speaking';
      text = 'Hablando';
    } else if (ui.preparing) {
      state = 'thinking';
      text = ui.preparing;
    } else if (run.processing) {
      state = 'thinking';
      text = run.mode === 'ia' ? 'Consultando a la IA…' : 'Leyendo la pantalla…';
    } else if (ui.running) {
      state = 'watching';
      text = run.mode === 'ia' ? 'Atenta a tu instrucción' : 'Vigilando la zona';
    }
    els.onair.dataset.state = state;
    if (els.statusText.textContent !== text) els.statusText.textContent = text;
  }

  function setPreparing(text) {
    ui.preparing = text || '';
    refreshStatus();
  }

  /* ================= Claves (archivo claves.env o .env) ================= */

  const creds = { voiceId: '', cartesiaKey: '', geminiKey: '', fileName: '' };

  /** Lee un archivo con líneas NOMBRE=valor. Admite comillas y comentarios con #. */
  function parseKeysFile(text) {
    const values = {};
    for (const raw of String(text).replace(/^﻿/, '').split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const m = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
      if (!m) continue;
      let value = m[2].trim();
      const quote = value[0];
      const closing = quote === '"' || quote === "'" ? value.indexOf(quote, 1) : -1;
      if (closing > 0) {
        value = value.slice(1, closing);
      } else {
        const hash = value.search(/(^|\s)#/);
        if (hash >= 0) value = value.slice(0, hash).trim();
      }
      values[m[1].toUpperCase()] = value.trim();
    }
    return {
      voiceId: values.CARTESIA_VOICE_ID || '',
      cartesiaKey: values.CARTESIA_API_KEY || '',
      geminiKey: values.GEMINI_API_KEY || '',
    };
  }

  function setCred(id, state, text, small) {
    const li = $(id);
    li.dataset.state = state;
    const span = li.querySelector('.cred-text');
    span.textContent = text;
    if (small) {
      const s = document.createElement('small');
      s.textContent = small;
      span.appendChild(s);
    }
  }

  function renderCreds() {
    if (!creds.voiceId) {
      setCred('credVoice', 'missing', 'Falta el código de la voz', 'Escríbelo en CARTESIA_VOICE_ID dentro de tu archivo de claves.');
    } else if (!UUID_RE.test(creds.voiceId)) {
      setCred('credVoice', 'missing', 'El código de la voz no tiene buena pinta', 'Cópialo otra vez en Cartesia con «Copy ID».');
    } else {
      setCred('credVoice', 'ok', `Voz de Cartesia lista (código terminado en ${creds.voiceId.slice(-5)})`);
    }
    if (creds.cartesiaKey) setCred('credKey', 'ok', 'Clave de Cartesia puesta');
    else setCred('credKey', 'missing', 'Falta la clave de Cartesia', 'Escríbela en CARTESIA_API_KEY dentro de tu archivo de claves.');
    if (creds.geminiKey) setCred('credGoogle', 'ok', 'Clave de Google puesta');
    else setCred('credGoogle', 'optional', 'Clave de Google sin poner', 'Solo hace falta para el modo «Lo que yo le diga».');

    $('keysInfo').textContent = creds.fileName
      ? `Claves cargadas de «${creds.fileName}». Si cambias el archivo, vuelve a cargarlo.`
      : 'Elige tu archivo de claves (claves.env o .env) o arrástralo a este recuadro.';
  }

  function storeKeys() {
    if ($('rememberKeys').checked) storage.set(KEYS_STORE, { ...creds });
    else storage.remove(KEYS_STORE);
  }

  function restoreKeys() {
    const saved = storage.get(KEYS_STORE);
    if (saved && typeof saved === 'object') {
      creds.voiceId = String(saved.voiceId || '');
      creds.cartesiaKey = String(saved.cartesiaKey || '');
      creds.geminiKey = String(saved.geminiKey || '');
      creds.fileName = String(saved.fileName || '');
    }
  }

  async function loadKeysFile(file) {
    if (!file) return;
    if (file.size > 100000) {
      showMessage('Ese archivo es demasiado grande para ser un archivo de claves. Elige claves.env o tu .env.');
      return;
    }
    const values = parseKeysFile(await file.text());
    if (!values.voiceId && !values.cartesiaKey && !values.geminiKey) {
      showMessage(`«${file.name}» no tiene ninguna clave rellenada. Abre claves.env con un editor de texto, rellénalo, guárdalo y vuelve a cargarlo.`);
      return;
    }
    Object.assign(creds, values, { fileName: file.name });
    storeKeys();
    voice.disconnect();
    renderCreds();
    showMessage(`Claves cargadas de «${file.name}».`, 'info');
  }

  function forgetKeys() {
    Object.assign(creds, { voiceId: '', cartesiaKey: '', geminiKey: '', fileName: '' });
    storage.remove(KEYS_STORE);
    voice.disconnect();
    renderCreds();
    showMessage('He olvidado las claves en este navegador.', 'info');
  }

  /* ================= Voz (Cartesia por WebSocket) ================= */

  function base64ToBytes(b64) {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
    return bytes;
  }

  function cartesiaErrorMessage(msg) {
    const status = Number(msg.status_code) || 0;
    const detail = `${msg.title || ''} ${msg.message || ''}`.trim();
    const d = detail.toLowerCase();
    if (status === 401 || status === 403 || d.includes('api key') || d.includes('unauthorized')) return 'Cartesia no acepta la clave. Revisa CARTESIA_API_KEY en tu archivo de claves.';
    if (status === 402 || d.includes('credit')) return 'Tu cuenta de Cartesia no tiene créditos suficientes.';
    if (d.includes('voice')) return 'Cartesia no encuentra esa voz. Revisa CARTESIA_VOICE_ID en tu archivo de claves.';
    if (d.includes('model')) return 'Cartesia no reconoce el modelo elegido. Prueba con sonic-3.6 en «Más ajustes de voz».';
    if (status === 429) return 'Cartesia está recibiendo demasiadas peticiones. Espera unos segundos.';
    return `Cartesia no ha podido generar el audio${detail ? `: ${detail}` : '.'}`;
  }

  class Voice {
    constructor(onChange) {
      this.ctx = null;
      this.queue = [];
      this.current = null;
      this.pumping = false;
      this.nextTime = 0;
      this.sources = new Set();
      this.onChange = onChange;
      this.ws = null;
      this.connecting = null;
      this.handlers = new Map();
    }

    ensureAudio() {
      if (!this.ctx) {
        const AudioCtx = window.AudioContext || window.webkitAudioContext;
        this.ctx = new AudioCtx();
      }
      if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
      return this.ctx;
    }

    isSpeaking() {
      return this.sources.size > 0 || Boolean(this.current) || this.queue.length > 0;
    }

    connect() {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) return Promise.resolve(this.ws);
      if (this.connecting) return this.connecting;
      const url = new URL(CONFIG.cartesiaWs);
      url.searchParams.set('api_key', creds.cartesiaKey);
      url.searchParams.set('cartesia_version', CONFIG.cartesiaVersion);
      this.connecting = new Promise((resolve, reject) => {
        let opened = false;
        let ws;
        try {
          ws = new WebSocket(url.toString());
        } catch (err) {
          this.connecting = null;
          reject(new Error('No se ha podido conectar con Cartesia.'));
          return;
        }
        ws.onopen = () => {
          opened = true;
          this.ws = ws;
          this.connecting = null;
          resolve(ws);
        };
        ws.onmessage = (event) => this.onMessage(event);
        ws.onclose = () => {
          if (this.ws === ws) this.ws = null;
          this.connecting = null;
          if (!opened) {
            reject(new Error('Cartesia ha rechazado la conexión. Revisa la clave (CARTESIA_API_KEY) y tu conexión a internet.'));
            return;
          }
          for (const handler of [...this.handlers.values()]) handler.fail(new Error('Se ha cortado la conexión con Cartesia. Vuelve a intentarlo.'));
        };
      });
      return this.connecting;
    }

    disconnect() {
      if (this.ws) {
        try { this.ws.close(); } catch { /* ya cerrado */ }
      }
      this.ws = null;
      this.connecting = null;
    }

    onMessage(event) {
      let msg;
      try { msg = JSON.parse(event.data); } catch { return; }
      const handler = this.handlers.get(msg.context_id);
      if (handler) {
        handler.onMessage(msg);
      } else if (msg.type === 'error' && !msg.context_id) {
        for (const h of [...this.handlers.values()]) h.fail(new Error(cartesiaErrorMessage(msg)));
      }
    }

    speak(text, options) {
      return new Promise((resolve, reject) => {
        this.queue.push({ text, options, resolve, reject });
        this.onChange();
        this.pump();
      });
    }

    async pump() {
      if (this.pumping) return;
      this.pumping = true;
      while (this.queue.length) {
        const item = this.queue.shift();
        const controller = new AbortController();
        this.current = { controller };
        this.onChange();
        try {
          await this.generate(item, controller);
          item.resolve();
        } catch (err) {
          if (controller.signal.aborted) item.resolve();
          else item.reject(err);
        } finally {
          this.current = null;
          this.onChange();
        }
      }
      this.pumping = false;
    }

    async generate(item, controller) {
      if (!creds.voiceId || !creds.cartesiaKey) {
        throw new Error('Faltan las claves de Cartesia. Pulsa «Cargar claves» y elige tu archivo de claves.');
      }
      const ws = await this.connect();
      if (controller.signal.aborted) return;
      const o = item.options || {};
      const contextId = `laura-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      const generationConfig = {
        speed: Math.min(1.5, Math.max(0.6, Number(o.speed) || 1)),
        volume: Math.min(2, Math.max(0.5, Number(o.volume) || 1)),
      };
      if (o.emotion) generationConfig.emotion = o.emotion;

      await new Promise((resolve, reject) => {
        const minSamples = Math.round(SAMPLE_RATE * 0.12);
        let carry = new Uint8Array(0);
        let pending = [];
        let pendingSamples = 0;
        let finished = false;
        let timer = null;

        const flush = () => {
          if (!pendingSamples) return;
          const all = new Float32Array(pendingSamples);
          let offset = 0;
          for (const part of pending) {
            all.set(part, offset);
            offset += part.length;
          }
          pending = [];
          pendingSamples = 0;
          this.schedule(all, SAMPLE_RATE);
        };

        const addBytes = (value) => {
          let bytes = value;
          if (carry.length) {
            bytes = new Uint8Array(carry.length + value.length);
            bytes.set(carry);
            bytes.set(value, carry.length);
          }
          const usable = bytes.length - (bytes.length % 4);
          if (usable > 0) {
            const floats = new Float32Array(usable / 4);
            new Uint8Array(floats.buffer).set(bytes.subarray(0, usable));
            pending.push(floats);
            pendingSamples += floats.length;
            if (pendingSamples >= minSamples) flush();
          }
          carry = bytes.slice(usable);
        };

        const finish = (err) => {
          if (finished) return;
          finished = true;
          clearTimeout(timer);
          this.handlers.delete(contextId);
          if (err) {
            reject(err);
            return;
          }
          if (!controller.signal.aborted) flush();
          resolve();
        };

        const arm = () => {
          clearTimeout(timer);
          timer = setTimeout(() => finish(new Error('Cartesia no responde. Vuelve a intentarlo.')), 20000);
        };

        this.handlers.set(contextId, {
          onMessage: (msg) => {
            if (finished || controller.signal.aborted) return;
            if (msg.type === 'chunk') {
              if (msg.data) addBytes(base64ToBytes(msg.data));
              arm();
              if (msg.done) finish();
            } else if (msg.type === 'done') {
              finish();
            } else if (msg.type === 'error') {
              finish(new Error(cartesiaErrorMessage(msg)));
            }
          },
          fail: (err) => finish(err),
        });

        controller.signal.addEventListener('abort', () => {
          try { ws.send(JSON.stringify({ context_id: contextId, cancel: true })); } catch { /* conexión cerrada */ }
          finish();
        });

        try {
          ws.send(JSON.stringify({
            model_id: o.model || 'sonic-3.6',
            transcript: String(item.text).slice(0, 2000),
            voice: creds.voiceId,
            output_format: { container: 'raw', encoding: 'pcm_f32le', sample_rate: SAMPLE_RATE },
            language: o.language || 'es',
            context_id: contextId,
            generation_config: generationConfig,
          }));
        } catch {
          finish(new Error('No se ha podido enviar el texto a Cartesia. Vuelve a intentarlo.'));
          return;
        }
        arm();
      });
    }

    schedule(floats, rate) {
      const ctx = this.ensureAudio();
      const buffer = ctx.createBuffer(1, floats.length, rate);
      buffer.copyToChannel(floats, 0);
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(ctx.destination);
      const startAt = Math.max(this.nextTime, ctx.currentTime + 0.05);
      source.start(startAt);
      this.nextTime = startAt + buffer.duration;
      this.sources.add(source);
      source.onended = () => {
        this.sources.delete(source);
        this.onChange();
      };
      this.onChange();
    }

    stopAll() {
      for (const item of this.queue) item.resolve();
      this.queue = [];
      if (this.current) this.current.controller.abort();
      for (const source of this.sources) {
        try { source.stop(); } catch { /* ya parado */ }
      }
      this.sources.clear();
      this.nextTime = 0;
      this.onChange();
    }
  }

  const voice = new Voice(() => refreshStatus());

  function voiceOptions(s, overrides = {}) {
    return {
      speed: overrides.speed ?? s.speed,
      volume: overrides.volume ?? s.volume,
      emotion: s.emotion,
      language: s.language,
      model: s.model,
    };
  }

  function speakText(text, s, overrides = {}, log = true, note = '') {
    if (log) addLog(text, 'read', note);
    run.recent.push(text);
    if (run.recent.length > 5) run.recent.shift();
    return voice.speak(text, voiceOptions(s, overrides)).catch((err) => {
      showMessage(err.message);
      addLog(err.message, 'error');
    });
  }

  /* ================= Captura de la ventana ================= */

  let stream = null;
  let track = null;
  let video = null;
  let imageCapture = null;

  async function pickWindow() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
      showMessage('Este navegador no permite compartir ventanas. Usa Chrome o Edge actualizados.');
      return false;
    }
    let newStream;
    try {
      newStream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: { ideal: 5, max: 10 } },
        audio: false,
        selfBrowserSurface: 'exclude',
        surfaceSwitching: 'include',
      });
    } catch (err) {
      if (err && err.name === 'NotAllowedError') showMessage('No se ha compartido ninguna ventana.', 'info');
      else showMessage(`No se ha podido compartir la ventana: ${err && err.message ? err.message : err}`);
      return false;
    }
    releaseCapture();
    stream = newStream;
    track = stream.getVideoTracks()[0];
    track.addEventListener('ended', onCaptureEnded);
    if (!video) {
      video = document.createElement('video');
      video.muted = true;
      video.playsInline = true;
    }
    video.srcObject = stream;
    try { await video.play(); } catch { /* algunos navegadores no lo necesitan */ }
    imageCapture = 'ImageCapture' in window ? new window.ImageCapture(track) : null;
    els.preview.classList.add('has-stream');
    $('markZone').disabled = false;
    hideMessage();
    zoneDecided = false;
    resetDetection();
    startTicker();
    const choice = await openPicker();
    return choice !== 'cancel' || zoneDecided;
  }

  function onCaptureEnded() {
    addLog('Se ha dejado de compartir la ventana.', 'info');
    if (ui.running) stop(false);
    releaseCapture();
  }

  function releaseCapture() {
    stopTicker();
    if (stream) stream.getTracks().forEach((t) => t.stop());
    stream = null;
    track = null;
    imageCapture = null;
    if (video) video.srcObject = null;
    els.preview.classList.remove('has-stream');
    $('markZone').disabled = true;
    zoneDecided = false;
    if (picker.open) closePicker('cancel');
  }

  function withTimeout(promise, ms) {
    return Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms))]);
  }

  async function grabFrame() {
    if (!track || track.readyState !== 'live') return null;
    const videoReady = video && video.videoWidth > 0 && video.readyState >= 2;
    // Con la página a la vista, el vídeo siempre tiene el último fotograma.
    // Si está en segundo plano, se pide el fotograma directamente a la pista.
    if (videoReady && !document.hidden) return { src: video, w: video.videoWidth, h: video.videoHeight, close() {} };
    if (imageCapture) {
      try {
        const bitmap = await withTimeout(imageCapture.grabFrame(), 1200);
        return { src: bitmap, w: bitmap.width, h: bitmap.height, close: () => bitmap.close() };
      } catch { /* se usa el vídeo */ }
    }
    if (videoReady) return { src: video, w: video.videoWidth, h: video.videoHeight, close() {} };
    return null;
  }

  /* Reloj en un Worker: el navegador no lo frena tanto cuando esta pestaña está en segundo plano. */
  let ticker = null;
  let fallbackTimer = null;

  function startTicker() {
    stopTicker();
    try {
      if (!ticker) {
        const src = 'let t=null;onmessage=(e)=>{clearInterval(t);t=null;if(e.data>0)t=setInterval(()=>postMessage(0),e.data);};';
        ticker = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
        ticker.onmessage = onTick;
      }
      ticker.postMessage(TICK_MS);
    } catch {
      ticker = null;
      fallbackTimer = setInterval(onTick, TICK_MS);
    }
  }

  function stopTicker() {
    if (ticker) ticker.postMessage(0);
    clearInterval(fallbackTimer);
    fallbackTimer = null;
  }

  /* ================= Vista previa y zona ================= */

  const previewCtx = els.canvas.getContext('2d');

  function drawPreview(frame) {
    const scale = Math.min(1, 1100 / frame.w);
    const w = Math.max(1, Math.round(frame.w * scale));
    const h = Math.max(1, Math.round(frame.h * scale));
    if (els.canvas.width !== w || els.canvas.height !== h) {
      els.canvas.width = w;
      els.canvas.height = h;
    }
    previewCtx.drawImage(frame.src, 0, 0, w, h);
  }

  function renderZone(z = zone) {
    if (!validZone(z)) {
      els.zoneBox.hidden = true;
    } else {
      els.zoneBox.hidden = false;
      els.zoneBox.style.left = `${z.x * 100}%`;
      els.zoneBox.style.top = `${z.y * 100}%`;
      els.zoneBox.style.width = `${z.w * 100}%`;
      els.zoneBox.style.height = `${z.h * 100}%`;
    }
    els.zoneInfo.textContent = validZone(zone)
      ? 'Zona marcada: solo se vigila el recuadro rojo. Arrastra otra vez para cambiarla.'
      : 'Sin zona marcada: se vigila toda la ventana.';
  }

  let dragStart = null;

  function pointToRatio(event) {
    const r = els.canvas.getBoundingClientRect();
    return {
      x: Math.min(1, Math.max(0, (event.clientX - r.left) / r.width)),
      y: Math.min(1, Math.max(0, (event.clientY - r.top) / r.height)),
      pxW: r.width,
      pxH: r.height,
    };
  }

  function rectFrom(a, b) {
    return {
      x: Math.min(a.x, b.x),
      y: Math.min(a.y, b.y),
      w: Math.abs(a.x - b.x),
      h: Math.abs(a.y - b.y),
    };
  }

  els.preview.addEventListener('pointerdown', (event) => {
    if (!stream || event.button !== 0) return;
    dragStart = pointToRatio(event);
    els.preview.setPointerCapture(event.pointerId);
    renderZone(rectFrom(dragStart, dragStart));
  });

  els.preview.addEventListener('pointermove', (event) => {
    if (!dragStart) return;
    renderZone(rectFrom(dragStart, pointToRatio(event)));
  });

  function endDrag(event) {
    if (!dragStart) return;
    const end = pointToRatio(event);
    const rect = rectFrom(dragStart, end);
    const tooSmall = rect.w * end.pxW < 12 || rect.h * end.pxH < 12;
    dragStart = null;
    if (!tooSmall) {
      zone = rect;
      zoneDecided = true;
      saveSettings();
      resetDetection();
    }
    renderZone();
  }

  els.preview.addEventListener('pointerup', endDrag);
  els.preview.addEventListener('pointercancel', () => {
    dragStart = null;
    renderZone();
  });

  /* ================= Selector de zona a pantalla completa (como Cmd + Mayúsculas + 4) ================= */

  const picker = { open: false, resolve: null, rect: null, drag: null, aspect: 16 / 9, fullscreen: false };
  const pickerEls = {
    root: $('picker'),
    stage: $('pickerStage'),
    frame: $('pickerFrame'),
    canvas: $('pickerCanvas'),
    rect: $('pickerRect'),
    ok: $('pickerOk'),
  };
  const pickerCtx = pickerEls.canvas.getContext('2d');

  function fitPicker() {
    const box = pickerEls.stage.getBoundingClientRect();
    const maxW = Math.max(100, box.width - 32);
    const maxH = Math.max(100, box.height - 32);
    let w = maxW;
    let h = w / picker.aspect;
    if (h > maxH) {
      h = maxH;
      w = h * picker.aspect;
    }
    pickerEls.frame.style.width = `${Math.round(w)}px`;
    pickerEls.frame.style.height = `${Math.round(h)}px`;
  }

  function drawPicker(frame) {
    const aspect = frame.w / frame.h;
    if (Math.abs(aspect - picker.aspect) > 0.001) {
      picker.aspect = aspect;
      fitPicker();
    }
    const scale = Math.min(1, 1920 / frame.w);
    const w = Math.max(1, Math.round(frame.w * scale));
    const h = Math.max(1, Math.round(frame.h * scale));
    if (pickerEls.canvas.width !== w || pickerEls.canvas.height !== h) {
      pickerEls.canvas.width = w;
      pickerEls.canvas.height = h;
    }
    pickerCtx.drawImage(frame.src, 0, 0, w, h);
  }

  function renderPickerRect(r = picker.rect) {
    if (!validZone(r)) {
      pickerEls.rect.hidden = true;
    } else {
      pickerEls.rect.hidden = false;
      pickerEls.rect.style.left = `${r.x * 100}%`;
      pickerEls.rect.style.top = `${r.y * 100}%`;
      pickerEls.rect.style.width = `${r.w * 100}%`;
      pickerEls.rect.style.height = `${r.h * 100}%`;
    }
    pickerEls.ok.disabled = !validZone(picker.rect);
  }

  function pickerPoint(event) {
    const r = pickerEls.frame.getBoundingClientRect();
    return {
      x: Math.min(1, Math.max(0, (event.clientX - r.left) / r.width)),
      y: Math.min(1, Math.max(0, (event.clientY - r.top) / r.height)),
      pxW: r.width,
      pxH: r.height,
    };
  }

  function openPicker() {
    if (picker.open) return Promise.resolve('cancel');
    return new Promise((resolve) => {
      picker.open = true;
      picker.resolve = resolve;
      picker.rect = validZone(zone) ? { ...zone } : null;
      if (video && video.videoWidth) picker.aspect = video.videoWidth / video.videoHeight;
      pickerEls.root.hidden = false;
      document.body.style.overflow = 'hidden';
      fitPicker();
      renderPickerRect();
      picker.fullscreen = false;
      if (pickerEls.root.requestFullscreen) {
        pickerEls.root.requestFullscreen().then(() => {
          picker.fullscreen = true;
          fitPicker();
        }).catch(() => {});
      }
      pickerEls.ok.focus({ preventScroll: true });
    });
  }

  function closePicker(choice) {
    if (!picker.open) return;
    picker.open = false;
    picker.drag = null;
    pickerEls.root.hidden = true;
    document.body.style.overflow = '';
    if (document.fullscreenElement === pickerEls.root && document.exitFullscreen) document.exitFullscreen().catch(() => {});
    if (choice === 'ok' && validZone(picker.rect)) {
      zone = { ...picker.rect };
      zoneDecided = true;
    } else if (choice === 'all') {
      zone = null;
      zoneDecided = true;
    }
    if (choice !== 'cancel') {
      saveSettings();
      renderZone();
      resetDetection();
    }
    const resolve = picker.resolve;
    picker.resolve = null;
    if (resolve) resolve(choice);
  }

  pickerEls.frame.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    picker.drag = pickerPoint(event);
    pickerEls.frame.setPointerCapture(event.pointerId);
    renderPickerRect(rectFrom(picker.drag, picker.drag));
  });

  pickerEls.frame.addEventListener('pointermove', (event) => {
    if (!picker.drag) return;
    renderPickerRect(rectFrom(picker.drag, pickerPoint(event)));
  });

  pickerEls.frame.addEventListener('pointerup', (event) => {
    if (!picker.drag) return;
    const end = pickerPoint(event);
    const rect = rectFrom(picker.drag, end);
    picker.drag = null;
    if (rect.w * end.pxW >= 12 && rect.h * end.pxH >= 12) picker.rect = rect;
    renderPickerRect();
  });

  $('pickerOk').addEventListener('click', () => closePicker('ok'));
  $('pickerAll').addEventListener('click', () => closePicker('all'));
  $('pickerCancel').addEventListener('click', () => closePicker('cancel'));
  window.addEventListener('resize', () => { if (picker.open) fitPicker(); });
  document.addEventListener('fullscreenchange', () => { if (picker.open) fitPicker(); });

  /* ================= Detección de cambios ================= */

  const run = {
    active: false,
    mode: 'zona',
    startedAt: 0,
    prevSample: null,
    dirty: false,
    lastChangeAt: 0,
    processing: false,
    firstPass: false,
    silentBaseline: false,
    prevLines: [],
    lastSpokenKey: '',
    recent: [],
    nextGeminiAt: 0,
  };

  function resetDetection() {
    if (!run.active) return;
    run.prevSample = null;
    run.dirty = false;
    run.firstPass = true;
    run.prevLines = [];
    // Al cambiar de zona, lo que ya hay en la zona nueva no se lee (salvo que se pida).
    run.silentBaseline = run.mode === 'zona' && !$('readExisting').checked;
  }

  function zonePixels(frame) {
    if (!validZone(zone)) return { x: 0, y: 0, w: frame.w, h: frame.h };
    const x = Math.round(zone.x * frame.w);
    const y = Math.round(zone.y * frame.h);
    return {
      x,
      y,
      w: Math.max(1, Math.min(frame.w - x, Math.round(zone.w * frame.w))),
      h: Math.max(1, Math.min(frame.h - y, Math.round(zone.h * frame.h))),
    };
  }

  const sampleCanvas = document.createElement('canvas');
  const sampleCtx = sampleCanvas.getContext('2d', { willReadFrequently: true });

  function takeSample(frame, z) {
    let sw = Math.min(320, z.w);
    let sh = Math.round((sw * z.h) / z.w);
    if (sh > 320) {
      sh = 320;
      sw = Math.round((sh * z.w) / z.h);
    }
    sw = Math.max(8, sw);
    sh = Math.max(8, sh);
    if (sampleCanvas.width !== sw || sampleCanvas.height !== sh) {
      sampleCanvas.width = sw;
      sampleCanvas.height = sh;
    }
    sampleCtx.drawImage(frame.src, z.x, z.y, z.w, z.h, 0, 0, sw, sh);
    const data = sampleCtx.getImageData(0, 0, sw, sh).data;
    const gray = new Uint8Array(sw * sh);
    for (let i = 0, p = 0; i < gray.length; i += 1, p += 4) {
      gray[i] = (data[p] * 77 + data[p + 1] * 150 + data[p + 2] * 29) >> 8;
    }
    return { gray, sw, sh };
  }

  function changeAmount(a, b) {
    if (!a || a.sw !== b.sw || a.sh !== b.sh) return { ratio: 1, count: Infinity };
    let count = 0;
    for (let i = 0; i < a.gray.length; i += 1) {
      if (Math.abs(a.gray[i] - b.gray[i]) > 28) count += 1;
    }
    return { ratio: count / a.gray.length, count };
  }

  function thresholdFor(sensitivity) {
    return 0.02 * Math.pow(0.6, Math.min(10, Math.max(1, sensitivity)) - 1);
  }

  let tickBusy = false;

  async function onTick() {
    if (tickBusy) return;
    tickBusy = true;
    let frame = null;
    try {
      frame = await grabFrame();
      if (!frame) return;
      if (!document.hidden) drawPreview(frame);
      if (picker.open) drawPicker(frame);
      if (run.active) detect(frame);
    } catch (err) {
      console.warn('LAURA:', err);
    } finally {
      if (frame) frame.close();
      tickBusy = false;
    }
  }

  function detect(frame) {
    const s = readSettings();
    const z = zonePixels(frame);
    const sample = takeSample(frame, z);
    const now = performance.now();

    if (!run.prevSample) {
      run.prevSample = sample;
      if (run.firstPass) {
        run.firstPass = false;
        run.dirty = true;
        run.lastChangeAt = -Infinity;
      }
    } else {
      const { ratio, count } = changeAmount(run.prevSample, sample);
      run.prevSample = sample;
      if (ratio >= thresholdFor(s.sensitivity) && count >= 4) {
        run.dirty = true;
        run.lastChangeAt = now;
      }
    }

    const settled = now - run.lastChangeAt >= s.settleMs;
    const geminiReady = run.mode !== 'ia' || Date.now() >= run.nextGeminiAt;
    if (!run.dirty || run.processing || !settled || !geminiReady) return;

    run.dirty = false;
    const silent = run.silentBaseline;
    run.silentBaseline = false;
    // Un pequeño margen para no cortar letras si la zona se ha marcado muy justa.
    const crop = cropFrame(frame, padZone(z, frame, Math.max(8, Math.round(frame.w * 0.012))), run.mode);
    run.processing = true;
    refreshStatus();
    const job = run.mode === 'ia' ? processWithGemini(crop, s) : processWithOcr(crop, s, silent);
    job
      .catch((err) => {
        const msg = err && err.message ? err.message : String(err);
        showMessage(msg);
        addLog(msg, 'error');
      })
      .finally(() => {
        run.processing = false;
        refreshStatus();
      });
  }

  function padZone(z, frame, pad) {
    const x = Math.max(0, z.x - pad);
    const y = Math.max(0, z.y - pad);
    return {
      x,
      y,
      w: Math.min(frame.w - x, z.w + (z.x - x) + pad),
      h: Math.min(frame.h - y, z.h + (z.y - y) + pad),
    };
  }

  function cropFrame(frame, z, mode) {
    let scale;
    if (mode === 'ia') {
      scale = Math.min(1, 1280 / Math.max(z.w, z.h));
    } else {
      // Tesseract reconoce mejor el texto si las letras no son pequeñas.
      scale = Math.min(2, Math.max(1, 1400 / z.w));
      if (z.w * z.h * scale * scale > 6e6) scale = Math.sqrt(6e6 / (z.w * z.h));
    }
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(z.w * scale));
    canvas.height = Math.max(1, Math.round(z.h * scale));
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(frame.src, z.x, z.y, z.w, z.h, 0, 0, canvas.width, canvas.height);
    return canvas;
  }

  /* ================= Modo sin IA: reconocimiento de texto en el ordenador ================= */

  const ocr = { worker: null, lang: '', promise: null };

  async function getOcrWorker(language) {
    if (!window.Tesseract) {
      throw new Error('No se ha podido cargar el reconocimiento de texto. Comprueba tu conexión a internet y recarga la página: la primera vez se descarga.');
    }
    const code = OCR_LANG[language] || 'spa';
    if (ocr.worker && ocr.lang === code) return ocr.worker;
    if (ocr.promise && ocr.lang === code) return ocr.promise;
    if (ocr.worker) {
      const old = ocr.worker;
      ocr.worker = null;
      old.terminate().catch(() => {});
    }
    ocr.lang = code;
    setPreparing('Preparando el reconocimiento de texto…');
    ocr.promise = window.Tesseract.createWorker(code, 1, {
      logger: (m) => {
        if (!m || typeof m.progress !== 'number' || /recogniz/i.test(m.status || '')) return;
        setPreparing(`Preparando el reconocimiento de texto… ${Math.round(m.progress * 100)} %`);
      },
    })
      .then((worker) => {
        ocr.worker = worker;
        return worker;
      })
      .catch((err) => {
        ocr.lang = '';
        throw new Error(`No se ha podido preparar el reconocimiento de texto: ${err && err.message ? err.message : err}`);
      })
      .finally(() => {
        ocr.promise = null;
        setPreparing('');
      });
    return ocr.promise;
  }

  function normalizeKey(text) {
    return text
      .toLowerCase()
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^\p{L}\p{N}]+/gu, ' ')
      .trim();
  }

  /** Parecido entre dos textos (0 = nada, 1 = iguales), para no repetir líneas mal reconocidas. */
  function similarity(a, b) {
    if (a === b) return 1;
    if (a.length < 2 || b.length < 2) return 0;
    const pairs = new Map();
    for (let i = 0; i < a.length - 1; i += 1) {
      const bg = a.slice(i, i + 2);
      pairs.set(bg, (pairs.get(bg) || 0) + 1);
    }
    let hits = 0;
    for (let i = 0; i < b.length - 1; i += 1) {
      const bg = b.slice(i, i + 2);
      const n = pairs.get(bg) || 0;
      if (n > 0) {
        pairs.set(bg, n - 1);
        hits += 1;
      }
    }
    return (2 * hits) / (a.length + b.length - 2);
  }

  function extractLines(data, s) {
    const lines = [];
    let para = 0;
    const push = (text, confidence) => {
      const clean = String(text || '').replace(/\s+/g, ' ').trim();
      if (!clean) return;
      if (typeof confidence === 'number' && confidence < s.minConfidence) return;
      const letters = (clean.match(/\p{L}/gu) || []).length;
      if (letters < s.minChars) return;
      lines.push({ text: clean, key: normalizeKey(clean), para });
    };
    if (Array.isArray(data.blocks)) {
      for (const block of data.blocks) {
        for (const paragraph of block.paragraphs || []) {
          para += 1;
          for (const line of paragraph.lines || []) push(line.text, line.confidence);
        }
      }
    } else {
      String(data.text || '').split('\n').forEach((t) => {
        para += 1;
        push(t, undefined);
      });
    }
    return lines;
  }

  /* ---- ¿En qué idioma está una frase? Se cuentan palabras muy comunes de cada idioma. ---- */

  const COMMON_WORDS = {
    es: 'de la que el en y los se del las un por con una su para es al lo como más pero sus le ya este sí porque esta entre cuando muy sin sobre también hasta hay donde quien desde todo nos durante todos uno les ni contra otros ese eso ante ellos esto antes algunos qué unos yo otro otras otra él tanto esa estos mucho nada muchos cual poco ella estar estas algo nosotros mi mis tú te ti tu tus eres soy está están son fue han hoy mientras aquí así ahora siempre nunca cómo dónde',
    en: 'the of and to in is you that it was for on are as with his they at be this have from or one had by but not what all were we when your can said there use an each which she do how their if will up other about out many then them these so some her would make like him into time has look two more could people my than first been who its now find down day did get come made may part where most keep add our here just only over',
    fr: 'le les des du une et est que qui dans pour pas sur au avec ce il elle nous vous ils sont je ne plus par mais ou son sa ses leur cette aux été être fait',
    it: 'il lo gli di da che non sono un una del della dei delle al alla anche come ma più questo questa nella sul per',
    pt: 'os as do da dos das em no na nos nas um uma uns umas que não são para com mais mas como ao também já foi eu você ele ela isso esse essa pelo pela',
    de: 'der die das und ist nicht ein eine zu den von mit sich des auf für im dem es an auch als wie aus bei nach wir ich du sie er wird sind war hat oder aber',
  };
  const COMMON_SETS = Object.fromEntries(Object.entries(COMMON_WORDS).map(([lang, words]) => [lang, new Set(words.split(' '))]));

  function languageScores(text) {
    const scores = { es: 0, en: 0, fr: 0, it: 0, pt: 0, de: 0 };
    const words = text.toLowerCase().match(/\p{L}+/gu) || [];
    for (const w of words) {
      for (const lang of Object.keys(scores)) if (COMMON_SETS[lang].has(w)) scores[lang] += 1;
    }
    const lower = text.toLowerCase();
    if (/[ñ¿¡]/.test(lower)) scores.es += 2;
    if (/ção|ções|ões|[ãõ]/.test(lower)) scores.pt += 2;
    if (/ç/.test(lower)) { scores.fr += 1; scores.pt += 1; }
    if (/[äöüß]/.test(lower)) scores.de += 2;
    if (/[èàùò]/.test(lower)) { scores.it += 1; scores.fr += 1; }
    if (/[áíóú]/.test(lower)) { scores.es += 0.5; scores.pt += 0.5; }
    return scores;
  }

  function isInLanguage(text, lang) {
    const scores = languageScores(text);
    const mine = scores[lang] || 0;
    if (mine <= 0) return false;
    return Object.entries(scores).every(([other, value]) => other === lang || value <= mine);
  }

  /** Agrupa las líneas por párrafo y se queda con las que parecen una frase en el idioma elegido. */
  function keepRealPhrases(lines, s) {
    const groups = [];
    for (const line of lines) {
      const last = groups[groups.length - 1];
      if (last && last.para === line.para) last.lines.push(line);
      else groups.push({ para: line.para, lines: [line] });
    }
    return groups.filter((g) => {
      const text = joinLines(g.lines);
      const words = (text.match(/\p{L}+/gu) || []).length;
      if (words < s.minWords) return false;
      if (s.onlyLanguage && !isInLanguage(text, s.language)) return false;
      return true;
    }).map((g) => joinLines(g.lines));
  }

  function joinLines(lines) {
    let out = '';
    for (const { text } of lines) {
      if (out.endsWith('-') && /^\p{Ll}/u.test(text)) out = out.slice(0, -1) + text;
      else out = out ? `${out} ${text}` : text;
    }
    return out.trim();
  }

  function withSuffix(text, suffix) {
    if (!suffix) return text;
    const end = /[.!?…:;,]$/.test(text) ? '' : '.';
    return `${text}${end} ${suffix}`;
  }

  async function processWithOcr(canvas, s, silent) {
    const worker = await getOcrWorker(s.language);
    const { data } = await worker.recognize(canvas, {}, { text: true, blocks: true });
    if (!run.active) return;
    const lines = extractLines(data, s);
    const previous = run.prevLines;
    run.prevLines = lines;
    if (silent) return;

    let toRead;
    if (s.onlyNewLines) {
      toRead = lines.filter((line) => !previous.some((p) => similarity(p.key, line.key) >= 0.8));
    } else {
      const allKey = lines.map((l) => l.key).join(' ');
      toRead = allKey && similarity(allKey, run.lastSpokenKey) >= 0.9 ? [] : lines;
    }
    const text = keepRealPhrases(toRead, s).join(' ');
    if (!text) return;
    run.lastSpokenKey = lines.map((l) => l.key).join(' ');
    if (s.interrupt) voice.stopAll();
    speakText(withSuffix(text, s.suffix), s);
    if (s.onlyOne) finishAfterOne();
  }

  /* ================= Modo con IA: Google Gemini ================= */

  const GEMINI_SYSTEM = [
    'Eres LAURA, una lectora en voz alta. Recibes una captura de una ventana del ordenador y una instrucción de la persona que te usa.',
    'Decide si, según la instrucción, en esta captura hay algo que haya que leer en voz alta en este momento.',
    'Copia el texto tal como aparece, sin resumirlo, traducirlo ni añadir nada, salvo que la instrucción pida otra cosa.',
    'No repitas lo que ya se ha leído, salvo que la instrucción lo pida.',
    'Si todavía no ha aparecido lo que la instrucción espera, no leas nada.',
    'Responde solo con un objeto JSON con estas claves:',
    '"leer" (true o false), "texto" (lo que hay que decir, o cadena vacía),',
    '"velocidad" (número entre 0.6 y 1.5, o null si la instrucción no habla de velocidad),',
    '"volumen" (número entre 0.5 y 2, o null si la instrucción no habla de volumen),',
    '"nota" (explicación muy breve en español de por qué lees o no lees).',
  ].join(' ');

  function geminiErrorMessage(status, detail, model) {
    const d = String(detail || '').toLowerCase();
    if (d.includes('api key not valid') || d.includes('api_key_invalid') || status === 401) return 'Google no acepta la clave. Revisa GEMINI_API_KEY en tu archivo de claves.';
    if (status === 404 || d.includes('not found')) return `El modelo «${model}» no está disponible para tu clave. Pulsa «Ver los modelos de mi clave» y elige otro.`;
    if (status === 429) return 'Has llegado al límite gratuito de Google por ahora. LAURA esperará un poco y seguirá.';
    if (status === 403) return 'Google rechaza la petición. Puede que tu clave no tenga acceso o que el plan gratis no esté disponible en tu país.';
    return `Google no ha podido analizar la captura${detail ? `: ${String(detail).slice(0, 200)}` : '.'}`;
  }

  async function geminiFetch(path, options = {}) {
    if (!creds.geminiKey) throw new Error('Falta GEMINI_API_KEY en tu archivo de claves. Solo hace falta para el modo «Lo que yo le diga».');
    let res;
    try {
      res = await fetch(`${CONFIG.geminiBase}${path}`, {
        ...options,
        headers: { ...(options.headers || {}), 'x-goog-api-key': creds.geminiKey },
      });
    } catch {
      throw new Error('No se ha podido conectar con Google. Comprueba tu conexión a internet.');
    }
    let data = null;
    try { data = await res.json(); } catch { data = null; }
    return { res, data };
  }

  function extractJson(text) {
    const clean = String(text || '').replace(/```(?:json)?/gi, '').trim();
    try { return JSON.parse(clean); } catch { /* sigue */ }
    const start = clean.indexOf('{');
    const end = clean.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try { return JSON.parse(clean.slice(start, end + 1)); } catch { /* sigue */ }
    }
    return null;
  }

  const clampOrNull = (v, min, max) => {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : null;
  };

  async function processWithGemini(canvas, s) {
    const image = canvas.toDataURL('image/jpeg', 0.82).split(',')[1];
    run.nextGeminiAt = Date.now() + s.geminiGap * 1000;
    const elapsed = Math.round((Date.now() - run.startedAt) / 1000);
    const userText = [
      `Instrucción: ${s.instruction}`,
      `Segundos desde que se pulsó Empezar: ${elapsed}.`,
      run.recent.length ? `Ya se ha leído (no lo repitas): ${run.recent.map((t) => `«${t.slice(0, 300)}»`).join(' ')}` : 'Todavía no se ha leído nada.',
      'Esta es la captura actual.',
    ].join('\n');

    const { res, data } = await geminiFetch(`/models/${encodeURIComponent(s.geminiModel)}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: GEMINI_SYSTEM }] },
        contents: [{ role: 'user', parts: [{ text: userText }, { inlineData: { mimeType: 'image/jpeg', data: image } }] }],
        generationConfig: { responseMimeType: 'application/json' },
      }),
    });
    if (!run.active) return;
    if (!res.ok) {
      if (res.status === 429) {
        run.nextGeminiAt = Date.now() + 30000;
        run.dirty = true;
        run.lastChangeAt = -Infinity;
      }
      throw new Error(geminiErrorMessage(res.status, data && data.error ? data.error.message : '', s.geminiModel));
    }

    const parts = (data && data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts) || [];
    const text = parts.filter((p) => typeof p.text === 'string' && !p.thought).map((p) => p.text).join('');
    const answer = extractJson(text);
    if (!answer || typeof answer !== 'object') {
      throw new Error('Google ha respondido algo que LAURA no entiende. Se volverá a intentar con el próximo cambio.');
    }

    if (answer.nota) {
      els.aiNote.textContent = `La IA: ${String(answer.nota).slice(0, 300)}`;
      els.aiNote.hidden = false;
    }
    const say = String(answer.texto || '').trim();
    if ((answer.leer === true || answer.leer === 'true') && say) {
      if (s.interrupt) voice.stopAll();
      speakText(say, s, {
        speed: clampOrNull(answer.velocidad, 0.6, 1.5) ?? undefined,
        volume: clampOrNull(answer.volumen, 0.5, 2) ?? undefined,
      });
      if (s.onlyOne) finishAfterOne();
    }
  }

  async function listGeminiModels() {
    const { res, data } = await geminiFetch('/models?pageSize=1000');
    if (!res.ok) throw new Error(geminiErrorMessage(res.status, data && data.error ? data.error.message : '', ''));
    return ((data && data.models) || [])
      .filter((m) => (m.supportedGenerationMethods || []).includes('generateContent'))
      .map((m) => String(m.name || '').replace(/^models\//, ''))
      .filter((name) => /flash/i.test(name) && !/(image|tts|audio|live|embedding|veo|imagen)/i.test(name))
      .sort();
  }

  /* ================= Empezar y parar ================= */

  async function start() {
    hideMessage();
    voice.ensureAudio();
    const s = readSettings();
    if (!creds.voiceId || !creds.cartesiaKey) {
      showMessage('Faltan las claves de Cartesia. Pulsa «Cargar claves» y elige tu archivo de claves.');
      return;
    }
    if (s.mode === 'ia') {
      if (!creds.geminiKey) {
        showMessage('Para el modo «Lo que yo le diga» falta GEMINI_API_KEY en tu archivo de claves.');
        return;
      }
      if (!s.instruction) {
        showMessage('Escribe tu instrucción en el paso 3.');
        $('instruction').focus();
        return;
      }
    }
    // La ventana se pide justo después del clic: los navegadores lo exigen.
    if (!stream) {
      const ok = await pickWindow();
      if (!ok) {
        if (stream) showMessage('Marca la zona donde saldrá la frase, o elige «Usar toda la ventana», y vuelve a pulsar Empezar.', 'info');
        return;
      }
    } else if (!zoneDecided) {
      const choice = await openPicker();
      if (choice === 'cancel') {
        showMessage('Marca la zona donde saldrá la frase, o elige «Usar toda la ventana», y vuelve a pulsar Empezar.', 'info');
        return;
      }
    }
    if (s.mode === 'zona') {
      try {
        await getOcrWorker(s.language);
      } catch (err) {
        showMessage(err.message);
        return;
      }
    }

    Object.assign(run, {
      active: true,
      mode: s.mode,
      startedAt: Date.now(),
      prevSample: null,
      dirty: false,
      lastChangeAt: 0,
      processing: false,
      firstPass: true,
      silentBaseline: s.mode === 'zona' && !s.readExisting,
      prevLines: [],
      lastSpokenKey: '',
      recent: [],
      nextGeminiAt: 0,
    });
    ui.running = true;
    els.aiNote.hidden = true;
    els.startBtn.disabled = true;
    els.stopBtn.disabled = false;
    addLog(s.mode === 'ia' ? 'Empieza: la IA sigue tu instrucción.' : 'Empieza: se lee el texto nuevo que aparezca.', 'info');
    refreshStatus();
  }

  function stop(log = true) {
    run.active = false;
    ui.running = false;
    voice.stopAll();
    els.startBtn.disabled = false;
    els.stopBtn.disabled = true;
    if (log) addLog('Parada.', 'info');
    refreshStatus();
  }

  /** Deja de vigilar después de leer una frase, sin cortar la voz. */
  function finishAfterOne() {
    run.active = false;
    ui.running = false;
    els.startBtn.disabled = false;
    els.stopBtn.disabled = true;
    addLog(`Frase leída: LAURA se ha parado. Para leer otra, pulsa Empezar o ${IS_MAC ? 'Cmd' : 'Ctrl'} + G.`, 'info');
    refreshStatus();
  }

  /* ================= Eventos ================= */

  function init() {
    loadSettings();
    restoreKeys();
    renderCreds();
    updateOutputs();
    updateModeOptions();
    updateLanguageLabel();
    renderZone();
    refreshStatus();

    document.querySelectorAll('input, select, textarea').forEach((el) => {
      if (el.id === 'keysFile' || el.id === 'rememberKeys') return;
      el.addEventListener('input', () => {
        updateOutputs();
        saveSettings();
      });
      el.addEventListener('change', saveSettings);
    });

    document.querySelectorAll('input[name="mode"]').forEach((radio) => {
      radio.addEventListener('change', () => {
        updateModeOptions();
        if (ui.running) {
          stop(false);
          showMessage('Has cambiado de modo. Pulsa «Empezar» otra vez.', 'info');
        }
      });
    });

    // Claves
    const fileInput = $('keysFile');
    $('loadKeys').addEventListener('click', () => {
      fileInput.value = '';
      fileInput.click();
    });
    fileInput.addEventListener('change', () => loadKeysFile(fileInput.files && fileInput.files[0]));
    $('forgetKeys').addEventListener('click', forgetKeys);
    $('rememberKeys').addEventListener('change', storeKeys);

    const dropZone = $('stepVoz');
    dropZone.addEventListener('dragover', (event) => {
      event.preventDefault();
      dropZone.classList.add('drop-target');
    });
    dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drop-target'));
    dropZone.addEventListener('drop', (event) => {
      event.preventDefault();
      dropZone.classList.remove('drop-target');
      const file = event.dataTransfer && event.dataTransfer.files && event.dataTransfer.files[0];
      loadKeysFile(file);
    });
    // Si se suelta el archivo fuera del recuadro, que el navegador no lo abra.
    window.addEventListener('dragover', (event) => event.preventDefault());
    window.addEventListener('drop', (event) => event.preventDefault());

    els.testVoice.addEventListener('click', async () => {
      hideMessage();
      voice.ensureAudio();
      const text = $('testText').value.trim() || 'Hola, así suena mi voz.';
      els.testVoice.disabled = true;
      try {
        await voice.speak(text, voiceOptions(readSettings()));
      } catch (err) {
        showMessage(err.message);
      } finally {
        els.testVoice.disabled = false;
      }
    });

    $('pickWindow').addEventListener('click', () => pickWindow());
    $('markZone').addEventListener('click', () => openPicker());

    $('clearZone').addEventListener('click', () => {
      zone = null;
      zoneDecided = Boolean(stream);
      saveSettings();
      renderZone();
      resetDetection();
    });

    // En Windows, la captura de zona se hace con Windows + Mayús + S.
    if (!IS_MAC) {
      for (const el of [$('pickerTitle'), document.querySelector('#h-ventana + .text')]) {
        if (el) el.innerHTML = el.innerHTML.replace('Cmd + Mayúsculas + 4', 'Windows + Mayús + S');
      }
    }

    // Atajo: Cmd + G en Mac, Ctrl + G en Windows. Solo funciona con LAURA delante.
    $('shortcutHint').textContent = `Atajo para empezar y parar: ${IS_MAC ? 'Cmd' : 'Ctrl'} + G, con LAURA delante.`;
    document.addEventListener('keydown', (event) => {
      if (picker.open) {
        if (event.key === 'Escape') {
          event.preventDefault();
          closePicker('cancel');
        } else if (event.key === 'Enter' && validZone(picker.rect)) {
          event.preventDefault();
          closePicker('ok');
        }
        return;
      }
      const mod = IS_MAC ? event.metaKey : event.ctrlKey;
      if (mod && !event.shiftKey && !event.altKey && event.key.toLowerCase() === 'g') {
        event.preventDefault();
        if (ui.running) stop(true);
        else start();
      }
    });

    // Safari y Firefox no dejan elegir una pestaña concreta.
    const ua = navigator.userAgent || '';
    const isChromium = /Chrome|Chromium|Edg\//.test(ua) || Boolean(navigator.userAgentData);
    if (!isChromium) {
      const warn = $('browserWarn');
      warn.textContent = /Firefox/i.test(ua)
        ? 'Firefox no deja elegir una pestaña concreta, solo ventanas o la pantalla entera. Para elegir la pestaña que quieres leer, abre LAURA con Chrome, Edge o Brave.'
        : 'Safari no deja elegir una pestaña concreta, solo ventanas o la pantalla entera. Para elegir la pestaña que quieres leer, abre LAURA con Chrome, Edge o Brave.';
      warn.hidden = false;
    }

    $('loadModels').addEventListener('click', async () => {
      const info = $('modelsInfo');
      info.textContent = 'Consultando a Google…';
      try {
        const models = await listGeminiModels();
        $('geminiModels').replaceChildren(...models.map((name) => Object.assign(document.createElement('option'), { value: name })));
        info.textContent = models.length
          ? `Modelos disponibles: ${models.join(', ')}. Escribe o elige uno en la casilla.`
          : 'Tu clave no muestra modelos Flash disponibles.';
      } catch (err) {
        info.textContent = err.message;
      }
    });

    els.startBtn.addEventListener('click', start);
    els.stopBtn.addEventListener('click', () => stop(true));
    $('language').addEventListener('change', updateLanguageLabel);

    $('clearLog').addEventListener('click', () => {
      els.log.replaceChildren();
      els.logEmpty.hidden = false;
    });

    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) refreshStatus();
    });
  }

  init();
})();
