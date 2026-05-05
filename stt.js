'use strict';
const path    = require('path');
const fs      = require('fs');
const https   = require('https');
const { execFile }  = require('child_process');
const { Worker }    = require('worker_threads');

const MODEL_URL    = 'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-whisper-tiny.tar.bz2';
const MODEL_SUBDIR = 'sherpa-onnx-whisper-tiny';
const MODEL_FILES  = ['tiny-encoder.int8.onnx', 'tiny-decoder.int8.onnx', 'tiny-tokens.txt'];

let worker       = null;
let workerReady  = false;
let nextReqId    = 1;
const pending    = new Map();   // id → { resolve, reject }

let onStateChange = null;
let state = { available: false, downloading: false, progress: 0, error: null };
let userDataPath = null;

function setState(patch) {
  Object.assign(state, patch);
  if (onStateChange) onStateChange({ ...state });
}

function bundledModelDir() {
  // When packaged in an asar, bundled files live in app.asar.unpacked
  return path.join(__dirname, 'stt-model', MODEL_SUBDIR)
    .replace('app.asar' + path.sep, 'app.asar.unpacked' + path.sep);
}

function modelDir(userData) {
  // Prefer model bundled at compile time; fall back to user-downloaded copy
  const bundled = bundledModelDir();
  if (MODEL_FILES.every(f => fs.existsSync(path.join(bundled, f)))) return bundled;
  return path.join(userData, 'stt-model', MODEL_SUBDIR);
}

function isModelReady(userData) {
  const dir = modelDir(userData);
  return MODEL_FILES.every(f => fs.existsSync(path.join(dir, f)));
}

// ── Download with redirect following ──────────────────
function downloadFile(url, destPath, onProgress) {
  return new Promise((resolve, reject) => {
    const follow = (url, depth) => {
      if (depth > 10) return reject(new Error('Too many redirects'));
      const req = https.get(url, { headers: { 'User-Agent': 'AIConsole/1.0' } }, (res) => {
        if ([301, 302, 307, 308].includes(res.statusCode)) {
          res.resume();
          return follow(res.headers.location, depth + 1);
        }
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`HTTP ${res.statusCode}`));
        }
        const total = parseInt(res.headers['content-length'] || '0', 10);
        let received = 0;
        const out = fs.createWriteStream(destPath);
        res.on('data', chunk => {
          received += chunk.length;
          if (total > 0 && onProgress) onProgress(received / total);
        });
        res.pipe(out);
        out.on('finish', () => out.close(resolve));
        const cleanup = (err) => { try { fs.unlinkSync(destPath); } catch {} reject(err); };
        out.on('error', cleanup);
        res.on('error', cleanup);
      });
      req.on('error', reject);
    };
    follow(url, 0);
  });
}

async function downloadAndExtract(userData) {
  const parentDir   = path.join(userData, 'stt-model');
  const archivePath = path.join(parentDir, 'model.tar.bz2');
  fs.mkdirSync(parentDir, { recursive: true });

  setState({ downloading: true, progress: 0, error: null });
  try {
    await downloadFile(MODEL_URL, archivePath, p => setState({ progress: p * 0.9 }));
    setState({ progress: 0.9 });

    await new Promise((resolve, reject) => {
      execFile('tar', ['-xf', archivePath, '-C', parentDir], (err) => {
        if (err) reject(new Error(`tar extraction failed: ${err.message}`));
        else resolve();
      });
    });

    setState({ progress: 1, downloading: false, error: null });
  } catch (e) {
    setState({ downloading: false, progress: 0, error: String(e) });
    throw e;
  } finally {
    try { fs.unlinkSync(archivePath); } catch {}
  }
}

// ── Worker thread ──────────────────────────────────────
function spawnWorker(userData) {
  // When packaged in an asar, the worker file must come from the unpacked copy.
  const workerPath = path.join(__dirname, 'stt-worker.js')
    .replace('app.asar' + path.sep, 'app.asar.unpacked' + path.sep);

  try {
    worker = new Worker(workerPath);
  } catch (e) {
    console.warn('[STT] Failed to spawn worker:', String(e));
    setState({ available: false, error: `Worker failed to start: ${String(e)}` });
    return;
  }

  worker.on('message', (msg) => {
    if (msg.type === 'init-result') {
      if (msg.ok) {
        workerReady = true;
        setState({ available: true, error: null });
      } else {
        console.warn('[STT] Recognizer init failed:', msg.error);
        setState({ available: false, error: msg.error || 'Recognizer initialization failed' });
      }
    } else if (msg.type === 'transcribe-result') {
      const p = pending.get(msg.id);
      pending.delete(msg.id);
      if (!p) return;
      if (msg.ok) p.resolve(msg.text);
      else p.reject(new Error(msg.error));
    }
  });

  worker.on('error', (e) => {
    console.warn('[STT] Worker error:', String(e));
    workerReady = false;
    setState({ available: false, error: String(e) });
    for (const p of pending.values()) p.reject(e);
    pending.clear();
  });

  worker.on('exit', (code) => {
    if (code !== 0) {
      console.warn('[STT] Worker exited with code:', code);
      setState({ available: false, error: `Worker exited with code ${code}` });
    }
    workerReady = false;
  });

  worker.postMessage({ type: 'init', modelDir: modelDir(userData) });
}

// ── Public API ────────────────────────────────────────
async function init(userData, stateCallback) {
  onStateChange = stateCallback;
  userDataPath = userData;

  if (isModelReady(userData)) {
    spawnWorker(userData);
  }
}

function download() {
  console.log('[STT] download() called — state:', JSON.stringify(state), 'userDataPath:', userDataPath);
  if (state.downloading || state.available || !userDataPath) {
    console.log('[STT] download() early return — downloading:', state.downloading, 'available:', state.available, 'userDataPath:', userDataPath);
    return;
  }
  downloadAndExtract(userDataPath)
    .then(() => spawnWorker(userDataPath))
    .catch(e => {
      console.warn('[STT] Model download failed:', String(e));
      // state.error already set inside downloadAndExtract's catch block
    });
}

function transcribe(samplesArray, sampleRate, language) {
  if (!workerReady || !worker) throw new Error('STT not ready');
  return new Promise((resolve, reject) => {
    const id  = nextReqId++;
    pending.set(id, { resolve, reject });
    const buf = Float32Array.from(samplesArray).buffer;
    worker.postMessage({ type: 'transcribe', id, samples: buf, sampleRate, language: language || 'en' }, [buf]);
  });
}

function shutdown() {
  if (worker) {
    const p = worker.terminate().catch(() => {});
    worker = null;
    workerReady = false;
    return p;
  }
  return Promise.resolve();
}

module.exports = {
  init,
  download,
  transcribe,
  shutdown,
  getState: () => ({ ...state }),
};
