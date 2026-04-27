// ── src/polyTrader.js ── Polymarket CLOB Trading Module ──
// Handles authentication, order placement, and balance tracking
// DRY_RUN mode: logs orders without executing
// LIVE mode: submits real orders via CLOB API

import { ethers } from "ethers";
import { existsSync, readFileSync } from "fs";
import { resolve } from "path";
import { mergeTradeHistoryRecords, readTradeHistoryFile, writeTradeHistoryFileAtomicAsync } from "./tradeHistoryMerge.js";
import { isPostgresEnabled } from "./storage/db.js";
import { ensureTradeHistorySchema, listTradeHistoryRecords, upsertTradeHistoryRecords } from "./storage/tradeHistoryStore.js";

// ── Ethers v6 → v5 Signer Adapter ──
// The @polymarket/clob-client expects ethers v5 _signTypedData, but we use v6
function createClobSigner(wallet) {
  return {
    getAddress: () => Promise.resolve(wallet.address),
    _signTypedData: (domain, types, value) => wallet.signTypedData(domain, types, value)
  };
}

export class PolyTrader {
  constructor(config = {}) {
    this.privateKey = config.privateKey || process.env.POLY_PRIVATE_KEY;
    this.dryRun = config.dryRun ?? (process.env.POLY_DRY_RUN !== "false");
    this.maxStake = parseFloat(config.maxStake || process.env.POLY_MAX_STAKE || "40");
    this.chainId = parseInt(config.chainId || process.env.POLY_CHAIN_ID || "137");
    this.host = config.host || process.env.POLY_CLOB_HOST || "https://clob.polymarket.com";
    // SignatureType: 0=EOA (default, regular wallet), 1=POLY_PROXY, 2=POLY_GNOSIS_SAFE
    this.signatureType = parseInt(config.signatureType ?? process.env.POLY_SIGNATURE_TYPE ?? "0");
    this.funderAddress = config.funderAddress || process.env.POLY_FUNDER_ADDRESS || undefined;

    this.client = null;
    this.creds = null;
    this.wallet = null;
    this.initialized = false;
    this.lastError = null;

    // Trade tracking
    this.orderHistory = [];
    this.openOrders = [];
    this.usdcBalance = null;

    // Persistent history file
    this._historyPath = resolve("./logs/trade_history.json");
    this._historySaveDebounceMs = Math.max(50, Number(process.env.TRADE_HISTORY_SAVE_DEBOUNCE_MS || 250));
    this._historySaveTimer = null;
    this._historySaveInProgress = false;
    this._historySavePending = false;
    this._historyReady = this._loadHistory();
  }

  // ── Load orderHistory from disk ──
  async _loadHistory() {
    try {
      if (isPostgresEnabled()) {
        await ensureTradeHistorySchema();
        const data = await listTradeHistoryRecords();
        if (Array.isArray(data) && data.length > 0) {
          this.orderHistory = data;
          const live = data.filter(t => !t.dryRun).length;
          const dry  = data.filter(t =>  t.dryRun).length;
          console.log(`📂 [PolyTrader] Histórico carregado do Postgres: ${data.length} operações (${live} LIVE, ${dry} SIM)`);
        }
        return;
      }
      if (existsSync(this._historyPath)) {
        const raw = readFileSync(this._historyPath, "utf8");
        const data = JSON.parse(raw);
        if (Array.isArray(data) && data.length > 0) {
          this.orderHistory = data;
          const live = data.filter(t => !t.dryRun).length;
          const dry  = data.filter(t =>  t.dryRun).length;
          console.log(`📂 [PolyTrader] Histórico carregado: ${data.length} operações (${live} LIVE, ${dry} SIM)`);
        }
      }
    } catch (err) {
      console.warn(`⚠️  [PolyTrader] Erro ao carregar histórico: ${err.message}`);
    }
  }

  // ── Save orderHistory to disk (async — não bloqueia event loop) ──
  async _flushHistoryNow() {
    try {
      if (isPostgresEnabled()) {
        await ensureTradeHistorySchema();
        await upsertTradeHistoryRecords(this.orderHistory);
        return;
      }
      const diskHistory = readTradeHistoryFile(this._historyPath);
      const merged = mergeTradeHistoryRecords(diskHistory, this.orderHistory);
      this.orderHistory = merged;
      await writeTradeHistoryFileAtomicAsync(this._historyPath, this.orderHistory);
    } catch (err) {
      console.warn(`⚠️  [PolyTrader] Erro ao salvar histórico: ${err.message}`);
    }
  }

  _scheduleHistoryFlush() {
    if (this._historySaveTimer) return;
    this._historySaveTimer = setTimeout(async () => {
      this._historySaveTimer = null;
      if (this._historySaveInProgress) {
        this._historySavePending = true;
        return;
      }
      this._historySaveInProgress = true;
      try {
        await this._flushHistoryNow();
      } finally {
        this._historySaveInProgress = false;
        if (this._historySavePending) {
          this._historySavePending = false;
          this._scheduleHistoryFlush();
        }
      }
    }, this._historySaveDebounceMs);
    this._historySaveTimer.unref?.();
  }

  _saveHistory() {
    this._scheduleHistoryFlush();
  }

  _toNumber(value, fallback = 0) {
    const n = parseFloat(value);
    return Number.isFinite(n) ? n : fallback;
  }

  _safeArrayJson(value) {
    if (Array.isArray(value)) return value;
    if (typeof value === "string") {
      try {
        const parsed = JSON.parse(value);
        return Array.isArray(parsed) ? parsed : [];
      } catch {
        return [];
      }
    }
    return [];
  }

  _isConfirmedTradeStatus(status) {
    const s = String(status || "").toUpperCase();
    return (
      s.includes("CONFIRMED") ||
      s.includes("SETTLED") ||
      s.includes("MINED") ||
      s.includes("SUCCESS")
    );
  }

  _isFailedTradeStatus(status) {
    const s = String(status || "").toUpperCase();
    return (
      s.includes("FAIL") ||
      s.includes("REJECT") ||
      s.includes("CANCEL")
    );
  }

  async _fetchTradeStatuses(tradeIds = []) {
    if (!this.initialized || !this.client || typeof this.client.getTrades !== "function") {
      return [];
    }
    const statuses = [];
    for (const tradeId of tradeIds) {
      if (!tradeId) continue;
      try {
        const trades = await this.client.getTrades({ id: tradeId }, true);
        const first = Array.isArray(trades) ? trades[0] : null;
        statuses.push({
          id: tradeId,
          status: first?.status || "unknown"
        });
      } catch {
        statuses.push({
          id: tradeId,
          status: "unknown"
        });
      }
    }
    return statuses;
  }

  // ── Recover LIVE trades from Polymarket CLOB API ──
  // Merges trades found on-chain into orderHistory (no duplicates by orderId)
  async syncLiveTradesFromApi() {
    if (!this.initialized || !this.client || !this.wallet) return 0;
    try {
      // ClobClient v5 exposes getTrades({ maker_address })
      let trades = null;
      if (typeof this.client.getTrades === "function") {
        trades = await this.client.getTrades({ maker_address: this.wallet.address });
      }
      if (!Array.isArray(trades) || trades.length === 0) return 0;

      let added = 0;
      for (const t of trades) {
        const fallbackTradeId = t.id || t.trade_id || t.orderId;
        const orderId = t.taker_order_id || t.order_id || t.maker_order_id || t.maker_orders?.[0]?.order_id || fallbackTradeId;
        if (!orderId) continue;
        const exists = this.orderHistory.some(h => h.orderId === orderId);
        if (exists) continue;

        const size = this._toNumber(t.size ?? t.amount ?? 0);
        const recoveredStatus = t.status || "unknown";
        const fillConfirmed = this._isConfirmedTradeStatus(recoveredStatus);
        const associatedTradeId = t.id || t.trade_id || null;
        this.orderHistory.push({
          timestamp: t.match_time ? new Date(t.match_time).getTime() : (t.created_at ? new Date(t.created_at).getTime() : Date.now()),
          side: (t.side || t.maker_side || "BUY").toUpperCase(),
          price: parseFloat(t.price ?? 0),
          sizeUsd: size,
          shares: size,
          tokenId: t.asset_id || t.maker_asset_id || t.token_id || null,
          metadata: { indicator: "Polymarket API", timeframe: "?" },
          dryRun: false,
          orderId,
          status: "submitted",
          fillStatus: recoveredStatus,
          orderStatus: recoveredStatus,
          originalSize: size,
          sizeMatched: size,
          filledSize: size,
          associatedTradeIds: associatedTradeId ? [associatedTradeId] : [],
          fillConfirmed,
          fillConfirmedAt: fillConfirmed ? Date.now() : null,
          executionStatus: fillConfirmed ? "filled_confirmed" : "submitted",
          error: null
        });
        added++;
      }

      if (added > 0) {
        this._saveHistory();
        console.log(`🔄 [PolyTrader] ${added} operações recuperadas da API Polymarket`);
      }
      return added;
    } catch (err) {
      console.warn(`⚠️  [PolyTrader] syncLiveTradesFromApi: ${err.message}`);
      return 0;
    }
  }

  // ── Initialize connection to Polymarket CLOB ──
  async init() {
    await this._historyReady;
    if (!this.privateKey) {
      console.log("⚠️  [PolyTrader] POLY_PRIVATE_KEY não configurada — operando apenas em DRY_RUN");
      this.dryRun = true;
      this.initialized = false;
      return false;
    }

    try {
      // Dynamic import to avoid breaking if package not installed
      const { ClobClient } = await import("@polymarket/clob-client");

      // Create ethers wallet
      this.wallet = new ethers.Wallet(this.privateKey);
      this.privateKey = null; // clear from memory after use
      const signer = createClobSigner(this.wallet);
      console.log(`🔑 [PolyTrader] Wallet EOA: ${this.wallet.address}`);

      // ── Determine signatureType e funderAddress ──
      // Se POLY_FUNDER_ADDRESS ou POLY_SIGNATURE_TYPE=1/2 explícito → respeitar config
      // Se POLY_SIGNATURE_TYPE=0 (padrão) → auto-detectar: testa saldo com type=1;
      //   se não-zero → POLY_PROXY; caso contrário → EOA (type=0)
      let effectiveSignatureType = this.signatureType;
      let effectiveFunderAddress = this.funderAddress || undefined;

      if (effectiveFunderAddress) {
        // Endereço proxy explícito → POLY_PROXY
        effectiveSignatureType = 1;
        console.log(`🔗 [PolyTrader] Proxy wallet (env): ${effectiveFunderAddress}`);
      } else if (this.signatureType >= 1) {
        // Tipo explícito 1 ou 2 → usar EOA como funder padrão
        effectiveFunderAddress = this.wallet.address;
        console.log(`🔗 [PolyTrader] SignatureType explícito: ${this.signatureType}`);
      }
      // else: type=0 → tentaremos auto-detectar após derivar API keys

      // Step 1: Derivar API keys (chave é independente do signatureType)
      const l1Client = new ClobClient(
        this.host,
        this.chainId,
        signer,
        undefined,
        0,           // type=0 para derivação de chave (tipo não afeta o processo)
        undefined
      );

      console.log("🔑 [PolyTrader] Derivando API keys...");
      this.creds = await l1Client.createOrDeriveApiKey();
      console.log(`✅ [PolyTrader] API Key: ${this.creds.key.substring(0, 8)}...`);

      // Step 2: Auto-detectar se type=0 (padrão) e nenhum funder explícito
      if (this.signatureType === 0 && !effectiveFunderAddress) {
        try {
          const { AssetType } = await import("@polymarket/clob-client");
          const probeClient = new ClobClient(
            this.host, this.chainId, signer, this.creds, 1, this.wallet.address
          );
          const probe = await probeClient.getBalanceAllowance({
            asset_type: AssetType?.COLLATERAL || "COLLATERAL",
            signature_type: 1
          });
          const probeBalance = parseFloat(probe?.balance ?? "0");
          if (probeBalance > 0) {
            effectiveSignatureType = 1;
            effectiveFunderAddress = this.wallet.address;
            console.log(`🔗 [PolyTrader] Fundos detectados no POLY_PROXY (type=1) — saldo: ${probeBalance}`);
          } else {
            effectiveSignatureType = 0;
            console.log(`ℹ️  [PolyTrader] Sem saldo proxy → usando EOA direto (type=0)`);
          }
        } catch (probeErr) {
          effectiveSignatureType = 0;
          console.log(`ℹ️  [PolyTrader] Probe proxy falhou: ${probeErr.message} → EOA (type=0)`);
        }
      }

      const sigTypeLabel = ["EOA", "POLY_PROXY", "POLY_GNOSIS_SAFE"][effectiveSignatureType] ?? effectiveSignatureType;
      console.log(`🔐 [PolyTrader] SignatureType: ${sigTypeLabel} (${effectiveSignatureType})`);

      // Step 3: Criar cliente autenticado com parâmetros efetivos
      this.effectiveSignatureType = effectiveSignatureType;
      this.effectiveFunderAddress = effectiveFunderAddress;
      this.client = new ClobClient(
        this.host,
        this.chainId,
        signer,
        this.creds,
        effectiveSignatureType,
        effectiveFunderAddress
      );

      // Step 4: Verify connection
      const ok = await this.client.getOk();
      console.log(`✅ [PolyTrader] Conectado ao CLOB: ${ok}`);

      this.initialized = true;
      this.lastError = null;

      // Fetch initial balance
      await this.refreshBalance();

      // Recover LIVE trades from Polymarket API (fills gaps on restart)
      await this.syncLiveTradesFromApi();

      const modeLabel = this.dryRun ? "📡 SCALP MONITOR (SIM)" : "💰 LIVE TRADING";
      console.log(`\n🎯 [PolyTrader] Modo: ${modeLabel} | Max Stake: $${this.maxStake}`);

      return true;
    } catch (err) {
      this.lastError = err.message || String(err);
      console.error(`❌ [PolyTrader] Falha na inicialização: ${this.lastError}`);
      this.dryRun = true; // Fallback to dry run on error
      return false;
    }
  }

  // ── Refresh USDC balance ──
  async refreshBalance() {
    if (!this.initialized || !this.client) return null;
    try {
      const { AssetType } = await import("@polymarket/clob-client");
      const resp = await this.client.getBalanceAllowance({
        asset_type: AssetType?.COLLATERAL || "COLLATERAL",
        signature_type: this.effectiveSignatureType ?? this.signatureType
      });

      // The CLOB API may return:
      //   • Raw micro-USDC integer string: "3210000" → divide by 1e6 → 3.21
      //   • Already-decimal string:        "3.21"    → use directly
      // Detect by checking if the value has a decimal point or is > 1e4
      const raw = parseFloat(resp.balance ?? "0");
      const isRawUnits = Number.isFinite(raw) && raw >= 1_000 && !String(resp.balance).includes(".");
      this.usdcBalance = isRawUnits ? raw / 1e6 : raw;

      console.log(`💰 [PolyTrader] Saldo USDC: $${this.usdcBalance.toFixed(2)} (raw="${resp.balance}")`);
      return this.usdcBalance;
    } catch (err) {
      console.error(`⚠️  [PolyTrader] Erro ao buscar saldo: ${err.message}`);
      return null;
    }
  }

  // ── Get order book for a token ──
  async getOrderBook(tokenId) {
    if (!this.initialized || !this.client) return null;
    try {
      return await this.client.getOrderBook(tokenId);
    } catch (err) {
      console.error(`⚠️  [PolyTrader] Erro ao buscar orderbook: ${err.message}`);
      return null;
    }
  }

  // ── Place a trade ──
  // side: "BUY" or "SELL"  
  // price: 0.01-0.99 (probability)
  // sizeUsd: amount in USD to trade
  // tokenId: the Polymarket conditional token ID
  // metadata: extra info (indicator, timeframe, etc.)
  async placeTrade({ side, price, sizeUsd, tokenId, forceLive = false, metadata = {} }) {
    // forceLive: execute LIVE for this specific indicator even if global dryRun = true
    const effectiveDryRun = this.dryRun && !forceLive;
    const { Side, OrderType } = await import("@polymarket/clob-client");

    // Cap the stake
    let cappedSize = Math.min(sizeUsd, this.maxStake);
    // Convert USD to shares: size = usd / price
    let shares = Math.floor((cappedSize / price) * 100) / 100; // Round down to 2 decimals
    if (!Number.isFinite(shares) || shares <= 0) {
      const record = {
        timestamp: Date.now(),
        side,
        price,
        sizeUsd: cappedSize,
        shares: 0,
        tokenId,
        metadata,
        dryRun: effectiveDryRun,
        orderId: null,
        status: "error",
        executionStatus: "error",
        error: "Invalid trade size"
      };
      this.orderHistory.push(record);
      this._saveHistory();
      return record;
    }

    const tradeRecord = {
      timestamp: Date.now(),
      side,
      price,
      sizeUsd: cappedSize,
      shares,
      tokenId,
      metadata,
      dryRun: effectiveDryRun,
      orderId: null,
      status: "pending",
      executionStatus: "pending",
      fillStatus: null,
      orderStatus: null,
      originalSize: shares,
      sizeMatched: 0,
      filledSize: 0,
      associatedTradeIds: [],
      fillConfirmed: false,
      fillConfirmedAt: null,
      error: null
    };

    // ── SIM MODE (Scalp Monitor) ──
    if (effectiveDryRun) {
      tradeRecord.status = "dry_run";
      tradeRecord.executionStatus = "dry_run";
      tradeRecord.orderId = `DRY_${Date.now()}`;
      console.log(`📡 [SIM] ${side} ${shares} shares @ $${price} ($${cappedSize}) | ${metadata.indicator || "?"} | Token: ${tokenId?.substring(0, 12)}...`);
      this.orderHistory.push(tradeRecord);
      this._saveHistory();
      return tradeRecord;
    }

    // ── LIVE MODE ──
    if (forceLive && this.dryRun) {
      console.log(`⚡ [LIVE-OVERRIDE] "${metadata.indicator || "?"}" executando LIVE individualmente (modo global = SIM)`); 
    }
    if (!this.initialized || !this.client) {
      tradeRecord.status = "error";
      tradeRecord.executionStatus = "error";
      tradeRecord.error = "Client not initialized";
      this.orderHistory.push(tradeRecord);
      this._saveHistory();
      return tradeRecord;
    }

    // ── Verificação antecipada de saldo (apenas BUY) ──
    // Evita enviar a ordem e receber HTTP 400 da Polymarket quando o saldo é insuficiente.
    // O saldo é atualizado por refreshBalance() a cada ciclo — se ainda não foi buscado
    // (null), deixa a ordem prosseguir normalmente para não bloquear sem certeza.
    if (side === "BUY" && this.usdcBalance !== null && this.usdcBalance < cappedSize) {
      const balStr = this.usdcBalance.toFixed(2);
      const reqStr = cappedSize.toFixed(2);
      const errMsg = `Saldo insuficiente: $${balStr} disponível, necessário $${reqStr}`;
      console.warn(`⚠️  [LIVE] ${errMsg} — ordem bloqueada (${metadata.indicator || "?"})`); 
      tradeRecord.status = "skipped";
      tradeRecord.executionStatus = "resolved";
      tradeRecord.error = errMsg;
      this.orderHistory.push(tradeRecord);
      this._saveHistory();
      return tradeRecord;
    }

    try {
      console.log(`💰 [LIVE] Enviando ordem: ${side} ${shares} shares @ $${price} ($${cappedSize})`);

      const orderSide = side === "BUY" ? Side.BUY : Side.SELL;
      const response = await this.client.createAndPostOrder(
        {
          tokenID: tokenId,
          price: price,
          size: shares,
          side: orderSide,
        },
        undefined, // options (tickSize auto-resolved)
        OrderType.GTC
      );

      tradeRecord.orderId = response?.orderID || response?.orderIds?.[0] || null;
      // Consider submitted if success=true, OR if we got an orderID without explicit failure
      const explicitSuccess = response?.success === true;
      const hasOrderId = Boolean(tradeRecord.orderId);
      const explicitFail = response?.success === false;
      const isSuccess = explicitSuccess || (hasOrderId && !explicitFail);

      tradeRecord.status = isSuccess ? "submitted" : "rejected";
      tradeRecord.executionStatus = isSuccess ? "submitted" : "rejected";
      tradeRecord.orderStatus = response?.status || null;
      tradeRecord.error = isSuccess ? null : (response?.errorMsg || response?.error || "API returned success=false");

      if (isSuccess) {
        console.log(`✅ [LIVE] Ordem enviada: ${tradeRecord.orderId}`);
      } else {
        console.error(`❌ [LIVE] Ordem REJEITADA — motivo: ${tradeRecord.error}`);
        console.error(`   Resposta completa: ${JSON.stringify(response)}`);
      }

      // Refresh balance after trade
      setTimeout(() => this.refreshBalance(), 2000);

    } catch (err) {
      tradeRecord.status = "error";
      tradeRecord.executionStatus = "error";
      tradeRecord.error = err.message || String(err);
      console.error(`❌ [LIVE] Erro na ordem: ${tradeRecord.error}`);
    }

    this.orderHistory.push(tradeRecord);
    this._saveHistory();
    return tradeRecord;
  }

  // ── Resolve scalp BUY+SELL pair — stamps intra-candle pnl on the BUY record ──
  // Called after SELL dispatch so the wallet modal can show real exit price and pnl
  // instead of waiting for candle-expiry resolution (which gives wrong price for scalp).
  resolveScalpPair(buyOrderId, { exitPrice, exitReason, pnlUsd, holdSeconds, sellOrderId = null, sellStatus = null, sellError = null }) {
    if (!buyOrderId) return false;
    const buy = this.orderHistory.find(t => t.orderId === buyOrderId && t.side === "BUY");
    if (!buy) return false;
    const sellAccepted = Boolean(sellOrderId) && !["rejected", "error", "skipped"].includes(String(sellStatus || "").toLowerCase());
    buy.exitReason = exitReason;
    buy.exitOrderId = sellOrderId;
    buy.exitOrderStatus = sellStatus || null;
    buy.exitOrderError = sellError || null;
    buy.exitPriceAttempted = exitPrice;
    buy.holdSeconds = holdSeconds;
    if (!sellAccepted) {
      buy.exitRejected = true;
      buy.executionStatus = buy.executionStatus === "resolved" ? "resolved" : "exit_rejected";
      this._saveHistory();
      return false;
    }
    buy.exitPrice = exitPrice;
    buy.pnl = pnlUsd;
    buy.resolved = true;
    buy.exitRejected = false;
    buy.executionStatus = "resolved";
    this._saveHistory();
    return true;
  }

  // ── Get open orders ──
  async getOpenOrders() {
    if (!this.initialized || !this.client) return [];
    try {
      const resp = await this.client.getOpenOrders();
      this.openOrders = resp || [];
      return this.openOrders;
    } catch (err) {
      console.error(`⚠️  [PolyTrader] Erro ao buscar ordens: ${err.message}`);
      return [];
    }
  }

  // ── Fetch market data via Polymarket Gamma "events" endpoint (cached per call) ──
  // The /markets?clob_token_ids=... endpoint returns empty for these BTC up/down markets,
  // so we query /events?slug=<marketSlug> and pull the markets[] array from the event.
  async _fetchMarketBySlug(slug, cache) {
    if (!slug) return null;
    if (cache.has(slug)) return cache.get(slug);
    try {
      const url = `https://gamma-api.polymarket.com/events?slug=${encodeURIComponent(slug)}`;
      const r = await fetch(url, { headers: { Accept: "application/json" } });
      if (!r.ok) { cache.set(slug, null); return null; }
      const events = await r.json();
      const event = Array.isArray(events) ? events[0] : null;
      const market = event && Array.isArray(event.markets) ? event.markets[0] : null;
      cache.set(slug, market);
      return market;
    } catch {
      cache.set(slug, null);
      return null;
    }
  }

  // ── Refresh resolution status for submitted LIVE orders ──
  // Updates execution first (must be fully filled), then market resolution by token.
  async refreshTradeResults() {
    // Include any LIVE order with a tokenId that still needs resolution OR was
    // previously marked as "unfilled" by the legacy logic (pre-fix) — those are
    // submitted orders with valid orderId that the old code wrongly flagged as
    // expired because the CLOB getOrder returned "unknown" hours later.
    const pending = this.orderHistory.filter(t => {
      if (t.dryRun || !t.tokenId) return false;
      const okStatus = ["submitted", "skipped", "rejected", "error"].includes(t.status);
      if (!okStatus) return false;
      if (!t.resolved) return true;
      // Re-evaluate stuck "expired" submitted orders (one-time correction)
      return t.resolved === true && t.unfilled === true
          && t.orderId && t.status === "submitted";
    });
    if (pending.length === 0) return 0;

    const marketCache = new Map(); // slug → market (1 fetch per slug per cycle)
    let updated = 0;
    for (const trade of pending) {
      let changed = false;
      try {
        // 1) Refresh order execution status via CLOB (orderId required)
        let originalSize = this._toNumber(trade.originalSize ?? trade.shares ?? 0, 0);
        let sizeMatched = this._toNumber(trade.sizeMatched ?? trade.filledSize ?? 0, 0);
        let associatedTradeIds = Array.isArray(trade.associatedTradeIds) ? trade.associatedTradeIds : [];

        if (this.initialized && this.client && trade.orderId) {
          try {
            const order = await this.client.getOrder(trade.orderId);
            const orderStatus = order?.status || "unknown";
            const nextOriginalSize = this._toNumber(order?.original_size ?? originalSize, originalSize);
            const nextMatchedSize = this._toNumber(order?.size_matched ?? sizeMatched, sizeMatched);
            const nextAssociated = Array.isArray(order?.associate_trades)
              ? order.associate_trades.filter(Boolean)
              : associatedTradeIds;

            if (trade.fillStatus !== orderStatus) { trade.fillStatus = orderStatus; changed = true; }
            if (trade.orderStatus !== orderStatus) { trade.orderStatus = orderStatus; changed = true; }
            if (trade.originalSize !== nextOriginalSize) { trade.originalSize = nextOriginalSize; changed = true; }
            if (trade.sizeMatched !== nextMatchedSize) { trade.sizeMatched = nextMatchedSize; changed = true; }
            if (trade.filledSize !== nextMatchedSize) { trade.filledSize = nextMatchedSize; changed = true; }

            const prevIds = JSON.stringify(associatedTradeIds);
            const nextIds = JSON.stringify(nextAssociated);
            if (prevIds !== nextIds) {
              trade.associatedTradeIds = nextAssociated;
              changed = true;
            }

            originalSize = nextOriginalSize;
            sizeMatched = nextMatchedSize;
            associatedTradeIds = nextAssociated;
          } catch { /* ignore — might not be available */ }
        }

        const fullyMatched = originalSize > 0 && (sizeMatched + 1e-8) >= originalSize;
        let allAssociatedConfirmed = false;
        let hasFailedAssociated = false;

        if (fullyMatched && associatedTradeIds.length > 0) {
          const statuses = await this._fetchTradeStatuses(associatedTradeIds);
          if (statuses.length > 0) {
            const prevStatuses = JSON.stringify(trade.associatedTradeStatuses || []);
            const nextStatuses = JSON.stringify(statuses);
            if (prevStatuses !== nextStatuses) {
              trade.associatedTradeStatuses = statuses;
              changed = true;
            }
            hasFailedAssociated = statuses.some(s => this._isFailedTradeStatus(s.status));
            allAssociatedConfirmed = statuses.every(s => this._isConfirmedTradeStatus(s.status));
          }
        }

        const orderStatusUpper = String(trade.orderStatus || trade.fillStatus || "").toUpperCase();
        const orderLooksFilled = /FILLED|MATCHED|EXECUTED|COMPLETED/.test(orderStatusUpper);
        const fillConfirmed = fullyMatched && !hasFailedAssociated &&
          (allAssociatedConfirmed || orderLooksFilled || associatedTradeIds.length === 0);

        if (trade.fillConfirmed !== fillConfirmed) { trade.fillConfirmed = fillConfirmed; changed = true; }
        if (fillConfirmed && !trade.fillConfirmedAt) { trade.fillConfirmedAt = Date.now(); changed = true; }

        let nextExecutionStatus = "submitted";
        if (trade.resolved) nextExecutionStatus = "resolved";
        else if (fillConfirmed) nextExecutionStatus = "filled_confirmed";
        else if (sizeMatched > 0) nextExecutionStatus = "partial";
        if (trade.executionStatus !== nextExecutionStatus) { trade.executionStatus = nextExecutionStatus; changed = true; }

        // 2) Resolve market outcome via Gamma /events?slug=<marketSlug>
        //    The /markets?clob_token_ids endpoint returns empty for BTC up/down markets,
        //    so we use the events endpoint and pull markets[0] from the event.
        const slug = trade.metadata?.marketSlug;
        const market = await this._fetchMarketBySlug(slug, marketCache);
        if (!market) {
          if (changed) updated++;
          continue;
        }

        const nextClosed = Boolean(market.closed);
        const clobTokenIds = this._safeArrayJson(market.clobTokenIds);
        const outcomePrices = this._safeArrayJson(market.outcomePrices);

        // A binary market is "resolved" when closed AND outcomePrices contain
        // exactly one "1" and one "0" (active markets show fractional prices).
        const numericPrices = outcomePrices.map(p => parseFloat(p));
        const isResolved = nextClosed
          && numericPrices.length === 2
          && numericPrices.every(p => p === 0 || p === 1)
          && numericPrices.some(p => p === 1);

        if (trade.marketClosed !== nextClosed) { trade.marketClosed = nextClosed; changed = true; }
        if (trade.marketResolved !== isResolved) { trade.marketResolved = isResolved; changed = true; }

        if (isResolved) {
          const tokenIdx = clobTokenIds.findIndex(id => String(id) === String(trade.tokenId));
          if (tokenIdx >= 0) {
            const resPrice = numericPrices[tokenIdx];
            if (Number.isFinite(resPrice)) {
              const wasResolved = Boolean(trade.resolved);
              const won = resPrice >= 0.5; // 1.0 = won, 0.0 = lost

              // An order is "not placed" only when it was never sent to the CLOB
              // (skipped/rejected/error/no-orderId). For status="submitted" with an
              // orderId, presume filled at the requested size — the CLOB getOrder
              // call returns "unknown" hours later (orders age out of cache),
              // which previously caused real wins/losses to be marked as expired.
              const notPlaced = !trade.orderId
                || ["skipped", "rejected", "error"].includes(trade.status);

              const fullShares = this._toNumber(trade.shares, 0);
              const fullUsd    = this._toNumber(trade.sizeUsd, 0);
              const filledShares = notPlaced ? sizeMatched : fullShares;
              const filledUsd    = notPlaced
                ? sizeMatched * this._toNumber(trade.price, 0)
                : fullUsd;
              const pnl = won
                ? parseFloat((filledShares - filledUsd).toFixed(2))
                : parseFloat((-filledUsd).toFixed(2));

              if (trade.resolved !== true) { trade.resolved = true; changed = true; }
              if (trade.won !== won) { trade.won = won; changed = true; }
              if (trade.pnl !== pnl) { trade.pnl = pnl; changed = true; }
              const wasUnfilled = notPlaced && sizeMatched <= 0;
              if (trade.unfilled !== wasUnfilled) { trade.unfilled = wasUnfilled; changed = true; }
              if (trade.executionStatus !== "resolved") { trade.executionStatus = "resolved"; changed = true; }

              if (!wasResolved) {
                const tag = wasUnfilled ? "⏭️ NÃO PREENCHIDA" : (won ? "✅ GANHOU" : "❌ PERDEU");
                console.log(`📊 [PolyTrader] Resultado: ${trade.metadata?.indicator} ${tag} P&L: ${pnl >= 0 ? "+" : ""}$${pnl}`);
              }
            }
          }
        }
      } catch (e) {
        // Per-trade errors are non-fatal
      }

      if (changed) updated++;
    }
    if (updated > 0) this._saveHistory();
    return updated;
  }

  // ── Cancel all open orders ──
  async cancelAll() {
    if (!this.initialized || !this.client || this.dryRun) return false;
    try {
      await this.client.cancelAll();
      console.log("🗑️  [PolyTrader] Todas as ordens canceladas");
      return true;
    } catch (err) {
      console.error(`⚠️  [PolyTrader] Erro ao cancelar: ${err.message}`);
      return false;
    }
  }

  // ── Get current status for dashboard ──
  getStatus() {
    // Cap broadcast payload: copying + sorting the entire orderHistory (often
    // 90k+ entries) on every tick was ~the dominant CPU + GC + bandwidth cost.
    // Frontend dedups by orderId, so once a trade has scrolled past the recent
    // window it does not need to be re-broadcast every second; status changes
    // (resolution/fills) land on the most-recent entries anyway.
    const RECENT_TRADES_LIMIT = 100;
    const tail = this.orderHistory.length > RECENT_TRADES_LIMIT * 2
      ? this.orderHistory.slice(-RECENT_TRADES_LIMIT * 2)
      : this.orderHistory.slice();
    const recentTrades = tail
      .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0))
      .slice(0, RECENT_TRADES_LIMIT);
    return {
      initialized: this.initialized,
      dryRun: this.dryRun,
      maxStake: this.maxStake,
      walletAddress: this.wallet?.address || null,
      usdcBalance: this.usdcBalance,
      lastError: this.lastError,
      recentTrades,
      openOrdersCount: this.openOrders.length,
      totalTradesPlaced: this.orderHistory.length,
      mode: this.dryRun ? "DRY_RUN" : "LIVE"
    };
  }
}
