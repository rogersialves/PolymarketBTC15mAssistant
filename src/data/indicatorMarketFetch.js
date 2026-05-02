import { fetchKlines, fetchLastPrice } from "./binance.js";
import { fetchOkxKlines } from "./okxKlines.js";
import { fetchOkxTicker } from "./exchanges.js";

/**
 * Loads 1m candles + spot for TA, plus Binance spot for oracle/Binance-vs-oracle,
 * with optional OKX candle source and automatic Binance fallback.
 *
 * @param {object} opts
 * @param {boolean} opts.useOkxCandles
 * @param {number|null} opts.binanceLivePrice
 * @param {() => Promise<any>} opts.chainlinkStep
 * @param {() => Promise<any>} opts.polymarketStep
 * @param {(name: string, fn: () => Promise<any>) => Promise<any>} opts.timedStep
 */
export async function fetchIndicatorMarketBundle(opts) {
  const {
    useOkxCandles,
    binanceLivePrice,
    chainlinkStep,
    polymarketStep,
    timedStep
  } = opts;

  const runBinance = async () => {
    const [candles1m, binanceSpot, chainlinkData, polymarketData] = await Promise.all([
      timedStep("binance.klines", () => fetchKlines({ interval: "1m", limit: 200 })),
      timedStep("binance.last_price", () =>
        binanceLivePrice !== null ? Promise.resolve(binanceLivePrice) : fetchLastPrice()),
      chainlinkStep,
      polymarketStep
    ]);
    return {
      candles1m,
      taLastPrice: binanceSpot,
      binanceSpot,
      chainlinkData,
      polymarketData,
      indicatorSourceEffective: "binance"
    };
  };

  if (!useOkxCandles) {
    return runBinance();
  }

  try {
    const [candles1m, okxLast, binanceSpot, chainlinkData, polymarketData] = await Promise.all([
      timedStep("okx.klines", () => fetchOkxKlines({ interval: "1m", limit: 200 })),
      timedStep("okx.last_price", () => fetchOkxTicker().then((t) => t.price)),
      timedStep("binance.last_price", () =>
        binanceLivePrice !== null ? Promise.resolve(binanceLivePrice) : fetchLastPrice()),
      chainlinkStep,
      polymarketStep
    ]);
    return {
      candles1m,
      taLastPrice: okxLast,
      binanceSpot,
      chainlinkData,
      polymarketData,
      indicatorSourceEffective: "okx"
    };
  } catch (err) {
    console.warn(`⚠️  Fonte OKX indisponível para velas/indicadores (${err?.message || err}); usando Binance.`);
    return { ...(await runBinance()), indicatorSourceEffective: "binance_fallback" };
  }
}
