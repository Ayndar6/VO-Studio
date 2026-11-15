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
    speechStart: regions[0]?.start ?? null,
    speechSpan: regions.length ? regions.at(-1).end - regions[0].start : null,
    quietLevel,
  };
}

export function summarizeTakes(a, b) {
  const durationDelta = b.duration - a.duration;
  const hasSpeechSpans = a.speechSpan !== null && b.speechSpan !== null;
  const speechDelta = hasSpeechSpans ? b.speechSpan - a.speechSpan : null;
  const compareTime = (delta, label) => {
    if (Math.abs(delta) < 0.01) return 'Both takes have about the same ' + label + '.';
    return 'Take B’s ' + label + ' is ' + Math.abs(delta).toFixed(2) +
      ' seconds ' + (delta > 0 ? 'longer.' : 'shorter.');
  };

  const sentences = [compareTime(durationDelta, 'total duration')];
  if (hasSpeechSpans) {
    sentences.push(compareTime(speechDelta, 'estimated speech span'));
    const outsideDelta = durationDelta - speechDelta;
    if (Math.abs(outsideDelta) >= 0.05) {
      sentences.push('Take B has about ' + Math.abs(outsideDelta).toFixed(2) +
        ' seconds ' + (outsideDelta > 0 ? 'more' : 'less') + ' audio outside the detected speech.');
    }
  } else {
    sentences.push('There wasn’t enough detected speech in both takes to compare pacing.');
  }

  if (Number.isFinite(a.rms) && Number.isFinite(b.rms)) {
    const delta = b.rms - a.rms;
    sentences.push(Math.abs(delta) < 0.1
      ? 'The average levels are about the same.'
      : 'Take B is ' + Math.abs(delta).toFixed(1) + ' dB ' +
        (delta > 0 ? 'louder' : 'quieter') + ' on average.');
  } else if (a.rms === -Infinity || b.rms === -Infinity) {
    const silent = a.rms === b.rms ? 'Both takes contain' : (a.rms === -Infinity ? 'Take A contains' : 'Take B contains');
    sentences.push(silent + ' digital silence throughout.');
  }

  const clipping = [a.nearFullScale, b.nearFullScale];
  if (clipping.some(Boolean)) {
    const subject = clipping.every(Boolean) ? 'Both takes show' : (clipping[0] ? 'Take A shows' : 'Take B shows');
    sentences.push(subject + ' possible clipping.');
  } else {
    sentences.push('Neither take showed possible clipping.');
  }

  const pauses = [a.pauses.length, b.pauses.length];
  if (!pauses.some(Boolean)) {
    if (hasSpeechSpans) sentences.push('No internal pauses of 0.30 seconds or longer were detected.');
  } else {
    const count = (total) => total + ' detected pause' + (total === 1 ? '' : 's');
    sentences.push('Take A had ' + count(pauses[0]) + ' and Take B had ' + count(pauses[1]) + '.');
  }

  const tip = clipping.some(Boolean)
    ? 'Listen for harsh or crackly peaks in the flagged take.'
    : pauses[0] !== pauses[1]
      ? 'Jump to the highlighted pauses and listen to how the pauses affect the delivery.'
      : hasSpeechSpans
        ? 'Turn on Match playback levels and switch between A and B. Listen for differences in pace and emphasis.'
        : 'Play each take and check that the voice is audible throughout the read.';

  return { text: sentences.join(' '), tip };
}
