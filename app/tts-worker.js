// Merlin TTS utility process — runs Kokoro synthesis off the Electron main
// thread so the UI never stalls during phonemization / ONNX inference.
//
// Why a utility process (not a worker_thread):
//   * Electron's utilityProcess.fork() gives us a real OS process with its
//     own V8 isolate — crashes here can't take down the app window.
//   * The kokoro-js + @huggingface/transformers stack pulls in ~40 MB of
//     runtime; isolating it keeps the main-process footprint lean.
//   * DirectML / CoreML backends spin up their own threadpools; running
//     alongside the UI event loop was causing "Not Responding" stalls.
//
// Protocol (messages via process.parentPort):
//   → { type: "init",  cacheDir, device }                     one-shot setup
//   → { type: "synth", reqId, text, voice, device }           start streamed synthesis
//   → { type: "abort" }                                       cancel in-flight synth
//   ← { type: "ready" }                                       after init + model load
//   ← { type: "progress", ...HFProgressPayload }              model download / load
//   ← { type: "chunk", reqId, seq, audio: Uint8Array }        one per sentence (WAV)
//   ← { type: "final", reqId, seq?, aborted?, error? }        end of stream
//   ← { type: "error", reqId?, message }                      unrecoverable failure
const KOKORO_REPO = 'onnx-community/Kokoro-82M-v1.0-ONNX';

let _tts = null;
let _loading = null;
let _cacheDir = null;
let _device = 'cpu';
// Unique token for the active synth — overwritten on new synth or abort, so
// the running for-await loop exits by identity check without throwing.
let _currentToken = null;

function post(payload) {
  try { process.parentPort.postMessage(payload); } catch {}
}

async function loadModel(device) {
  if (_tts) return _tts;
  if (_loading) return _loading;
  _loading = (async () => {
    const { env } = await import('@huggingface/transformers');
    if (_cacheDir) {
      env.cacheDir = _cacheDir;
      env.allowLocalModels = true;
      env.allowRemoteModels = true;
    }
    const { KokoroTTS } = await import('kokoro-js');
    // GPU backends fall back to CPU transparently inside onnxruntime when
    // unavailable, but an explicit try/catch on the selected device lets us
    // surface a useful log line and retry with cpu rather than silently
    // running the slow path.
    try {
      _tts = await KokoroTTS.from_pretrained(KOKORO_REPO, {
        dtype: 'q8',
        device,
        progress_callback: (p) => post({ type: 'progress', ...p }),
      });
    } catch (err) {
      if (device !== 'cpu') {
        console.warn(`[tts-worker] ${device} backend failed, falling back to cpu:`, err && err.message);
        _tts = await KokoroTTS.from_pretrained(KOKORO_REPO, {
          dtype: 'q8',
          device: 'cpu',
          progress_callback: (p) => post({ type: 'progress', ...p }),
        });
      } else {
        throw err;
      }
    }
    return _tts;
  })();
  try { return await _loading; }
  finally { _loading = null; }
}

async function handleSynth(msg) {
  const token = {};
  _currentToken = token;
  const { reqId, text, voice } = msg;
  try {
    const tts = await loadModel(_device);
    if (_currentToken !== token) { post({ type: 'final', reqId, aborted: true }); return; }
    let seq = 0;
    for await (const chunk of tts.stream(text, { voice })) {
      if (_currentToken !== token) { post({ type: 'final', reqId, seq, aborted: true }); return; }
      const wav = new Uint8Array(chunk.audio.toWav());
      post({ type: 'chunk', reqId, seq, audio: wav });
      seq++;
    }
    if (_currentToken === token) _currentToken = null;
    post({ type: 'final', reqId, seq });
  } catch (err) {
    if (_currentToken === token) _currentToken = null;
    post({ type: 'error', reqId, message: String(err && err.message ? err.message : err) });
  }
}

process.parentPort.on('message', async (event) => {
  const msg = event && event.data;
  if (!msg || typeof msg.type !== 'string') return;
  try {
    if (msg.type === 'init') {
      _cacheDir = msg.cacheDir || null;
      _device = msg.device || 'cpu';
      await loadModel(_device);
      post({ type: 'ready' });
    } else if (msg.type === 'synth') {
      // Fire-and-forget — handleSynth streams its own chunks + final message.
      handleSynth(msg);
    } else if (msg.type === 'abort') {
      _currentToken = null;
    }
  } catch (err) {
    post({ type: 'error', message: String(err && err.message ? err.message : err) });
  }
});

process.on('uncaughtException', (err) => {
  try { post({ type: 'error', message: 'uncaught: ' + String(err && err.message ? err.message : err) }); } catch {}
});
