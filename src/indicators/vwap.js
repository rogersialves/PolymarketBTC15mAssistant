export function computeSessionVwap(candles) {
  if (!Array.isArray(candles) || candles.length === 0) return null;

  let pv = 0;
  let v = 0;
  for (const c of candles) {
    const tp = (c.high + c.low + c.close) / 3;
    pv += tp * c.volume;
    v += c.volume;
  }
  if (v === 0) return null;
  return pv / v;
}

export function computeVwapSeries(candles) {
  const series = [];
  let pvAcc = 0;
  let vAcc = 0;
  for (const c of candles) {
    pvAcc += ((c.high + c.low + c.close) / 3) * c.volume;
    vAcc += c.volume;
    series.push(vAcc > 0 ? pvAcc / vAcc : null);
  }
  return series;
}
