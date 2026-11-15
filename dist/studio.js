import { encodeWav, processTake } from './audio.mjs';

const byId = (id) => document.getElementById(id);
const takes = [];
let database;
let stream;
let context;
let capture;
let recording = false;
let busy = false;
let startedAt = 0;
let clipUntil = 0;
let chunks = [];
let waveSamples;
let selected;
let previewUrl;
let activePlayer;
let editRevision = 0;
let comparingEdits = false;
const drafts = new Map();

function saveSetting(key, value) {
  try { localStorage.setItem(key, value); }
  catch { byId('recordStatus').textContent = 'Browser storage is unavailable for script settings.'; }
}

try {
  byId('script').value = localStorage.getItem('vo-script') ?? '';
  byId('fontSize').value = localStorage.getItem('vo-font-size') ?? 25;
} catch { /* The current session can still record. */ }
byId('script').style.fontSize = byId('fontSize').value + 'px';
byId('script').oninput = () => saveSetting('vo-script', byId('script').value);
byId('fontSize').oninput = () => {
  byId('script').style.fontSize = byId('fontSize').value + 'px';
  saveSetting('vo-font-size', byId('fontSize').value);
};

function openStorage() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('vo-studio', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('takes', { keyPath: 'id' });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('The take database is busy.'));
  });
}

function takeStorage(mode, action) {
  return new Promise((resolve, reject) => {
    const transaction = database.transaction('takes', mode);
    const request = action(transaction.objectStore('takes'));
    transaction.oncomplete = () => resolve(request.result);
    transaction.onabort = () => reject(transaction.error);
  });
}

function seconds(value) {
  const tenths = Math.floor(value * 10);
  const remainder = (tenths % 600) / 10;
  return Math.floor(tenths / 600) + ':' + (remainder < 10 ? '0' : '') + remainder.toFixed(1);
}

function monitor() {
  if (!capture) return;
  if (recording) byId('clock').textContent = seconds((performance.now() - startedAt) / 1000);
  byId('clip').hidden = performance.now() > clipUntil;
  requestAnimationFrame(monitor);
}

function setPeak(peak) {
  const level = Math.max(-60, Math.min(0, 20 * Math.log10(peak)));
  byId('meterFill').style.width = ((level + 60) / 60 * 100) + '%';
  byId('meter').setAttribute('aria-valuenow', String(Math.round(level)));
  if (level >= -1) clipUntil = performance.now() + 1600;
}

function setControls() {
  byId('record').disabled = busy;
  byId('mic').disabled = busy || recording;
  byId('record').textContent = recording ? 'Stop recording' : 'Record';
  byId('mic').textContent = capture ? 'Turn mic off' : 'Enable mic';
  byId('micStatus').textContent = recording ? 'Recording' : capture ? 'Live' : 'Off';
}

async function enableMic() {
  if (!navigator.mediaDevices?.getUserMedia || !window.AudioContext) {
    throw new Error('Open VO Studio over HTTPS or localhost in a browser with microphone access.');
  }
  context = new AudioContext();
  try {
    await context.resume();
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
    await context.audioWorklet.addModule(new URL('./capture.js', import.meta.url));
    capture = new AudioWorkletNode(context, 'vo-capture', {
      channelCount: 1, channelCountMode: 'explicit', numberOfOutputs: 1, outputChannelCount: [1],
    });
    capture.port.onmessage = ({ data }) => {
      if (data.samples) chunks.push(data.samples);
      if (data.peak !== undefined) setPeak(data.peak);
      if (data.stopped) void finishTake(context.sampleRate);
    };
    capture.onprocessorerror = () => failCapture('The audio processor stopped. Enable the mic to try again.');
    stream.getAudioTracks()[0].addEventListener('ended', () => {
      if (capture) failCapture('The microphone disconnected.');
    });
    context.createMediaStreamSource(stream).connect(capture).connect(context.destination);
    monitor();
  } catch (error) {
    disableMic();
    if (error.name === 'NotAllowedError') throw new Error('Allow microphone access in your browser and try again.');
    throw error;
  }
}

function disableMic() {
  capture?.disconnect();
  if (capture) capture.port.onmessage = null;
  capture = null;
  stream?.getTracks().forEach((track) => track.stop());
  stream = null;
  if (context && context.state !== 'closed') void context.close();
  context = null;
  setPeak(0);
  byId('clip').hidden = true;
}

function failCapture(message) {
  disableMic();
  busy = false;
  recording = false;
  chunks = [];
  setControls();
  byId('recordStatus').textContent = message;
}

byId('mic').onclick = async () => {
  byId('recordStatus').textContent = '';
  busy = true;
  setControls();
  try { if (capture) disableMic(); else await enableMic(); }
  catch (error) { byId('recordStatus').textContent = error.message; }
  finally { busy = false; setControls(); }
};

byId('record').onclick = async () => {
  byId('recordStatus').textContent = '';
  busy = true;
  if (recording) {
    recording = false;
    setControls();
    capture.port.postMessage('stop');
    return;
  }
  setControls();
  try {
    activePlayer?.pause();
    if (!capture) await enableMic();
    chunks = [];
    startedAt = performance.now();
    clipUntil = 0;
    recording = true;
    capture.port.postMessage('start');
  } catch (error) {
    byId('recordStatus').textContent = error.message;
  } finally {
    busy = false;
    setControls();
  }
};

async function finishTake(rate) {
  const length = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const samples = new Float32Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    samples.set(chunk, offset);
    offset += chunk.length;
  }
  chunks = [];
  if (length) {
    const createdAt = Date.now();
    const number = Math.max(0, ...takes.map((take) => take.number)) + 1;
    const take = { id: crypto.randomUUID(), createdAt, number, rate, samples };
    takes.unshift(take);
    renderTakes();
    byId('clock').textContent = seconds(length / rate);
    try {
      await takeStorage('readwrite', (store) => store.put(take));
      byId('recordStatus').textContent = 'Take saved on this device.';
    } catch {
      byId('recordStatus').textContent = 'Take available for this session. Export it before closing this page.';
    }
  } else {
    byId('recordStatus').textContent = 'No audio was captured. Try a longer take.';
  }
  busy = false;
  setControls();
}

const takeUrls = new Map();
function takeUrl(take) {
  if (!takeUrls.has(take.id)) takeUrls.set(take.id, URL.createObjectURL(encodeWav(take.samples, take.rate)));
  return takeUrls.get(take.id);
}

function trackPlayer(player) {
  player.addEventListener('play', () => {
    if (activePlayer !== player) activePlayer?.pause();
    if (recording) { player.pause(); return; }
    activePlayer = player;
  });
}

function renderTakes() {
  const list = byId('takes');
  activePlayer?.pause();
  list.replaceChildren();
  byId('takeCount').textContent = String(takes.length);
  if (!takes.length) {
    const empty = document.createElement('p');
    empty.className = 'feedback';
    empty.textContent = 'Recorded takes will appear here.';
    list.append(empty);
  }
  for (const take of takes) {
    const row = document.createElement('div');
    row.className = 'take';
    const heading = document.createElement('span');
    heading.textContent = 'Take ' + take.number + ' · ' + seconds(take.samples.length / take.rate);
    const player = document.createElement('audio');
    player.controls = true;
    player.preload = 'none';
    player.setAttribute('aria-label', 'Play take ' + take.number);
    player.src = takeUrl(take);
    trackPlayer(player);
    const actions = document.createElement('div');
    actions.className = 'actions';
    const edit = document.createElement('button');
    edit.textContent = 'Edit take';
    edit.onclick = () => {
      if (recording || busy) {
        byId('recordStatus').textContent = 'Stop recording before editing a take.';
        return;
      }
      selectTake(take);
      if (location.hash === '#edit') route();
      else location.hash = 'edit';
    };
    const remove = document.createElement('button');
    remove.textContent = 'Delete';
    remove.onclick = async () => {
      if (!confirm('Delete take ' + take.number + '?')) return;
      try {
        if (database) await takeStorage('readwrite', (store) => store.delete(take.id));
        takes.splice(takes.indexOf(take), 1);
        URL.revokeObjectURL(takeUrls.get(take.id));
        takeUrls.delete(take.id);
        drafts.delete(take.id);
        if (selected === take) {
          selected = undefined;
          editRevision++;
          if (previewUrl) URL.revokeObjectURL(previewUrl);
          previewUrl = undefined;
          byId('preview').removeAttribute('src');
          byId('preview').load();
        }
        renderTakes();
      } catch { byId('recordStatus').textContent = 'Could not delete this take. Try again.'; }
    };
    actions.append(edit, remove);
    row.append(heading, player, actions);
    list.append(row);
  }
}

function drawWaveform() {
  const canvas = byId('wave');
  if (!waveSamples || !canvas.clientWidth) return;
  const width = canvas.width = Math.round(canvas.clientWidth * devicePixelRatio);
  const height = canvas.height = Math.round(canvas.clientHeight * devicePixelRatio);
  const pen = canvas.getContext('2d');
  pen.strokeStyle = '#394650';
  pen.beginPath();
  pen.moveTo(0, height / 2);
  pen.lineTo(width, height / 2);
  pen.stroke();
  pen.strokeStyle = '#a0dfba';
  pen.beginPath();
  for (let x = 0; x < width; x++) {
    const start = Math.floor(x * waveSamples.length / width);
    const end = Math.max(start + 1, Math.floor((x + 1) * waveSamples.length / width));
    let low = 0;
    let high = 0;
    for (let i = start; i < end; i++) {
      low = Math.min(low, waveSamples[i]);
      high = Math.max(high, waveSamples[i]);
    }
    pen.moveTo(x + 0.5, height * (0.5 - 0.47 * Math.min(1, high)));
    pen.lineTo(x + 0.5, height * (0.5 - 0.47 * Math.max(-1, low)));
  }
  pen.stroke();
}

function setPreview(samples, edited) {
  const player = byId('preview');
  player.pause();
  if (previewUrl) URL.revokeObjectURL(previewUrl);
  previewUrl = edited ? URL.createObjectURL(encodeWav(samples, selected.rate)) : undefined;
  player.src = previewUrl ?? takeUrl(selected);
  comparingEdits = edited;
  byId('original').setAttribute('aria-pressed', String(!edited));
  byId('edited').setAttribute('aria-pressed', String(edited));
  byId('duration').textContent = seconds(samples.length / selected.rate);
  waveSamples = samples;
  drawWaveform();
}

function chooseAdjustments(edit) {
  byId('start').value = edit.start;
  byId('end').value = edit.end;
  byId('gain').value = edit.gain;
  byId('gainValue').textContent = edit.gain + ' dB';
  byId('lowCut').checked = edit.lowCut;
  byId('compress').checked = edit.compress;
}

function defaultEdit() {
  return { start: 0, end: selected.samples.length / selected.rate, gain: 0, lowCut: false, compress: false };
}

function currentEdit() {
  return {
    start: byId('start').valueAsNumber,
    end: byId('end').valueAsNumber,
    gain: Number(byId('gain').value),
    lowCut: byId('lowCut').checked,
    compress: byId('compress').checked,
  };
}

function selectTake(take) {
  selected = take;
  editRevision++;
  byId('takeTitle').textContent = 'Take ' + take.number;
  byId('start').max = byId('end').max = take.samples.length / take.rate;
  chooseAdjustments(drafts.get(take.id) ?? defaultEdit());
  byId('editStatus').textContent = '';
  setPreview(take.samples, false);
}

async function renderEdit(exportFile) {
  const take = selected;
  const request = ++editRevision;
  byId('editStatus').textContent = '';
  try {
    const edit = currentEdit();
    if (!Number.isFinite(edit.start) || !Number.isFinite(edit.end) || edit.start < 0 ||
        edit.end > take.samples.length / take.rate || edit.start >= edit.end) {
      throw new Error('Choose playback bounds within the take, with the end after the start.');
    }
    const samples = await processTake(take, edit);
    if (request !== editRevision || selected !== take) return;
    let clipping = false;
    for (const value of samples) {
      if (Math.abs(value) > 1) { clipping = true; break; }
    }
    if (clipping) {
      byId('editStatus').textContent = 'Edits exceed 0 dBFS. Lower Gain before exporting to avoid clipping.';
      if (exportFile) return;
    }
    if (!exportFile) {
      setPreview(samples, true);
      await byId('preview').play();
      return;
    }
    const url = URL.createObjectURL(encodeWav(samples, take.rate));
    const download = document.createElement('a');
    download.href = url;
    download.download = 'vo-take-' + take.number + '-edited.wav';
    download.click();
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
    byId('editStatus').textContent = 'WAV download started.';
  } catch (error) {
    if (error.name !== 'AbortError' && request === editRevision) byId('editStatus').textContent = error.message;
  }
}

trackPlayer(byId('preview'));
byId('original').onclick = () => {
  editRevision++;
  setPreview(selected.samples, false);
  byId('editStatus').textContent = '';
  void byId('preview').play().catch(() => {});
};
byId('edited').onclick = () => void renderEdit(false);
byId('export').onclick = () => void renderEdit(true);
byId('reset').onclick = () => {
  editRevision++;
  drafts.delete(selected.id);
  chooseAdjustments(defaultEdit());
  setPreview(selected.samples, false);
  byId('editStatus').textContent = '';
};

for (const id of ['start', 'end', 'gain', 'lowCut', 'compress']) {
  byId(id).oninput = () => {
    editsChanged();
    byId('gainValue').textContent = byId('gain').value + ' dB';
  };
}

function editsChanged() {
  editRevision++;
  drafts.set(selected.id, currentEdit());
  byId('editStatus').textContent = '';
  if (comparingEdits) setPreview(selected.samples, false);
}

function route(focus = true) {
  if ((recording || busy) && location.hash === '#edit') {
    history.replaceState(null, '', '#record');
    byId('recordStatus').textContent = 'Stop recording before editing a take.';
  }
  const editing = location.hash === '#edit';
  activePlayer?.pause();
  byId('recordView').hidden = editing;
  byId('editView').hidden = !editing;
  byId('emptyEdit').hidden = Boolean(selected);
  byId('editPanel').hidden = !selected;
  byId('recordTab').setAttribute('aria-current', editing ? 'false' : 'page');
  byId('editTab').setAttribute('aria-current', editing ? 'page' : 'false');
  if (editing) drawWaveform();
  if (focus) byId(editing ? 'editTitle' : 'recordTitle').focus();
}

window.addEventListener('hashchange', () => route());
new ResizeObserver(drawWaveform).observe(byId('wave'));
window.addEventListener('pagehide', () => { if (!recording && !busy) { disableMic(); setControls(); } });

busy = true;
setControls();
renderTakes();
route(false);
try {
  database = await openStorage();
  const saved = await takeStorage('readonly', (store) => store.getAll());
  takes.push(...saved.sort((a, b) => b.createdAt - a.createdAt));
  renderTakes();
} catch {
  byId('recordStatus').textContent = 'Browser storage is unavailable. Export takes before closing this page.';
} finally {
  busy = false;
  setControls();
}
