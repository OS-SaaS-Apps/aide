'use strict';
const { parentPort } = require('worker_threads');
const path = require('path');

let recognizer     = null;
let currentLang    = null;
let modelDir       = null;
let OfflineRecognizer = null;
let wasmModule     = null;

function createRecognizer(language) {
  recognizer  = new OfflineRecognizer({
    modelConfig: {
      whisper: {
        encoder:      path.join(modelDir, 'tiny-encoder.int8.onnx'),
        decoder:      path.join(modelDir, 'tiny-decoder.int8.onnx'),
        language:     language,
        task:         'transcribe',
        tailPaddings: 2000,
      },
      tokens:     path.join(modelDir, 'tiny-tokens.txt'),
      numThreads: 1,
      debug:      0,
      provider:   'cpu',
    },
  }, wasmModule);
  currentLang = language;
}

parentPort.on('message', async (msg) => {
  if (msg.type === 'init') {
    try {
      const wasmFactory = require('sherpa-onnx/sherpa-onnx-wasm-nodejs.js');
      wasmModule = wasmFactory();
      if (wasmModule.ready) await wasmModule.ready;

      ({ OfflineRecognizer } = require('sherpa-onnx/sherpa-onnx-asr.js'));
      modelDir = msg.modelDir;
      createRecognizer(msg.language || 'en');

      parentPort.postMessage({ type: 'init-result', ok: true });
    } catch (e) {
      parentPort.postMessage({
        type: 'init-result', ok: false,
        error: String(e) + (e && e.stack ? '\n' + e.stack : ''),
      });
    }

  } else if (msg.type === 'transcribe') {
    try {
      const lang = msg.language || currentLang;
      if (lang !== currentLang) createRecognizer(lang);

      const samples = new Float32Array(msg.samples);
      const stream  = recognizer.createStream();
      stream.acceptWaveform(msg.sampleRate, samples);
      recognizer.decode(stream);
      const result = recognizer.getResult(stream);
      stream.free();
      parentPort.postMessage({
        type: 'transcribe-result', id: msg.id, ok: true,
        text: (result.text || '').trim(),
      });
    } catch (e) {
      parentPort.postMessage({
        type: 'transcribe-result', id: msg.id, ok: false, error: String(e),
      });
    }
  }
});
