# Phase 01 - Runtime Config And Indicator Registry

## Context Links

- [Spec](../../docs/superpowers/specs/2026-04-23-scalp-force-design.md)
- `C:\GitHub\PolymarketBTC15mAssistant\src\server.js`
- `C:\GitHub\PolymarketBTC15mAssistant\public\dry.js`

## Overview

- Date: 2026-04-23
- Priority: high
- Status: planned
- Goal: register the new scalp indicators and replace the flat stake-only config model with an extensible per-indicator config payload.

## Key Insights

- `ALL_INDICATORS` is the registry for server and dry dashboard.
- Runtime config is currently `enabledIndicators{tf}` + `stakesPerIndicator`.
- WebSocket `getConfig` and `setConfig` only know stake numbers.
- `Consensus Edge` already has special-case runtime behavior. Another special-case path inside flat config will get messy fast.

## Requirements

- Add `Scalp Force 5m` and `Scalp Force 15m` to the shared indicator registry.
- Support per-indicator config objects, not only stake.
- Preserve current behavior for all existing indicators.
- Keep old `stakesPerIndicator` available during migration so the UI does not break mid-refactor.
- Validate all numeric config server-side.

## Architecture

Recommended config shape:

```js
const indicatorConfigs = {
  "TA Predict": { stakeUsd: 1 },
  "Consensus Edge": { stakeUsd: 1 },
  "Scalp Force 5m": {
    stakeUsd: 1,
    entryMinPct: 50,
    entryMaxPct: 55,
    takeProfitPct: 75,
    minExitPct: 58,
    entryOpenWindowSec: 20,
    maxHoldSec: 150,
    minSharesFloor: 5,
    maxEffectiveStakeUsd: 10,
    enabled: false
  },
  "Scalp Force 15m": { ... }
};
```

Compatibility layer:

- Server still returns `stakesPerIndicator` as a derived object.
- Server accepts both:
  - legacy `stakesPerIndicator`
  - new `indicatorConfigs`
- Reads in trading logic move to helpers:
  - `getIndicatorConfig(name)`
  - `getIndicatorStake(name)`
  - `isScalpIndicator(name)`

## Related Code Files

- Modify `C:\GitHub\PolymarketBTC15mAssistant\src\server.js`
  - extend `ALL_INDICATORS`
  - replace flat config store
  - upgrade `getConfig` / `setConfig`
- Modify `C:\GitHub\PolymarketBTC15mAssistant\public\dry.js`
  - read new `indicatorConfigs`
  - keep fallback to legacy fields

## Implementation Steps

1. Add the two scalp indicators to the shared registry in server and dry dashboard.
2. Introduce server-side default config builders for regular and scalp indicators.
3. Replace direct `tradingConfig.stakesPerIndicator[name]` reads with helper accessors.
4. Extend WebSocket `getConfig` payload to include `indicatorConfigs`.
5. Extend `setConfig` to merge sanitized per-indicator patches.
6. Keep `stakesPerIndicator` as a derived compatibility field until UI migration completes.
7. Clamp invalid values:
   - percentages: `0-100`
   - seconds: positive integer
   - stake/risk caps: positive number
   - `entryMinPct <= entryMaxPct`

## Todo List

- [ ] Add scalp indicators to registry.
- [ ] Define default config objects.
- [ ] Add config helpers in `server.js` or dedicated engine helper.
- [ ] Upgrade WebSocket config contract.
- [ ] Preserve legacy stake payload during transition.

## Success Criteria

- `getConfig` returns scalp indicator defaults plus legacy stake aliases.
- `setConfig` accepts valid scalp params and rejects malformed values.
- Existing indicators still read stake correctly.
- Dry dashboard can continue loading config without runtime error.

## Risk Assessment

- Risk: partial migration leaves some reads on the old stake map.  
  Mitigation: route all stake access through one helper before engine work.
- Risk: invalid UI payload creates broken runtime state.  
  Mitigation: clamp and ignore bad fields server-side.

## Security Considerations

- Treat all WebSocket config input as untrusted.
- Never allow negative stake, NaN, or unbounded timers.
- Do not infer LIVE permission from scalp config; it remains global.

## Next Steps

- Phase 02 depends on this config contract.
- Freeze the payload shape before touching UI rendering.

## Unresolved Questions

- None blocking in this phase.
