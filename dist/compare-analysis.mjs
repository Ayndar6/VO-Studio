const db = (amplitude) => amplitude > 0 ? 20 * Math.log10(amplitude) : -Infinity;

export function analyzeTake(buffer) {
  const channels = Array.from({ length: buffer.numberOfChannels }, (_, i) => buffer.getChannelData(i));
  const { length, sampleRate, duration } = buffer;
  const windowSize = Math.round(sampleRate * 0.02);
  const levels = [];
  const envelope = Array.from({ length: 640 }, () => [0, 0]);
  let totalEnergy = 0;
  let peak = 0;
  let nearFullScale = 0;
  let windowEnergy = 0;

  for (let i = 0; i < length; i++) {
    const bounds = envelope[Math.floor(i * envelope.length / length)];
    for (const channel of channels) {
      const value = channel[i];
      const magnitude = Math.abs(value);
      peak = Math.max(peak, magnitude);
      nearFullScale += Number(magnitude >= 0.999);
      bounds[0] = Math.min(bounds[0], value);
      bounds[1] = Math.max(bounds[1], value);
      windowEnergy += value * value;
    }
    if ((i + 1) % windowSize === 0 || i + 1 === length) {
      const frames = (i % windowSize) + 1;
      levels.push(windowEnergy / (frames * channels.length));
      totalEnergy += windowEnergy;
      windowEnergy = 0;
    }
  }

  const sorted = [...levels].sort((a, b) => a - b);
  const low = sorted[Math.floor(sorted.length * 0.2)] ?? 0;
  const high = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] ?? 0;
  // Use a relative energy threshold, ignoring very brief spikes as speech.
  const threshold = Math.max(1e-7, high * 0.01, Math.min(low * 3, high * 0.25));
  const secondsAt = (index) => Math.min(duration, index * windowSize / sampleRate);
  const regions = [];
  let onset = 0;
  let speechEnergy = 0;
  let speechWindows = 0;
  for (let i = 0; i <= levels.length; i++) {
    if (levels[i] > threshold) continue;
    if (i - onset >= 3) {
      regions.push({ start: secondsAt(onset), end: secondsAt(i) });
      for (let j = onset; j < i; j++) speechEnergy += levels[j];
      speechWindows += i - onset;
    }
    onset = i + 1;
  }

  const pauses = [];
  for (let i = 1; i < regions.length; i++) {
    const start = regions[i - 1].end;
    const span = regions[i].start - start;
    if (span >= 0.299) pauses.push({ start, span });
  }
  const quiet = levels.filter((level) => level <= threshold);
  const quietLevel = quiet.length >= 15 && regions.length
    ? db(Math.sqrt(quiet.reduce((sum, level) => sum + level, 0) / quiet.length))
    : null;

  return {
    duration, envelope, pauses, nearFullScale,
    peak: db(peak),
    rms: db(Math.sqrt(totalEnergy / (length * channels.length))),
    speechLevel: speechWindows ? db(Math.sqrt(speechEnergy / speechWindows)) : null,
    speechSpan: regions.length ? regions.at(-1).end - regions[0].start : null,
    quietLevel,
  };
}
