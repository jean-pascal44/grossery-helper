// Enregistrement micro + conversion en WAV 16 kHz mono pour Gemini.
//
// MediaRecorder produit du webm/opus (Chrome, Firefox) ou du mp4/aac (Safari). On décode
// ce flux avec Web Audio et on le ré-encode en WAV, format accepté sans ambiguïté par Gemini
// (≈ 32 Ko/s, donc ~2 Mo pour une minute, bien sous la limite de 20 Mo en inline).

const TARGET_RATE = 16000;

export class Recorder {
  get recording() { return this.rec?.state === 'recording'; }
  get duration() { return this.startedAt ? (Date.now() - this.startedAt) / 1000 : 0; }

  /** @param {(level: number) => void} [onLevel] niveau sonore 0..1 pour l'animation */
  async start(onLevel) {
    if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
      throw new Error('Micro non disponible sur ce navigateur (une connexion HTTPS est requise).');
    }
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 },
    });
    const mimeType = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus']
      .find((t) => MediaRecorder.isTypeSupported?.(t));
    this.chunks = [];
    this.rec = new MediaRecorder(this.stream, mimeType ? { mimeType } : undefined);
    this.rec.ondataavailable = (e) => { if (e.data?.size) this.chunks.push(e.data); };
    this.rec.start(250);
    this.startedAt = Date.now();
    if (onLevel) this._meter(onLevel);
  }

  _meter(onLevel) {
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      this.actx = new AC();
      this.actx.resume?.();
      const analyser = this.actx.createAnalyser();
      analyser.fftSize = 512;
      this.actx.createMediaStreamSource(this.stream).connect(analyser);
      const data = new Uint8Array(analyser.fftSize);
      const loop = () => {
        if (!this.actx) return;
        analyser.getByteTimeDomainData(data);
        let sum = 0;
        for (const v of data) { const x = (v - 128) / 128; sum += x * x; }
        onLevel(Math.min(1, Math.sqrt(sum / data.length) * 5));
        this.raf = requestAnimationFrame(loop);
      };
      loop();
    } catch { /* l'animation est facultative */ }
  }

  /** @returns {Promise<Blob>} */
  stop() {
    return new Promise((resolve, reject) => {
      const rec = this.rec;
      if (!rec || rec.state === 'inactive') { reject(new Error('Aucun enregistrement en cours.')); return; }
      rec.onstop = () => {
        const blob = new Blob(this.chunks, { type: rec.mimeType || 'audio/webm' });
        this._cleanup();
        resolve(blob);
      };
      rec.stop();
    });
  }

  cancel() {
    if (this.rec && this.rec.state !== 'inactive') {
      this.rec.onstop = null;
      try { this.rec.stop(); } catch { /* ignore */ }
    }
    this._cleanup();
  }

  _cleanup() {
    cancelAnimationFrame(this.raf);
    this.actx?.close().catch(() => {});
    this.actx = null;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.rec = null;
    this.startedAt = 0;
  }
}

/** Prépare l'audio pour l'API Gemini : { mimeType, base64 }. */
export async function toGeminiAudio(blob) {
  try {
    const wav = await toWav(blob);
    return { mimeType: 'audio/wav', base64: await blobToBase64(wav) };
  } catch (e) {
    console.warn('[audio] conversion WAV impossible, envoi du format brut', e);
    return { mimeType: (blob.type || 'audio/webm').split(';')[0], base64: await blobToBase64(blob) };
  }
}

async function toWav(blob) {
  const buf = await blob.arrayBuffer();
  const AC = window.AudioContext || window.webkitAudioContext;
  const ctx = new AC();
  let decoded;
  try {
    decoded = await new Promise((res, rej) => {
      const p = ctx.decodeAudioData(buf, res, rej); // ancienne API à callbacks (vieux Safari)
      p?.then?.(res, rej);
    });
  } finally {
    ctx.close().catch(() => {});
  }
  const length = Math.max(1, Math.ceil(decoded.duration * TARGET_RATE));
  const offline = new OfflineAudioContext(1, length, TARGET_RATE); // 1 canal = mixage mono automatique
  const src = offline.createBufferSource();
  src.buffer = decoded;
  src.connect(offline.destination);
  src.start();
  const rendered = await offline.startRendering();
  return encodeWav(rendered.getChannelData(0), TARGET_RATE);
}

function encodeWav(samples, rate) {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const v = new DataView(buffer);
  const writeStr = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  writeStr(0, 'RIFF');
  v.setUint32(4, 36 + samples.length * 2, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  v.setUint32(16, 16, true); // taille du bloc fmt
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 1, true); // mono
  v.setUint32(24, rate, true);
  v.setUint32(28, rate * 2, true); // octets / seconde
  v.setUint16(32, 2, true); // octets / échantillon
  v.setUint16(34, 16, true); // bits / échantillon
  writeStr(36, 'data');
  v.setUint32(40, samples.length * 2, true);
  for (let i = 0, o = 44; i < samples.length; i++, o += 2) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    v.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Blob([buffer], { type: 'audio/wav' });
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1] || '');
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}
