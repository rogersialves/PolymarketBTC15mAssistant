# Phase 02 - Scalp Engine And Persistence

## Context Links

- [Spec](../../docs/superpowers/specs/2026-04-23-scalp-force-design.md)
- `C:\GitHub\PolymarketBTC15mAssistant\src\server.js`
- `C:\GitHub\PolymarketBTC15mAssistant\src\utils.js`
- `C:\GitHub\PolymarketBTC15mAssistant\src\engines` (existing engine helpers)

## Overview

- Date: 2026-04-23
- Priority: high
- Status: planned
- Goal: add an isolated scalp runtime for 5m and 15m, with tick-based entry/exit and dedicated CSV persistence.

## Key Insights

- Current `simPositions` model assumes entry now, resolution later.
- Current CSV analysis depends on `outcome`, `won`, `pnl_usd` at market close.
- Scalp logic needs open-position state inside the candle and exits on live contract prices.
- Existing data already covers what the strategy needs:
  - `priceToBeat`
  - `currentPrice`
  - exchange prices
  - contract prices
  - `Heiken+OBV`
  - `5+ Agree`
  - `Delta 3m`

## Requirements

- Do not mix scalp positions into `simPositions`.
- Do not append scalp rows into `sim_trades_5m.csv` or `sim_trades_15m.csv`.
- Evaluate entry only inside a configurable open window.
- Calculate effective stake explicitly with `minSharesFloor`.
- Exit on TP or timeout only.
- Expose scalp runtime state in the dashboard tick payload.
- Keep scalp indicators simulation-only in MVP even when global mode is LIVE.

## Architecture

Create `C:\GitHub\PolymarketBTC15mAssistant\src\engines\scalpForce.js`.

Module responsibilities:

- `createScalpRuntime(indicatorName, timeframeMinutes, config)`
- `evaluateScalpArm(context)`
- `evaluateScalpEntry(context)`
- `evaluateScalpExit(context)`
- `buildScalpCardPayload(runtime)`
- `buildScalpSummary(runtime, closedTrades)`

Suggested per-timeframe state:

```js
const scalpState = {
  "Scalp Force 5m": createScalpRuntime(...),
  "Scalp Force 15m": createScalpRuntime(...)
};
```

Suggested runtime fields:

```js
{
  status, armedAt, entryAt, exitAt,
  direction, entryPrice, exitPrice,
  targetPrice, minExitThreshold, deadlineAt,
  stakeUsd, effectiveStakeUsd, shares,
  priceToBeat, currentPriceAtEntry, exchangeMedianAtEntry,
  latestReason, lastClosedTrade
}
```

Entry logic:

```js
direction = resolveDirection({
  priceToBeat,
  currentPrice,
  exchangeMedian
});

strengthOk =
  HeikenObv == direction &&
  FivePlus == direction &&
  (tf == 15 ? Delta3m == direction : true);

contractPrice = direction == "UP" ? marketPriceUp : marketPriceDown;
inBand = contractPricePct >= entryMinPct && contractPricePct <= entryMaxPct;
withinWindow = candleTiming.elapsedMs <= entryOpenWindowSec * 1000;
effectiveStakeUsd = max(baseStakeUsd, contractPrice * minSharesFloor);
```

Exit logic:

- `tp_hit` when contract price percentage reaches `takeProfitPct`.
- `timeout_min_exit` when deadline passes and current percentage is `>= minExitPct`.
- `timeout_force_exit` when deadline passes and current percentage is `< minExitPct`.
- Both timeout exits realize the actual current contract price. Only the reason differs.

Payload addition under `simulation`:

```js
simulation: {
  positions,
  lastResolved,
  ceStatus,
  scalp: {
    cards: {
      "Scalp Force 5m": { ... },
      "Scalp Force 15m": { ... }
    },
    strip: {
      activePosition,
      latestEntry,
      latestExit,
      cumulativePnlByIndicator
    }
  }
}
```

Persistence:

- `C:\GitHub\PolymarketBTC15mAssistant\logs\scalp_trades_5m.csv`
- `C:\GitHub\PolymarketBTC15mAssistant\logs\scalp_trades_15m.csv`

Recommended columns:

- `timestamp`
- `indicator`
- `market_slug`
- `window_min`
- `side`
- `entry_price`
- `exit_price`
- `entry_time`
- `exit_time`
- `hold_seconds`
- `exit_reason`
- `stake_usd`
- `effective_stake_usd`
- `shares`
- `pnl_usd`
- `price_to_beat`
- `current_price_entry`
- `exchange_median_entry`
- `take_profit_pct`
- `min_exit_pct`
- `entry_open_window_sec`
- `max_hold_sec`

## Related Code Files

- Create `C:\GitHub\PolymarketBTC15mAssistant\src\engines\scalpForce.js`
- Modify `C:\GitHub\PolymarketBTC15mAssistant\src\server.js`
- Reuse `C:\GitHub\PolymarketBTC15mAssistant\src\utils.js` `appendCsvRow`

## Implementation Steps

1. Create pure helper functions in `src/engines/scalpForce.js`.
2. Instantiate one scalp runtime per supported timeframe inside `createTimeframeEngine()`.
3. Exclude scalp indicators from the existing hold-to-expiry `simPositions` entry loop.
4. Reuse already-computed signals and prices to evaluate arm/entry/exit every tick.
5. Append scalp CSV rows only when a scalp trade closes.
6. Maintain cumulative PnL from scalp CSV bootstrap on startup, per indicator.
7. Add a `simulation.scalp` payload subtree for UI rendering.
8. Explicitly skip `polyTrader.placeTrade()` for scalp indicators in MVP.

## Todo List

- [ ] Create scalp engine helper.
- [ ] Add per-timeframe scalp runtime state.
- [ ] Implement direction and strength gates.
- [ ] Implement explicit effective stake math.
- [ ] Implement TP and timeout exits.
- [ ] Append dedicated scalp CSV rows.
- [ ] Bootstrap cumulative scalp stats from disk.
- [ ] Expose scalp payload to frontend.
- [ ] Block live order dispatch for scalp indicators.

## Success Criteria

- Scalp indicators can arm, enter, and close without touching `simPositions`.
- `sim_trades_*` behavior remains unchanged for legacy indicators.
- Closed scalp trades persist into the dedicated CSV files.
- Tick payload includes enough state for realtime cards and the lower strip.
- Global LIVE mode does not accidentally fire real scalp orders.

## Risk Assessment

- Risk: server tick loop grows too much.  
  Mitigation: move scalp logic into pure helper functions and keep zero extra network calls.
- Risk: state leaks between slugs or candle windows.  
  Mitigation: reset scalp runtime on market slug change or after close, with explicit guards.
- Risk: timeout exits record stale prices.  
  Mitigation: only exit on valid contract price ticks; otherwise hold state until next valid tick.

## Security Considerations

- Do not route scalp paths into live trading until sell/exit support exists.
- Clamp effective stake before any future execution path.
- Avoid writing malformed CSV rows by normalizing all numeric fields.

## Next Steps

- Phase 03 consumes `simulation.scalp`.
- Phase 04 validates state transitions and CSV output.

## Unresolved Questions

- None blocking for simulation MVP.
