// Plain-code estimates shared by the server and the browser.
// JEV is for fuzzy judgments; capacity and bandwidth are arithmetic.

export const PURPOSES = {
  chat: { label: "チャット(会話)", minTps: 10 },
  coding: { label: "コーディング支援", minTps: 20 },
  vision: { label: "画像の理解", minTps: 5 },
  longdoc: { label: "長文の要約・検索", minTps: 5 },
};

const OVERHEAD_GB = 1.5; // KV cache and runtime, rough
const EFFICIENCY = 0.5; // real speed is roughly half the bandwidth limit

export const q4SizeGb = (paramsB) => Math.round(paramsB * 0.6 * 10) / 10;

// Best memory pool of a device that can hold the model (4-bit), with a speed estimate.
export function evalDevice(paramsB, device, purpose) {
  if (paramsB == null) return { known: false };
  const size = q4SizeGb(paramsB);
  const need = size + OVERHEAD_GB;
  const fitting = device.pools
    .filter((p) => need <= p.gb * p.ratio)
    .sort((a, b) => b.bw - a.bw);
  if (!fitting.length) return { known: true, fits: false, size, need: Math.round(need * 10) / 10 };
  const pool = fitting[0];
  const tps = Math.round((pool.bw / size) * EFFICIENCY * 10) / 10;
  const minTps = PURPOSES[purpose]?.minTps ?? 0;
  return { known: true, fits: true, size, need: Math.round(need * 10) / 10, pool: pool.name, tps, minTps, fastEnough: tps >= minTps };
}

// Device that fits and is fastest, or null.
export function bestDevice(paramsB, devices, purpose) {
  let best = null;
  for (const d of devices) {
    const e = evalDevice(paramsB, d, purpose);
    if (e.known && e.fits && e.fastEnough && (!best || e.tps > best.tps)) best = { id: d.id, tps: e.tps };
  }
  return best;
}
