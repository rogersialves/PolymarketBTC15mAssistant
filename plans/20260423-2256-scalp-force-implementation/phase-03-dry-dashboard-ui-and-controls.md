# Phase 03 - Dry Dashboard UI And Controls

## Context Links

- [Spec](../../docs/superpowers/specs/2026-04-23-scalp-force-design.md)
- `C:\GitHub\PolymarketBTC15mAssistant\public\dry.html`
- `C:\GitHub\PolymarketBTC15mAssistant\public\dry.js`
- `C:\GitHub\PolymarketBTC15mAssistant\public\dry.css`

## Overview

- Date: 2026-04-23
- Priority: high
- Status: planned
- Goal: surface the scalp strategies in `Atividade em Tempo Real`, with visible runtime metrics and adjustable time/percentage controls.

## Key Insights

- The current activity panel already has the right location.
- `renderUnifiedGrid()` only supports simple active/inactive chips.
- The lower block is currently dedicated to `Último Trade Resolvido`.
- The config modal can hold enable/stake/risk controls, but the user wants time and percentage params visible on the indicator itself.

## Requirements

- Show two dedicated scalp cards in the realtime activity section.
- Keep existing indicator chips for legacy indicators.
- Show runtime state, direction, prices, targets, remaining time, effective stake, and reasons.
- Allow editing tactical params on screen:
  - `entry min %`
  - `entry max %`
  - `take profit %`
  - `min exit %`
  - `entry open window`
  - `max hold time`
- Keep enable toggle, stake, min shares floor, and max effective stake in config surfaces too.
- Preserve current config modal for regular indicators.

## Architecture

UI layout in `Atividade em Tempo Real`:

1. `Consensus Edge` status stays at top.
2. New scalp cards row goes next.
3. Existing unified indicator grid remains below, with total count updated to include 15 indicators.
4. Replace `Último Trade Resolvido` block with a scalp operations strip.

Recommended rendering split:

- `renderScalpCards(sim.scalp.cards)`
- `renderUnifiedGrid(sim)`
- `renderScalpStrip(sim.scalp.strip)`

Inline controls in each scalp card:

- small numeric inputs for percentages and seconds
- explicit `Aplicar` button per card
- changes send `setConfig` with an `indicatorConfigs` patch only for that indicator

Config modal changes:

- regular indicators keep the existing toggle + stake grid
- scalp indicators get a compact advanced settings panel inside the relevant timeframe tab
- advanced controls:
  - `base stake usd`
  - `min shares floor`
  - `max effective stake usd`
  - `enabled`

Suggested payload consumption:

```js
msg.data.simulation.scalp.cards["Scalp Force 5m"]
msg.data.simulation.scalp.strip.latestExit
msg.data.indicatorConfigs["Scalp Force 5m"]
```

## Related Code Files

- Modify `C:\GitHub\PolymarketBTC15mAssistant\public\dry.html`
  - add scalp cards container
  - replace lower resolved-trade block with scalp strip container
- Modify `C:\GitHub\PolymarketBTC15mAssistant\public\dry.js`
  - render scalp cards and strip
  - send inline config patches
  - extend modal rendering for scalp advanced params
- Modify `C:\GitHub\PolymarketBTC15mAssistant\public\dry.css`
  - add dedicated scalp card and strip styles
  - preserve dense layout on desktop and mobile

## Implementation Steps

1. Add dedicated DOM containers in `dry.html`.
2. Create new render functions in `dry.js` for scalp cards and strip.
3. Update `renderUnifiedGrid()` count logic for 15 indicators.
4. Keep legacy indicator chip rendering intact for non-scalp indicators.
5. Add inline form controls on scalp cards for time and percentage params.
6. Route inline save actions through WebSocket `setConfig`.
7. Extend config modal to read/write advanced scalp settings.
8. Add visual states:
   - idle
   - armed
   - ready
   - in position
   - tp hit
   - timeout
   - cancelled

## Todo List

- [ ] Add scalp cards container.
- [ ] Add scalp strip container.
- [ ] Implement scalp card rendering.
- [ ] Implement inline parameter editing.
- [ ] Extend config modal for advanced scalp fields.
- [ ] Style new components for desktop/mobile.

## Success Criteria

- Two scalp cards are always visible in `Atividade em Tempo Real`.
- Time and percentage params are visible on the cards and editable from the screen.
- Advanced stake/risk fields are editable in config UI.
- Existing indicator chips still render correctly.
- Lower strip shows active position, latest entry/exit, and cumulative scalp PnL.

## Risk Assessment

- Risk: card UI gets too dense.  
  Mitigation: keep inline edits to tactical knobs; push stake/risk knobs to advanced panel.
- Risk: config changes spam the WebSocket.  
  Mitigation: use explicit `Aplicar` button, not auto-save on every keystroke.
- Risk: mobile layout breaks.  
  Mitigation: fixed grid tracks, compact labels, responsive stacking in CSS.

## Security Considerations

- Escape all text values when rendering.
- Do not trust browser-side numeric validation; server still clamps.
- Keep LIVE mode warnings unchanged even though scalp MVP is sim-only.

## Next Steps

- Phase 04 verifies the new UI states and edit flows.

## Unresolved Questions

- None blocking if inline edits use explicit apply.
