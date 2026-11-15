import { analyzeTake } from './compare-analysis.mjs';

const template = document.querySelector('#take-template');
const match = document.querySelector('#match');
const measurements = document.querySelector('#measurements');
const body = measurements.querySelector('tbody');
const clock = (time) => time.toFixed(2) + ' s';
const level = (value) => value === null ? '—' : value === -Infinity ? '−∞ dBFS' : value.toFixed(1) + ' dBFS';
let audioContext;

const slots = ['A', 'B'].map((name) => {
  const panel = template.content.firstElementChild.cloneNode(true);
  panel.querySelector('h2').textContent = 'Take ' + name;
  const slot = {
    name, panel,
    picker: panel.querySelector('.picker'),
    input: panel.querySelector('input'),
    audio: panel.querySelector('audio'),
    canvas: panel.querySelector('canvas'),
    status: panel.querySelector('.status'),
    play: document.querySelector('#play-' + name.toLowerCase()),
    attempt: 0,
  };
  slot.audio.setAttribute('aria-label', 'Take ' + name + ' playback');
  document.querySelector('#takes').append(panel);
  return slot;
});

function updateComparison() {
  const ready = slots.every((slot) => slot.analysis);
  measurements.hidden = !slots.some((slot) => slot.analysis);
  match.disabled = !ready || slots.some((slot) => slot.analysis.speechLevel === null);
  for (const slot of slots) {
    slot.play.disabled = !slot.analysis;
    if (!slot.gain) continue;
    const other = slots.find((candidate) => candidate !== slot);
    const difference = match.checked && !match.disabled
      ? Math.min(0, other.analysis.speechLevel - slot.analysis.speechLevel)
      : 0;
    slot.gain.gain.value = 10 ** (difference / 20);
  }
  const rows = [
    ['Total duration', (a) => clock(a.duration)],
    ['Estimated speech span', (a) => a.speechSpan === null ? '—' : clock(a.speechSpan)],
    ['Peak', (a) => level(a.peak)],
    ['Average level (RMS)', (a) => level(a.rms)],
    ['Quiet sections (estimated RMS)', (a) => level(a.quietLevel)],
    ['Possible clipping', (a) => a.nearFullScale ? 'Near full scale' : 'None detected'],
  ];
  body.replaceChildren();
  for (const [label, format] of rows) {
    const row = body.insertRow();
    const header = document.createElement('th');
    header.scope = 'row';
    header.textContent = label;
    row.append(header);
    for (const slot of slots) row.insertCell().textContent = slot.analysis ? format(slot.analysis) : '—';
  }

  const [a, b] = slots.map((slot) => slot.analysis?.speechSpan);
  const delta = a && b ? b - a : null;
  document.querySelector('#timing').textContent = delta === null ? ''
    : Math.abs(delta) < 0.01 ? 'Both takes have about the same estimated speech span.'
    : 'Take B’s estimated speech span is ' + clock(Math.abs(delta)) + (delta > 0 ? ' longer.' : ' shorter.');
}

function draw(slot) {
  const { canvas, analysis, audio } = slot;
  if (!analysis || !canvas.clientWidth) return;
  const width = canvas.width = Math.round(canvas.clientWidth * devicePixelRatio);
  const height = canvas.height = Math.round(canvas.clientHeight * devicePixelRatio);
  const pen = canvas.getContext('2d');
  pen.fillStyle = '#293941';
  for (const pause of analysis.pauses) {
    pen.fillRect(width * pause.start / analysis.duration, 0, width * pause.span / analysis.duration, height);
  }
  pen.fillStyle = '#41515b';
  pen.fillRect(0, height / 2, width, 1);
  pen.strokeStyle = '#abebc6';
  pen.beginPath();
  analysis.envelope.forEach(([min, max], i) => {
    const x = width * (i + 0.5) / analysis.envelope.length;
    pen.moveTo(x, height * (0.5 - 0.45 * Math.min(1, max)));
    pen.lineTo(x, height * (0.5 - 0.45 * Math.max(-1, min)));
  });
  pen.stroke();
  pen.fillStyle = '#f5dfad';
  pen.fillRect(width * audio.currentTime / analysis.duration, 0, 2, height);
}

function seek(slot, time) {
  if (Number.isFinite(slot.audio.duration)) slot.audio.currentTime = Math.min(time, slot.audio.duration);
}

function showPauses(slot) {
  const list = slot.panel.querySelector('.pauses');
  list.replaceChildren();
  for (const { start, span } of slot.analysis.pauses) {
    const button = document.createElement('button');
    button.textContent = clock(start) + ' · ' + clock(span) + ' pause';
    button.onclick = () => seek(slot, start);
    list.append(button);
  }
  if (!slot.analysis.pauses.length) list.textContent = 'No internal pauses of 0.30 s or longer detected.';
}

async function load(slot, file) {
  if (!file) return;
  const attempt = ++slot.attempt;
  slot.analysis = null;
  slot.audio.pause();
  slot.audio.removeAttribute('src');
  slot.audio.load();
  if (slot.url) URL.revokeObjectURL(slot.url);
  slot.url = undefined;
  const result = slot.panel.querySelector('.result');
  result.hidden = true;
  slot.status.textContent = 'Reading ' + file.name + '…';
  updateComparison();

  try {
    if (!/\.wave?$/i.test(file.name)) throw new Error('Choose a WAV file.');
    const data = await file.arrayBuffer();
    if (attempt !== slot.attempt) return;
    // Decode at the source sample rate for meaningful peak measurements.
    const header = new DataView(data);
    let sampleRate;
    if (data.byteLength >= 12 && header.getUint32(0) === 0x52494646 && header.getUint32(8) === 0x57415645) {
      for (let offset = 12; offset + 8 <= data.byteLength;) {
        const size = header.getUint32(offset + 4, true);
        if (header.getUint32(offset) === 0x666d7420 && size >= 16 && offset + 24 <= data.byteLength) {
          sampleRate = header.getUint32(offset + 12, true);
          break;
        }
        offset += 8 + size + (size % 2);
      }
    }
    if (!sampleRate) throw new Error('This file does not have a readable WAV header.');
    const decoder = new OfflineAudioContext(1, 1, sampleRate);
    const buffer = await decoder.decodeAudioData(data);
    if (attempt !== slot.attempt) return;
    slot.analysis = analyzeTake(buffer);
    slot.url = URL.createObjectURL(file);
    slot.audio.src = slot.url;
    slot.status.textContent = file.name;
    result.hidden = false;
    showPauses(slot);
    draw(slot);
    updateComparison();
  } catch (error) {
    if (attempt === slot.attempt) slot.status.textContent = error.message || 'Could not read this WAV.';
  }
}

function connectPlayback(slot) {
  if (!audioContext) audioContext = new AudioContext();
  if (!slot.gain) {
    slot.gain = audioContext.createGain();
    audioContext.createMediaElementSource(slot.audio).connect(slot.gain).connect(audioContext.destination);
    updateComparison();
  }
  return audioContext.resume();
}

for (const slot of slots) {
  slot.input.onchange = () => {
    void load(slot, slot.input.files[0]);
    slot.input.value = '';
  };
  slot.picker.ondragover = (event) => {
    event.preventDefault();
    slot.picker.classList.add('over');
  };
  slot.picker.ondragleave = () => slot.picker.classList.remove('over');
  slot.picker.ondrop = (event) => {
    event.preventDefault();
    slot.picker.classList.remove('over');
    void load(slot, event.dataTransfer.files[0]);
  };
  slot.play.onclick = async () => {
    try {
      const resume = connectPlayback(slot);
      const play = slot.audio.play();
      await Promise.all([resume, play]);
    } catch { slot.status.textContent = 'Playback could not start. Try pressing play again.'; }
  };
  slot.audio.onplay = () => {
    for (const other of slots) if (other !== slot) other.audio.pause();
    void connectPlayback(slot).catch(() => {});
  };
  slot.audio.ontimeupdate = () => draw(slot);
  slot.canvas.onclick = (event) => {
    const bounds = slot.canvas.getBoundingClientRect();
    seek(slot, (event.clientX - bounds.left) / bounds.width * slot.analysis.duration);
  };
  new ResizeObserver(() => draw(slot)).observe(slot.canvas);
}
match.onchange = updateComparison;
