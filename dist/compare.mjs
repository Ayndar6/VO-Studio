import { analyzeTake, summarizeTakes } from './compare-analysis.mjs';

const template = document.querySelector('#take-template');
const match = document.querySelector('#match');
const playBoth = document.querySelector('#play-both');
const align = document.querySelector('#align');
const split = document.querySelector('#split');
const pairStatus = document.querySelector('#pair-status');
const measurements = document.querySelector('#measurements');
const body = measurements.querySelector('tbody');
const summaryPanel = document.querySelector('#summary');
const clock = (time) => time.toFixed(2) + ' s';
const level = (value) => value === null ? '—' : value === -Infinity ? '−∞ dBFS' : value.toFixed(1) + ' dBFS';
let audioContext;
let pair;

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
  playBoth.disabled = !ready;
  split.disabled = !ready;
  align.disabled = !ready || slots.some((slot) => slot.analysis.speechStart === null);
  for (const slot of slots) slot.play.disabled = !slot.analysis;
  updatePlaybackLevels();
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

  summaryPanel.hidden = !ready;
  if (ready) {
    const summary = summarizeTakes(slots[0].analysis, slots[1].analysis);
    document.querySelector('#summary-text').textContent = summary.text;
    document.querySelector('#summary-tip').textContent = summary.tip;
  }
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
  stopPair();
  pairStatus.textContent = '';
  const attempt = ++slot.attempt;
  slot.buffer = null;
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
    slot.buffer = buffer;
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

function playbackGain(index) {
  if (!match.checked || match.disabled) return 1;
  const difference = slots[1 - index].analysis.speechLevel - slots[index].analysis.speechLevel;
  return 10 ** (Math.min(0, difference) / 20);
}

function updatePlaybackLevels() {
  slots.forEach((slot, index) => {
    const gain = playbackGain(index);
    if (slot.gain) slot.gain.gain.value = gain;
    const track = pair?.tracks[index];
    if (track) {
      // Leave headroom when the two takes are mixed together.
      track.gain.gain.value = gain * (split.checked ? 1 : 0.5);
      track.pan.pan.value = split.checked ? index * 2 - 1 : 0;
    }
  });
}

function stopPair() {
  if (!pair) return;
  const previous = pair;
  pair = undefined;
  for (const { source, gain, pan } of previous.tracks) {
    source.onended = null;
    try { source.stop(); } catch (error) {
      if (error.name !== 'InvalidStateError') throw error;
    }
    source.disconnect();
    gain.disconnect();
    pan.disconnect();
  }
  playBoth.textContent = 'Play both';
}

playBoth.onclick = async () => {
  if (pair) {
    stopPair();
    pairStatus.textContent = '';
    return;
  }
  const session = { tracks: [] };
  pair = session;
  pairStatus.textContent = '';
  playBoth.textContent = 'Stop both';
  try {
    if (!audioContext) audioContext = new AudioContext();
    for (const slot of slots) slot.audio.pause();
    await audioContext.resume();
    if (pair !== session) return;

    const start = audioContext.currentTime + 0.05;
    let remaining = slots.length;
    for (const slot of slots) {
      const source = audioContext.createBufferSource();
      const gain = audioContext.createGain();
      const pan = audioContext.createStereoPanner();
      // Each take is one voice channel in the combined playback.
      pan.channelCount = 1;
      pan.channelCountMode = 'explicit';
      source.buffer = slot.buffer;
      source.connect(gain).connect(pan).connect(audioContext.destination);
      session.tracks.push({ source, gain, pan });
      source.onended = () => {
        if (--remaining === 0 && pair === session) stopPair();
      };
      source.start(start, align.checked && !align.disabled ? slot.analysis.speechStart : 0);
    }
    updatePlaybackLevels();
  } catch {
    if (pair === session) {
      stopPair();
      pairStatus.textContent = 'Could not start both takes. Try Play both again.';
    }
  }
};

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
    stopPair();
    try {
      const resume = connectPlayback(slot);
      const play = slot.audio.play();
      await Promise.all([resume, play]);
    } catch { slot.status.textContent = 'Playback could not start. Try pressing play again.'; }
  };
  slot.audio.onplay = () => {
    stopPair();
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
match.onchange = updatePlaybackLevels;
split.onchange = updatePlaybackLevels;
