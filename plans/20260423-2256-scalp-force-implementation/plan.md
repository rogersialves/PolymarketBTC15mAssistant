# Scalp Force Implementation Plan

Date: 2026-04-23
Status: Ready for implementation
Spec: [Scalp Force Design](../../docs/superpowers/specs/2026-04-23-scalp-force-design.md)

## Scope

- Add `Scalp Force 5m` and `Scalp Force 15m`.
- Keep scalp simulation isolated from hold-to-expiry simulation.
- Render both strategies inside `Atividade em Tempo Real`.
- Expose adjustable time and percentage params on screen.
- Keep `5 shares` handling explicit via effective stake math.

## Key Decisions

- MVP is simulation-first. No `PolyTrader` dispatch for scalp indicators.
- Backend config moves from flat `stakesPerIndicator` to extensible `indicatorConfigs`, with legacy compatibility.
- Scalp runtime lives in a dedicated engine helper, not inline-only inside `server.js`.
- Scalp results get dedicated CSV logs. They do not enter `sim_trades_*`.
- Inline UI controls handle tactical params; config modal keeps enable/stake/risk controls.

## Phases

1. [Phase 01 - Runtime Config And Indicator Registry](./phase-01-runtime-config-and-indicator-registry.md)  
   Status: pending  
   Outcome: new indicators registered, config payload extended, backward compatibility preserved.

2. [Phase 02 - Scalp Engine And Persistence](./phase-02-scalp-engine-and-persistence.md)  
   Status: pending  
   Outcome: isolated state machine, tick-based entry/exit, dedicated scalp logs, dashboard payload.

3. [Phase 03 - Dry Dashboard UI And Controls](./phase-03-dry-dashboard-ui-and-controls.md)  
   Status: pending  
   Outcome: new realtime cards, operational strip, inline parameter editing, modal integration.

4. [Phase 04 - Validation And Rollout Guardrails](./phase-04-validation-and-rollout-guardrails.md)  
   Status: pending  
   Outcome: smoke coverage, manual checklist, live guardrails, rollout defaults.

## Dependencies

- Phase 01 before all others.
- Phase 02 depends on Phase 01 config shape.
- Phase 03 depends on Phase 02 payload contract.
- Phase 04 runs after Phases 01-03 land.

## Affected Files

- `C:\GitHub\PolymarketBTC15mAssistant\src\server.js`
- `C:\GitHub\PolymarketBTC15mAssistant\src\engines\scalpForce.js` (new)
- `C:\GitHub\PolymarketBTC15mAssistant\public\dry.html`
- `C:\GitHub\PolymarketBTC15mAssistant\public\dry.js`
- `C:\GitHub\PolymarketBTC15mAssistant\public\dry.css`
- `C:\GitHub\PolymarketBTC15mAssistant\scripts\scalp-force-smoke.mjs` (new, optional but recommended)
- `C:\GitHub\PolymarketBTC15mAssistant\package.json` (optional script hook)

## Non-Goals For This Plan

- No new page.
- No historical backfill for past scalp trades.
- No live scalp execution path yet.
- No config persistence beyond current runtime session.

## Unresolved Questions

- Should runtime scalp params survive server restart later. Not needed for MVP.
- Should scalp cards also appear on `public/index.html` later. Not needed for MVP.
