/** Iterative radix-2 FFT, magnitudes only. Allocation-free after construction. */
export class Fft {
  private readonly size: number;
  private readonly rev: Uint32Array;
  private readonly cos: Float32Array;
  private readonly sin: Float32Array;
  private readonly re: Float32Array;
  private readonly im: Float32Array;

  constructor(size: number) {
    if ((size & (size - 1)) !== 0) throw new Error('FFT size must be a power of 2');
    this.size = size;
    const bits = Math.log2(size);
    this.rev = new Uint32Array(size);
    for (let i = 0; i < size; i++) {
      let r = 0;
      for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
      this.rev[i] = r;
    }
    this.cos = new Float32Array(size / 2);
    this.sin = new Float32Array(size / 2);
    for (let i = 0; i < size / 2; i++) {
      this.cos[i] = Math.cos((-2 * Math.PI * i) / size);
      this.sin[i] = Math.sin((-2 * Math.PI * i) / size);
    }
    this.re = new Float32Array(size);
    this.im = new Float32Array(size);
  }

  /** Writes size/2 magnitude bins into `out`. */
  magnitudes(input: Float32Array, out: Float32Array): void {
    const { size: n, re, im, rev, cos, sin } = this;
    for (let i = 0; i < n; i++) {
      re[i] = input[rev[i]];
      im[i] = 0;
    }
    for (let len = 2; len <= n; len <<= 1) {
      const half = len >> 1;
      const step = n / len;
      for (let i = 0; i < n; i += len) {
        for (let j = 0; j < half; j++) {
          const k = j * step;
          const a = i + j;
          const b = a + half;
          const tre = re[b] * cos[k] - im[b] * sin[k];
          const tim = re[b] * sin[k] + im[b] * cos[k];
          re[b] = re[a] - tre;
          im[b] = im[a] - tim;
          re[a] += tre;
          im[a] += tim;
        }
      }
    }
    const half = n >> 1;
    for (let i = 0; i < half; i++) out[i] = Math.hypot(re[i], im[i]);
  }
}
