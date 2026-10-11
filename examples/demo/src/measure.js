export function distribution(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const percentile = (p) =>
    sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)];
  return {
    count: sorted.length,
    mean: sorted.reduce((a, b) => a + b, 0) / sorted.length,
    p50: percentile(0.5),
    p95: percentile(0.95),
    p99: percentile(0.99),
    max: sorted.at(-1),
  };
}

/** Optional asynchronous GPU timing. Disjoint measurements are discarded. */
export class GpuTimer {
  constructor(renderer) {
    this.gl = renderer.getContext();
    this.ext = this.gl.getExtension("EXT_disjoint_timer_query_webgl2");
    this.pending = [];
    this.values = [];
    this.current = null;
  }
  begin() {
    if (!this.ext || this.pending.length >= 8) return;
    this.current = this.gl.createQuery();
    this.gl.beginQuery(this.ext.TIME_ELAPSED_EXT, this.current);
  }
  end() {
    if (!this.current) return;
    this.gl.endQuery(this.ext.TIME_ELAPSED_EXT);
    this.pending.push(this.current);
    this.current = null;
  }
  poll() {
    if (!this.ext) return;
    const gl = this.gl;
    if (gl.getParameter(this.ext.GPU_DISJOINT_EXT)) {
      this.clear();
      return;
    }
    while (
      this.pending.length &&
      gl.getQueryParameter(this.pending[0], gl.QUERY_RESULT_AVAILABLE)
    ) {
      const query = this.pending.shift();
      this.values.push(gl.getQueryParameter(query, gl.QUERY_RESULT) / 1e6);
      if (this.values.length > 120) this.values.shift();
      gl.deleteQuery(query);
    }
  }
  clear() {
    for (const query of this.pending) this.gl.deleteQuery(query);
    this.pending = [];
    this.values = [];
  }
  dispose() {
    this.clear();
  }
}
