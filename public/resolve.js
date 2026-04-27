// ── resolve.js ── Resolve Trades Page ──

let selectedSinceSecs = 0;
let allHistory = [];
let currentController = null;

// ── Period selector ──
document.querySelectorAll(".period-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".period-btn").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    selectedSinceSecs = parseInt(btn.dataset.since, 10) || 0;
    loadHistory();
  });
});

// ── Terminal helpers ──
function termLine(text, cls) {
  const body = document.getElementById("terminalBody");
  const span = document.createElement("span");
  span.className = `term-line ${cls}`;
  span.textContent = text;
  body.appendChild(span);
  body.scrollTop = body.scrollHeight;
}

function clearTerminal() {
  const body = document.getElementById("terminalBody");
  body.innerHTML = `<span class="term-placeholder">$ node scripts/resolve-pending-trades.mjs</span>`;
  resetStats();
}

function resetStats() {
  ["statTotal","statUpdated","statSkipped","statFailed","statPnl","statDuration"].forEach(id => {
    document.getElementById(id).textContent = "—";
  });
}

function setJobBadge(state, text) {
  const el = document.getElementById("jobBadge");
  el.className = `job-badge ${state}`;
  el.textContent = text;
}

// ── Run resolve ──
async function runResolve() {
  if (currentController) {
    currentController.abort();
    currentController = null;
  }

  const dryRun      = document.getElementById("optDryRun").checked;
  const reprocessAll = document.getElementById("optReprocessAll").checked;
  const sinceMs     = selectedSinceSecs > 0 ? Date.now() - selectedSinceSecs * 1000 : 0;

  clearTerminal();
  const body = document.getElementById("terminalBody");
  body.innerHTML = "";

  document.getElementById("btnRun").disabled = true;
  setJobBadge("running", "⬤ Executando...");

  const periodLabel = selectedSinceSecs === 0
    ? "todo o histórico"
    : document.querySelector(".period-btn.active")?.textContent ?? "—";

  termLine(`$ resolve-trades --period="${periodLabel}"${dryRun ? " --dry-run" : ""}${reprocessAll ? " --all" : ""}`, "term-info");
  termLine("", "term-info");

  const cursor = document.createElement("span");
  cursor.className = "term-cursor";
  body.appendChild(cursor);

  let totalProcessed = 0;
  let totalUpdated   = 0;
  let totalSkipped   = 0;
  let totalFailed    = 0;
  let totalPnl       = 0;
  const startTs = Date.now();

  currentController = new AbortController();

  try {
    const res = await fetch("/api/resolve-trades", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ since: sinceMs, dryRun, reprocessAll }),
      signal: currentController.signal
    });

    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);

    const reader = res.body.getReader();
    const dec    = new TextDecoder();
    let buf = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });

      const parts = buf.split("\n\n");
      buf = parts.pop();

      for (const part of parts) {
        const line = part.trim();
        if (!line.startsWith("data:")) continue;
        let ev;
        try { ev = JSON.parse(line.slice(5).trim()); } catch { continue; }

        cursor.remove();

        if (ev.type === "info") {
          termLine(ev.msg, "term-info");
        } else if (ev.type === "processing") {
          termLine(ev.msg, "term-processing");
          totalProcessed++;
          document.getElementById("statTotal").textContent = totalProcessed;
        } else if (ev.type === "resolved") {
          const cls = ev.won ? "term-resolved-win" : "term-resolved-loss";
          termLine(ev.msg, cls);
          totalUpdated++;
          totalPnl += ev.pnl ?? 0;
          document.getElementById("statUpdated").textContent = totalUpdated;
          const pnlEl = document.getElementById("statPnl");
          pnlEl.textContent = (totalPnl >= 0 ? "+" : "") + "$" + totalPnl.toFixed(2);
          pnlEl.style.color = totalPnl >= 0 ? "var(--color-up)" : "var(--color-down)";
        } else if (ev.type === "skip") {
          termLine(ev.msg, "term-skip");
          totalSkipped++;
          document.getElementById("statSkipped").textContent = totalSkipped;
        } else if (ev.type === "error") {
          termLine(ev.msg, "term-error");
          if (ev.type !== "done") { totalFailed++; document.getElementById("statFailed").textContent = totalFailed; }
        } else if (ev.type === "done") {
          const dur = ((Date.now() - startTs) / 1000).toFixed(1);
          document.getElementById("statDuration").textContent = `${dur}s`;
          termLine("", "term-info");
          termLine(`─── Concluído em ${dur}s — ${ev.updated} atualizados · ${ev.skipped} pulados · ${ev.failed} erros ───`, "term-done");
          setJobBadge(ev.failed > 0 ? "done-err" : "done-ok", ev.failed > 0 ? `⬤ ${ev.failed} erro(s)` : `⬤ ${ev.updated} resolvidos`);
          loadHistory();
        }

        body.appendChild(cursor);
        body.scrollTop = body.scrollHeight;
      }
    }
  } catch (err) {
    if (err.name !== "AbortError") {
      termLine(`💥 Erro de conexão: ${err.message}`, "term-error");
      setJobBadge("done-err", "⬤ Erro");
    }
  } finally {
    cursor.remove();
    document.getElementById("btnRun").disabled = false;
    currentController = null;
  }
}

// ── Load history table ──
async function loadHistory() {
  const sinceMs = selectedSinceSecs > 0 ? Date.now() - selectedSinceSecs * 1000 : 0;
  try {
    const url = sinceMs > 0 ? `/api/trade-history?since=${sinceMs}` : "/api/trade-history";
    const res  = await fetch(url);
    allHistory = await res.json();
    applyHistoryFilter();
  } catch {
    // silent — table stays as is
  }
}

function isTradeResolved(t) {
  return t?.marketResolved === true || (t?.resolved === true && t?.executionStatus === "resolved");
}

function resolvedPnl(t) {
  const pnl = parseFloat(t?.pnl ?? 0);
  return Number.isFinite(pnl) ? pnl : 0;
}

function applyHistoryFilter() {
  const statusFilter = document.getElementById("filterStatus").value;
  const tfFilter     = document.getElementById("filterTf").value;

  let rows = allHistory;
  if (tfFilter)     rows = rows.filter(t => (t.metadata?.timeframe ?? "") === tfFilter);
  if (statusFilter === "pending") rows = rows.filter(t => !isTradeResolved(t));
  else if (statusFilter === "won")   rows = rows.filter(t => (t.marketResolved && t.won === true) || (!t.marketResolved && isTradeResolved(t) && resolvedPnl(t) >= 0));
  else if (statusFilter === "lost")  rows = rows.filter(t => (t.marketResolved && t.won === false) || (!t.marketResolved && isTradeResolved(t) && resolvedPnl(t) < 0));

  const tbody = document.getElementById("historyBody");

  if (rows.length === 0) {
    tbody.innerHTML = `<tr><td colspan="10" class="table-empty">Nenhum registro no período/filtro selecionado</td></tr>`;
    return;
  }

  tbody.innerHTML = rows
    .slice().reverse() // mais recentes primeiro
    .map(t => {
      const ts    = t.timestamp ? new Date(t.timestamp).toLocaleString("pt-BR") : "—";
      const tf    = t.metadata?.timeframe ?? "—";
      const ind   = t.metadata?.indicator ?? "—";
      const slug  = t.metadata?.marketSlug ?? "—";
      const side  = t.metadata?.direction ?? (t.side ?? "—");
      const price = t.price != null ? `${(t.price * 100).toFixed(1)}¢` : "—";
      const stake = t.sizeUsd != null ? `$${parseFloat(t.sizeUsd).toFixed(2)}` : "—";
      const mode  = t.dryRun ? `<span class="ht-dry">SIM</span>` : "LIVE";

      let resultHtml, pnlHtml;
      if (!isTradeResolved(t)) {
        resultHtml = `<span class="ht-pend">⏳ Pendente</span>`;
        pnlHtml    = `<span class="ht-pend">—</span>`;
      } else if (t.won === true) {
        resultHtml = `<span class="ht-won">✅ Ganhou</span>`;
        const pnl  = parseFloat(t.pnl ?? 0);
        pnlHtml    = `<span class="ht-pnl-pos">+$${pnl.toFixed(2)}</span>`;
      } else if (t.won === false) {
        resultHtml = `<span class="ht-lost">❌ Perdeu</span>`;
        const pnl  = parseFloat(t.pnl ?? 0);
        pnlHtml    = `<span class="ht-pnl-neg">-$${Math.abs(pnl).toFixed(2)}</span>`;
      } else {
        const pnl = resolvedPnl(t);
        resultHtml = `<span class="${pnl >= 0 ? "ht-won" : "ht-lost"}">Fechado</span>`;
        pnlHtml = `<span class="${pnl >= 0 ? "ht-pnl-pos" : "ht-pnl-neg"}">${pnl >= 0 ? "+" : "-"}$${Math.abs(pnl).toFixed(2)}</span>`;
      }

      const sideCls = side === "UP" ? "ht-side-up" : side === "DOWN" ? "ht-side-down" : "";

      return `<tr>
        <td>${ts} ${mode}</td>
        <td>${tf}</td>
        <td>${ind}</td>
        <td style="max-width:200px;overflow:hidden;text-overflow:ellipsis" title="${slug}">${slug}</td>
        <td class="${sideCls}">${side}</td>
        <td>${price}</td>
        <td>${stake}</td>
        <td>${t.status ?? "—"}</td>
        <td>${resultHtml}</td>
        <td>${pnlHtml}</td>
      </tr>`;
    }).join("");
}

// ── Init ──
loadHistory();
