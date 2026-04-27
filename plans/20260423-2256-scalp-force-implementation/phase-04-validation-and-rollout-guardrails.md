# Phase 04 - Validation And Rollout Guardrails

## Context Links

- [Spec](../../docs/superpowers/specs/2026-04-23-scalp-force-design.md)
- `C:\GitHub\PolymarketBTC15mAssistant\package.json`
- `C:\GitHub\PolymarketBTC15mAssistant\src\engines\scalpForce.js` (planned)
- `C:\GitHub\PolymarketBTC15mAssistant\public\dry.js`

## Overview

- Date: 2026-04-23
- Priority: medium
- Status: planned
- Goal: validate the new state machine and prevent accidental live-trading assumptions.

## Key Insights

- The repo has no formal test framework today.
- A pure helper module makes low-cost smoke coverage possible with plain Node.
- The biggest product risk is not syntax. It is false behavior:
  - entering outside the window
  - mixing scalp results with old logs
  - accidentally routing scalp trades to LIVE execution

## Requirements

- Validate core state transitions with deterministic inputs.
- Validate CSV output format.
- Validate frontend rendering for major states.
- Keep scalp indicators disabled by default until manually enabled.
- Make simulation-only scope obvious when global mode is LIVE.

## Architecture

Recommended smoke harness:

- Create `C:\GitHub\PolymarketBTC15mAssistant\scripts\scalp-force-smoke.mjs`
- Add `package.json` script:

```json
{
  "scripts": {
    "test:scalp-force": "node scripts/scalp-force-smoke.mjs"
  }
}
```

Harness scenarios:

1. valid 5m entry in `50-55%`
2. valid 15m entry with `Delta 3m` confirmation
3. reject on direction disagreement between `Current Price` and exchange median
4. reject on contract price outside entry band
5. reject on effective stake above risk cap
6. TP exit
7. timeout exit above `min exit %`
8. timeout forced exit below `min exit %`
9. missing price tick while in position
10. market slug rollover reset

Manual UI smoke:

- open `dry.html`
- enable `Scalp Force 5m` and `Scalp Force 15m`
- edit tactical params inline
- verify `simulation.scalp` state transitions on screen
- verify CSV rows append only on close

## Related Code Files

- Create `C:\GitHub\PolymarketBTC15mAssistant\scripts\scalp-force-smoke.mjs`
- Modify `C:\GitHub\PolymarketBTC15mAssistant\package.json`
- Modify `C:\GitHub\PolymarketBTC15mAssistant\src\engines\scalpForce.js`
- Modify `C:\GitHub\PolymarketBTC15mAssistant\src\server.js`
- Modify `C:\GitHub\PolymarketBTC15mAssistant\public\dry.js`

## Implementation Steps

1. Keep scalp helper functions pure where possible.
2. Build a Node smoke script with fixture inputs and assertions.
3. Add syntax checks:
   - `node --check src/server.js`
   - `node --check public/dry.js`
4. Run the smoke script after backend work.
5. Run manual dashboard smoke with server started.
6. Verify file outputs:
   - `logs/scalp_trades_5m.csv`
   - `logs/scalp_trades_15m.csv`
7. Verify no scalp entry appears in `sim_trades_*`.
8. Verify no scalp path calls `polyTrader.placeTrade()`.

## Todo List

- [ ] Add smoke harness script.
- [ ] Add package script hook.
- [ ] Cover state transition scenarios.
- [ ] Verify CSV output.
- [ ] Verify UI render states manually.
- [ ] Verify live-dispatch guardrail.

## Success Criteria

- Smoke script passes on deterministic scenarios.
- Manual UI check shows correct state and editable params.
- Dedicated scalp CSV files are created with expected columns.
- Existing `sim_trades_*` analytics still behave as before.
- Scalp indicators remain simulation-only.

## Risk Assessment

- Risk: no automated coverage means regressions hide in manual testing.  
  Mitigation: keep pure helper coverage in the Node smoke script.
- Risk: users assume global LIVE mode affects scalp indicators.  
  Mitigation: label scalp cards and config UI as `Simulação dedicada` in MVP.
- Risk: config defaults are too permissive.  
  Mitigation: ship disabled by default with conservative caps.

## Security Considerations

- Do not add any path that can place or exit real scalp trades in MVP.
- Keep CSV writing inside repo `logs/`.
- Fail closed on invalid config or missing price data.

## Next Steps

- After this phase, implementation is ready for review and then code work.

## Unresolved Questions

- Decide later whether to persist runtime scalp config across restart.
