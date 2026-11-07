// マイクの音を少しずつ溜めて画面側へ渡す。
// 開始位置(currentFrame)も一緒に送り、メトロノームの拍と録音の位置を正確に対応させるため。
const CHUNK_SIZE = 4096;

class RecorderProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffer = new Float32Array(CHUNK_SIZE);
    this.filled = 0;
    this.chunkStart = 0;
  }

  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (!channel) return true;
    if (this.filled === 0) this.chunkStart = currentFrame;
    this.buffer.set(channel, this.filled);
    this.filled += channel.length;
    if (this.filled + channel.length > CHUNK_SIZE) {
      this.port.postMessage({ frame: this.chunkStart, samples: this.buffer.slice(0, this.filled) });
      this.filled = 0;
    }
    return true;
  }
}

registerProcessor('recorder-processor', RecorderProcessor);
