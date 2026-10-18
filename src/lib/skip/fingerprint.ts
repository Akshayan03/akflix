/**
 * Chromaprint-style audio fingerprint for finding the same intro (or credits)
 * music in different episodes. It follows Chromaprint's design (12-band chroma
 * features, a 5-tap chroma filter, 16 Haar-like classifiers quantized to two
 * Gray-coded bits each, one 32-bit hash per step) but runs on 8 kHz mono PCM
 * so every platform can produce it: ffmpeg on the Mac and in the Roku bridge,
 * AVAssetReader on iPhone (which refuses rates below 8 kHz).
 *
 * The same algorithm lives in akflix-roku bridge/akflix_skip.py. Keep the two
 * in step: tests compare them on a shared synthetic signal.
 *
 * One hash every 0.125 s. Hash i describes frames i..i+19 (about 2.6 s of
 * audio starting at i * 0.125 s).
 */

export const FP_SAMPLE_RATE = 8000;
export const FP_FRAME = 2048;
export const FP_HOP = 1000;
export const FP_SECONDS_PER_HASH = FP_HOP / FP_SAMPLE_RATE;
/** Frames a hash depends on: 5 for the chroma filter, 16 for the widest classifier. */
export const FP_FRAMES_PER_HASH = 20;

const MIN_FREQ = 28;
const MAX_FREQ = 3520;
const CHROMA_FILTER = [0.25, 0.75, 1, 0.75, 0.25];
const QUIET_DB = -50;
const GRAY = [0, 1, 3, 2];

/** [filter type, chroma offset, chroma height, time width, t0, t1, t2] (Chromaprint's "test2" set). */
const CLASSIFIERS: ReadonlyArray<readonly [number, number, number, number, number, number, number]> = [
  [0, 4, 3, 15, 1.98215, 2.35817, 2.63523],
  [4, 4, 6, 15, -1.03809, -0.651211, -0.282167],
  [1, 0, 4, 16, -0.298702, 0.119262, 0.558497],
  [3, 8, 2, 12, -0.105439, 0.0153946, 0.135898],
  [3, 4, 4, 8, -0.142891, 0.0258736, 0.200632],
  [4, 0, 3, 5, -0.826319, -0.590612, -0.368214],
  [1, 2, 2, 9, -0.557409, -0.233035, 0.0534525],
  [2, 7, 3, 4, -0.0646826, 0.00620476, 0.0784847],
  [2, 6, 2, 16, -0.192387, -0.029699, 0.215855],
  [2, 1, 3, 2, -0.0397818, -0.00568076, 0.0292026],
  [5, 10, 1, 15, -0.53823, -0.369934, -0.190235],
  [3, 6, 2, 10, -0.124877, 0.0296483, 0.139239],
  [2, 1, 1, 14, -0.101475, 0.0225617, 0.231971],
  [3, 5, 6, 4, -0.0799915, -0.00729616, 0.063262],
  [1, 9, 2, 12, -0.272556, 0.019424, 0.302559],
  [3, 4, 2, 14, -0.164292, -0.0321188, 0.0846339],
];
const MAX_WIDTH = 16;

/** A fingerprint: hashes, which of them describe (mostly) silence, and the
 * media time of hash 0 in seconds. */
export interface AudioPrint {
  hashes: Uint32Array;
  quiet: Uint8Array;
  offset: number;
}

const WINDOW = (() => {
  const window = new Float64Array(FP_FRAME);
  for (let n = 0; n < FP_FRAME; n += 1) {
    window[n] = 0.54 - 0.46 * Math.cos((2 * Math.PI * n) / (FP_FRAME - 1));
  }
  return window;
})();

const BIT_REVERSE = (() => {
  const bits = Math.log2(FP_FRAME);
  const table = new Uint16Array(FP_FRAME);
  for (let i = 0; i < FP_FRAME; i += 1) {
    let reversed = 0;
    for (let b = 0; b < bits; b += 1) reversed |= ((i >> b) & 1) << (bits - 1 - b);
    table[i] = reversed;
  }
  return table;
})();

const TWIDDLE_RE = new Float64Array(FP_FRAME / 2);
const TWIDDLE_IM = new Float64Array(FP_FRAME / 2);
for (let k = 0; k < FP_FRAME / 2; k += 1) {
  TWIDDLE_RE[k] = Math.cos((-2 * Math.PI * k) / FP_FRAME);
  TWIDDLE_IM[k] = Math.sin((-2 * Math.PI * k) / FP_FRAME);
}

/** FFT bin -> chroma band (0..11), or -1 outside 28..3520 Hz. */
const BAND_OF_BIN = (() => {
  const bands = new Int8Array(FP_FRAME / 2 + 1).fill(-1);
  const first = Math.max(1, Math.round((FP_FRAME * MIN_FREQ) / FP_SAMPLE_RATE));
  const last = Math.min(FP_FRAME / 2, Math.round((FP_FRAME * MAX_FREQ) / FP_SAMPLE_RATE));
  for (let i = first; i < last; i += 1) {
    const freq = (i * FP_SAMPLE_RATE) / FP_FRAME;
    const octave = Math.log2(freq / (440 / 16));
    bands[i] = Math.min(11, Math.floor(12 * (octave - Math.floor(octave))));
  }
  return bands;
})();

const re = new Float64Array(FP_FRAME);
const im = new Float64Array(FP_FRAME);

/** Power spectrum of one windowed frame folded into 12 chroma bands. */
function chromaOfFrame(samples: Float64Array, start: number, out: Float64Array): number {
  let energy = 0;
  for (let n = 0; n < FP_FRAME; n += 1) {
    const value = samples[start + n];
    energy += value * value;
    const target = BIT_REVERSE[n];
    re[target] = value * WINDOW[n];
    im[target] = 0;
  }
  for (let size = 2; size <= FP_FRAME; size *= 2) {
    const half = size / 2;
    const step = FP_FRAME / size;
    for (let base = 0; base < FP_FRAME; base += size) {
      for (let j = 0, k = 0; j < half; j += 1, k += step) {
        const a = base + j;
        const b = a + half;
        const tr = re[b] * TWIDDLE_RE[k] - im[b] * TWIDDLE_IM[k];
        const ti = re[b] * TWIDDLE_IM[k] + im[b] * TWIDDLE_RE[k];
        re[b] = re[a] - tr;
        im[b] = im[a] - ti;
        re[a] += tr;
        im[a] += ti;
      }
    }
  }
  out.fill(0);
  for (let i = 0; i <= FP_FRAME / 2; i += 1) {
    const band = BAND_OF_BIN[i];
    if (band >= 0) out[band] += re[i] * re[i] + im[i] * im[i];
  }
  const rms = Math.sqrt(energy / FP_FRAME);
  return 20 * Math.log10(rms + 1e-12);
}

function subtractLog(a: number, b: number): number {
  return Math.log((1 + a) / (1 + b));
}

/**
 * Incremental fingerprinter: push PCM as it arrives (any chunk size), read the
 * hashes so far at any time. Hash i only depends on samples up to frame i+19,
 * so pushing more audio never changes earlier hashes.
 */
export class Fingerprinter {
  readonly offset: number;
  private samples = new Float64Array(FP_FRAME * 4);
  private sampleCount = 0;
  private consumed = 0;
  private total = 0;
  private chroma: Float64Array[] = [];
  private quietFrames: number[] = [];
  /** Integral image of the filtered, normalized chroma rows: (rows + 1) x 13. */
  private integral = new Float64Array(13 * 1024);
  private rows = 0;
  private hashList: number[] = [];
  private quietList: number[] = [];
  private frameChroma = new Float64Array(12);

  constructor(offsetSeconds = 0) {
    this.offset = offsetSeconds;
  }

  /** Int16 PCM (or floats in -1..1) at 8 kHz mono. */
  push(pcm: Int16Array | Float32Array | Float64Array): void {
    const scale = pcm instanceof Int16Array ? 1 / 32768 : 1;
    if (this.sampleCount + pcm.length > this.samples.length) {
      const grown = new Float64Array(Math.max(this.samples.length * 2, this.sampleCount + pcm.length));
      grown.set(this.samples.subarray(0, this.sampleCount));
      this.samples = grown;
    }
    for (let i = 0; i < pcm.length; i += 1) this.samples[this.sampleCount + i] = pcm[i] * scale;
    this.sampleCount += pcm.length;
    this.total += pcm.length;
    while (this.sampleCount - this.consumed >= FP_FRAME) {
      this.addFrame(this.consumed);
      this.consumed += FP_HOP;
    }
    // Drop samples no future frame needs.
    if (this.consumed > FP_FRAME * 8) {
      this.samples.copyWithin(0, this.consumed, this.sampleCount);
      this.sampleCount -= this.consumed;
      this.consumed = 0;
    }
  }

  private addFrame(start: number) {
    const db = chromaOfFrame(this.samples, start, this.frameChroma);
    this.chroma.push(Float64Array.from(this.frameChroma));
    this.quietFrames.push(db < QUIET_DB ? 1 : 0);
    const frames = this.chroma.length;
    if (frames < CHROMA_FILTER.length) return;
    // Filtered row from the last five frames, then Euclidean normalisation.
    const row = new Float64Array(12);
    for (let j = 0; j < CHROMA_FILTER.length; j += 1) {
      const source = this.chroma[frames - CHROMA_FILTER.length + j];
      for (let band = 0; band < 12; band += 1) row[band] += CHROMA_FILTER[j] * source[band];
    }
    let norm = 0;
    for (let band = 0; band < 12; band += 1) norm += row[band] * row[band];
    norm = Math.sqrt(norm);
    for (let band = 0; band < 12; band += 1) row[band] = norm > 1e-9 ? row[band] / norm : 0;
    this.addRow(row);
    // Only the last five frames are ever read again.
    if (this.chroma.length > 64) this.chroma.splice(0, this.chroma.length - CHROMA_FILTER.length);
  }

  private addRow(row: Float64Array) {
    const need = (this.rows + 2) * 13;
    if (need > this.integral.length) {
      const grown = new Float64Array(this.integral.length * 2);
      grown.set(this.integral);
      this.integral = grown;
    }
    const previous = this.rows * 13;
    const next = previous + 13;
    let running = 0;
    this.integral[next] = 0;
    for (let band = 0; band < 12; band += 1) {
      running += row[band];
      this.integral[next + band + 1] = this.integral[previous + band + 1] + running;
    }
    this.rows += 1;
    if (this.rows >= MAX_WIDTH) this.addHash(this.rows - MAX_WIDTH);
  }

  private area(r1: number, c1: number, r2: number, c2: number): number {
    const ii = this.integral;
    return ii[r2 * 13 + c2] - ii[r1 * 13 + c2] - ii[r2 * 13 + c1] + ii[r1 * 13 + c1];
  }

  private addHash(x: number) {
    let bits = 0;
    for (const [type, y, h, w, t0, t1, t2] of CLASSIFIERS) {
      let value: number;
      if (type === 0) {
        value = subtractLog(this.area(x, y, x + w, y + h), 0);
      } else if (type === 1) {
        const h2 = Math.floor(h / 2);
        value = subtractLog(this.area(x, y + h2, x + w, y + h), this.area(x, y, x + w, y + h2));
      } else if (type === 2) {
        const w2 = Math.floor(w / 2);
        value = subtractLog(this.area(x + w2, y, x + w, y + h), this.area(x, y, x + w2, y + h));
      } else if (type === 3) {
        const w2 = Math.floor(w / 2);
        const h2 = Math.floor(h / 2);
        value = subtractLog(
          this.area(x, y, x + w2, y + h2) + this.area(x + w2, y + h2, x + w, y + h),
          this.area(x + w2, y, x + w, y + h2) + this.area(x, y + h2, x + w2, y + h)
        );
      } else if (type === 4) {
        const h3 = Math.floor(h / 3);
        value = subtractLog(
          this.area(x, y + h3, x + w, y + 2 * h3),
          this.area(x, y, x + w, y + h3) + this.area(x, y + 2 * h3, x + w, y + h)
        );
      } else {
        const w3 = Math.floor(w / 3);
        value = subtractLog(
          this.area(x + w3, y, x + 2 * w3, y + h),
          this.area(x, y, x + w3, y + h) + this.area(x + 2 * w3, y, x + w, y + h)
        );
      }
      const q = value < t1 ? (value < t0 ? 0 : 1) : value < t2 ? 2 : 3;
      bits = ((bits << 2) | GRAY[q]) >>> 0;
    }
    this.hashList.push(bits);
    // Hash x covers frames x..x+19: quiet when most of them are.
    let quiet = 0;
    for (let f = x; f < x + FP_FRAMES_PER_HASH && f < this.quietFrames.length; f += 1) quiet += this.quietFrames[f];
    this.quietList.push(quiet * 2 >= FP_FRAMES_PER_HASH ? 1 : 0);
  }

  /** Seconds of audio pushed so far (from `offset`). */
  get seconds(): number {
    return this.total / FP_SAMPLE_RATE;
  }

  get length(): number {
    return this.hashList.length;
  }

  print(): AudioPrint {
    return {
      hashes: Uint32Array.from(this.hashList),
      quiet: Uint8Array.from(this.quietList),
      offset: this.offset,
    };
  }
}

/** One-shot fingerprint of a whole PCM buffer. */
export function fingerprintPcm(pcm: Int16Array | Float32Array | Float64Array, offsetSeconds = 0): AudioPrint {
  const fingerprinter = new Fingerprinter(offsetSeconds);
  fingerprinter.push(pcm);
  return fingerprinter.print();
}

/** Media time (seconds) at which hash `index` starts. */
export function hashTime(print: AudioPrint, index: number): number {
  return print.offset + index * FP_SECONDS_PER_HASH;
}

export function slicePrint(print: AudioPrint, start: number, end: number): AudioPrint {
  return {
    hashes: print.hashes.slice(start, end),
    quiet: print.quiet.slice(start, end),
    offset: hashTime(print, start),
  };
}

/** Number of differing bits between two hashes. */
export function bitDifference(a: number, b: number): number {
  let v = (a ^ b) >>> 0;
  v -= (v >>> 1) & 0x55555555;
  v = (v & 0x33333333) + ((v >>> 2) & 0x33333333);
  return (((v + (v >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
}
