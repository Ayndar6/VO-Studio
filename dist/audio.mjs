export function encodeWav(samples, rate) {
  const bytes = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(bytes);
  const label = (offset, value) => {
    for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i));
  };
  label(0, 'RIFF');
  view.setUint32(4, bytes.byteLength - 8, true);
  label(8, 'WAVE');
  label(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  label(36, 'data');
  view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const sample = Math.min(1, Math.max(-1, samples[i]));
    view.setInt16(44 + i * 2, Math.round(sample * (sample < 0 ? 32768 : 32767)), true);
  }
  return new Blob([bytes], { type: 'audio/wav' });
}

export async function processTake(take, edit) {
  const start = Math.round(edit.start * take.rate);
  const end = Math.round(edit.end * take.rate);
  if (start < 0 || end > take.samples.length || end <= start) {
    throw new Error('Choose playback bounds within the take, with the end after the start.');
  }
  const context = new OfflineAudioContext(1, end - start, take.rate);
  const source = context.createBufferSource();
  source.buffer = context.createBuffer(1, end - start, take.rate);
  source.buffer.copyToChannel(take.samples.subarray(start, end), 0);
  let tail = source;
  if (edit.lowCut) {
    const filter = context.createBiquadFilter();
    filter.type = 'highpass';
    filter.frequency.value = 80;
    filter.Q.value = Math.SQRT1_2;
    tail.connect(filter);
    tail = filter;
  }
  if (edit.compress) {
    const compressor = context.createDynamicsCompressor();
    compressor.threshold.value = -18;
    compressor.knee.value = 12;
    compressor.ratio.value = 2.5;
    compressor.attack.value = 0.003;
    compressor.release.value = 0.18;
    tail.connect(compressor);
    tail = compressor;
  }
  const gain = context.createGain();
  gain.gain.value = 10 ** (edit.gain / 20);
  tail.connect(gain);
  gain.connect(context.destination);
  source.start();
  return (await context.startRendering()).getChannelData(0);
}
