class Capture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.chunk = new Float32Array(4096);
    this.offset = 0;
    this.peak = 0;
    this.recording = false;
    this.port.onmessage = ({ data }) => {
      if (data === 'start') {
        this.offset = 0;
        this.peak = 0;
        this.recording = true;
      } else if (data === 'stop') {
        this.recording = false;
        this.flush();
        this.port.postMessage({ stopped: true });
      }
    };
  }

  flush() {
    if (!this.offset) return;
    const samples = this.chunk.slice(0, this.offset);
    this.port.postMessage({ samples }, [samples.buffer]);
    this.offset = 0;
  }

  process([channels]) {
    const input = channels[0];
    if (!input) return true;
    for (const value of input) {
      this.peak = Math.max(this.peak, Math.abs(value));
      if (this.recording) {
        this.chunk[this.offset++] = value;
        if (this.offset === this.chunk.length) this.flush();
      }
    }
    if (currentFrame % 2048 === 0) {
      this.port.postMessage({ peak: this.peak });
      this.peak = 0;
    }
    return true;
  }
}
registerProcessor('vo-capture', Capture);
