const MARKET_URL = './data/market.json';
const PORTFOLIO_KEY = 'hold.portfolio.v1';
const HISTORY_KEY = 'hold.history.v1';
const SELECTED_KEY = 'hold.selected.v1';

const ASSETS = [
  { id: 'TSM', ticker: 'TSM', name: 'Taiwan Semiconductor', type: 'US stock' },
  { id: 'TXN', ticker: 'TXN', name: 'Texas Instruments', type: 'US stock' },
  { id: 'GSK', ticker: 'GSK.L', name: 'GSK plc', type: 'UK stock' },
  { id: 'QCOM', ticker: 'QCOM', name: 'Qualcomm', type: 'US stock' },
  { id: 'SNPS', ticker: 'SNPS', name: 'Synopsys', type: 'US stock' },
  { id: 'MYKAAN', ticker: 'GB00B7J60R40', name: 'iShares Corporate Bond Index D Inc', type: 'UK fund' },
  { id: 'AVGO', ticker: 'AVGO', name: 'Broadcom', type: 'US stock' },
  { id: 'CCJ', ticker: 'CCJ', name: 'Cameco', type: 'US stock' }
];

const EMPTY_PORTFOLIO = Object.fromEntries(ASSETS.map(a => [a.id, { quantity: 0, bookCost: 0 }]));

let market = null;
let portfolio = loadPortfolio();
let portfolioHistory = loadHistory();
let selected = localStorage.getItem(SELECTED_KEY) || 'TSM';
let currentRange = 365;

const els = Object.fromEntries([
  'statusDot','freshness','updatedAt','totalValue','totalPnl','totalPnlPct','bookCost','dayChange','dayChangePct','positionCount','largestPosition',
  'portfolioChart','portfolioChartEmpty','holdingsBody','assetTitle','assetMeta','assetChart','assetChartEmpty','portfolioDialog','portfolioForm','positionEditor',
  'editPortfolioBtn','exportBtn','importFile','toast','portfolioRange'
].map(id => [id, document.getElementById(id)]));

function loadPortfolio() {
  try {
    const parsed = JSON.parse(localStorage.getItem(PORTFOLIO_KEY));
    return parsed ? { ...EMPTY_PORTFOLIO, ...parsed } : structuredClone(EMPTY_PORTFOLIO);
  } catch { return structuredClone(EMPTY_PORTFOLIO); }
}
function loadHistory() {
  try { return JSON.parse(localStorage.getItem(HISTORY_KEY)) || []; }
  catch { return []; }
}
function savePortfolio() { localStorage.setItem(PORTFOLIO_KEY, JSON.stringify(portfolio)); }
function saveHistory() { localStorage.setItem(HISTORY_KEY, JSON.stringify(portfolioHistory.slice(-2500))); }
function gbp(v, digits=2) {
  if (!Number.isFinite(v)) return '£—';
  return new Intl.NumberFormat('en-GB', { style:'currency', currency:'GBP', minimumFractionDigits:digits, maximumFractionDigits:digits }).format(v);
}
function pct(v) { return Number.isFinite(v) ? `${v >= 0 ? '+' : ''}${v.toFixed(2)}%` : '—'; }
function num(v, d=3) { return new Intl.NumberFormat('en-GB', { maximumFractionDigits:d }).format(v || 0); }
function klass(v) { return v > .00001 ? 'positive' : v < -.00001 ? 'negative' : 'neutral'; }
function nowTs() { return Math.floor(Date.now()/1000); }

function getPosition(id) { return portfolio[id] || { quantity:0, bookCost:0 }; }
function quoteFor(id) { return market?.quotes?.[id] || null; }
function valuationFor(id) {
  const p = getPosition(id), q = quoteFor(id);
  return q && Number.isFinite(q.priceGbp) ? p.quantity * q.priceGbp : 0;
}

function importFromHash() {
  const hash = location.hash || '';
  const m = hash.match(/^#import=([A-Za-z0-9_-]+)$/);
  if (!m) return;
  try {
    const padded = m[1].replace(/-/g,'+').replace(/_/g,'/') + '='.repeat((4 - m[1].length % 4) % 4);
    const json = decodeURIComponent(escape(atob(padded)));
    const data = JSON.parse(json);
    if (!data.positions) throw new Error('No positions');
    portfolio = { ...EMPTY_PORTFOLIO, ...data.positions };
    savePortfolio();
    history.replaceState(null, '', location.pathname + location.search);
    showToast('Private portfolio imported to this browser');
  } catch (e) {
    console.error(e);
    showToast('Could not import portfolio link');
  }
}

async function loadMarket() {
  try {
    const res = await fetch(`${MARKET_URL}?v=${Date.now()}`, { cache:'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    market = await res.json();
    updateFreshness();
    recordSnapshot();
    render();
  } catch (e) {
    console.error(e);
    els.freshness.textContent = 'Market feed unavailable';
    els.statusDot.className = 'status-dot stale';
    els.updatedAt.textContent = 'Showing saved portfolio only';
    render();
  }
}

function updateFreshness() {
  const updated = Date.parse(market.updatedAt || '');
  const ageMin = Number.isFinite(updated) ? (Date.now() - updated)/60000 : Infinity;
  els.statusDot.className = `status-dot ${ageMin <= 40 ? 'live' : 'stale'}`;
  els.freshness.textContent = ageMin <= 40 ? 'Market feed current' : 'Market feed delayed';
  els.updatedAt.textContent = Number.isFinite(updated)
    ? `Updated ${new Intl.DateTimeFormat('en-GB',{dateStyle:'medium',timeStyle:'short'}).format(updated)}`
    : 'Update time unknown';
}

function recordSnapshot() {
  if (!market) return;
  const active = ASSETS.filter(a => getPosition(a.id).quantity > 0);
  if (!active.length) return;
  const total = active.reduce((s,a)=>s+valuationFor(a.id),0);
  const book = active.reduce((s,a)=>s+getPosition(a.id).bookCost,0);
  const t = nowTs();
  const last = portfolioHistory.at(-1);
  if (last && t - last.t < 60 * 10) return;
  portfolioHistory.push({ t, value: +total.toFixed(2), book: +book.toFixed(2), pnl: +(total-book).toFixed(2) });
  saveHistory();
}

function portfolioStats() {
  const active = ASSETS.filter(a => getPosition(a.id).quantity > 0);
  const book = active.reduce((s,a)=>s+getPosition(a.id).bookCost,0);
  const total = active.reduce((s,a)=>s+valuationFor(a.id),0);
  const pnl = total - book;
  let prevTotal = 0;
  let hasPrev = false;
  for (const a of active) {
    const p = getPosition(a.id), q = quoteFor(a.id);
    if (q && Number.isFinite(q.prevCloseGbp)) { prevTotal += p.quantity*q.prevCloseGbp; hasPrev = true; }
    else prevTotal += valuationFor(a.id);
  }
  const day = hasPrev ? total - prevTotal : NaN;
  const dayPct = hasPrev && prevTotal ? day/prevTotal*100 : NaN;
  const largest = active.map(a=>({a,value:valuationFor(a.id)})).sort((x,y)=>y.value-x.value)[0];
  return { active, book, total, pnl, pnlPct: book ? pnl/book*100 : NaN, day, dayPct, largest };
}

function render() {
  renderSummary();
  renderHoldings();
  renderPortfolioChart();
  renderAssetChart();
}

function renderSummary() {
  const s = portfolioStats();
  els.totalValue.textContent = gbp(s.total);
  els.bookCost.textContent = gbp(s.book);
  els.totalPnl.textContent = `${s.pnl >= 0 ? '+' : ''}${gbp(s.pnl)}`;
  els.totalPnl.className = klass(s.pnl);
  els.totalPnlPct.textContent = pct(s.pnlPct);
  els.totalPnlPct.className = klass(s.pnlPct);
  els.dayChange.textContent = Number.isFinite(s.day) ? `${s.day >= 0 ? '+' : ''}${gbp(s.day)}` : '£—';
  els.dayChange.className = klass(s.day);
  els.dayChangePct.textContent = pct(s.dayPct);
  els.dayChangePct.className = klass(s.dayPct);
  els.positionCount.textContent = String(s.active.length);
  els.largestPosition.textContent = s.largest ? `Largest: ${s.largest.a.id} · ${s.total ? (s.largest.value/s.total*100).toFixed(1):0}%` : 'No active positions';
}

function renderHoldings() {
  const s = portfolioStats();
  const rows = s.active.length ? s.active : ASSETS;
  els.holdingsBody.innerHTML = rows.map(a => {
    const p = getPosition(a.id), q = quoteFor(a.id), value = valuationFor(a.id), pnl = value - p.bookCost;
    const pnlPct = p.bookCost ? pnl/p.bookCost*100 : NaN;
    const alloc = s.total ? value/s.total*100 : 0;
    const day = q?.dayPct;
    return `<tr data-asset="${a.id}">
      <td><div class="asset-cell"><div class="ticker-badge">${a.id}</div><div class="asset-name"><strong>${a.name}</strong><small>${a.type}</small></div></div></td>
      <td><span class="money">${q ? gbp(q.priceGbp, a.id==='MYKAAN'?4:2) : '£—'}</span><span class="sub">${q?.source || 'No quote'}</span></td>
      <td class="${klass(day)}"><span class="money">${pct(day)}</span></td>
      <td><span class="money">${num(p.quantity,3)}</span><span class="sub">Cost ${gbp(p.bookCost)}</span></td>
      <td><span class="money">${gbp(value)}</span></td>
      <td class="${klass(pnl)}"><span class="money">${p.bookCost ? `${pnl>=0?'+':''}${gbp(pnl)}`:'—'}</span><span class="sub ${klass(pnlPct)}">${p.bookCost?pct(pnlPct):'—'}</span></td>
      <td><div class="allocation"><div class="bar"><span style="width:${Math.max(0,Math.min(100,alloc))}%"></span></div><span>${alloc.toFixed(1)}%</span></div></td>
    </tr>`;
  }).join('');
  els.holdingsBody.querySelectorAll('tr[data-asset]').forEach(tr => tr.addEventListener('click', () => {
    selected = tr.dataset.asset; localStorage.setItem(SELECTED_KEY, selected); renderAssetChart();
  }));
}

function filteredPortfolioHistory() {
  if (currentRange === 'all') return portfolioHistory;
  const cutoff = nowTs() - Number(currentRange)*86400;
  return portfolioHistory.filter(p=>p.t>=cutoff);
}

function renderPortfolioChart() {
  const data = filteredPortfolioHistory();
  els.portfolioChartEmpty.classList.toggle('hidden', data.length >= 2);
  if (data.length < 2) { els.portfolioChart.innerHTML=''; return; }
  drawChart(els.portfolioChart, data.map(p=>({t:p.t,v:p.value})), { currency:true, lineClass: data.at(-1).value >= data[0].value ? 'positive-line' : 'negative-line' });
}

function renderAssetChart() {
  const a = ASSETS.find(x=>x.id===selected) || ASSETS[0];
  const q = quoteFor(a.id);
  els.assetTitle.textContent = `${a.id} · ${a.name}`;
  els.assetMeta.innerHTML = q ? `${gbp(q.priceGbp, a.id==='MYKAAN'?4:2)} · <span class="${klass(q.dayPct)}">${pct(q.dayPct)}</span><br>${q.marketAsOf ? `As of ${q.marketAsOf}` : q.source}` : 'No market quote yet';
  const data = market?.history?.[a.id] || [];
  els.assetChartEmpty.classList.toggle('hidden', data.length >= 2);
  els.assetChartEmpty.textContent = a.id === 'MYKAAN' && data.length < 2 ? 'The fund is valued once daily. Its history will build automatically from tracker updates.' : 'No market history yet.';
  if (data.length < 2) { els.assetChart.innerHTML=''; return; }
  drawChart(els.assetChart, data.map(p=>({t:p.t,v:p.priceGbp})), { currency:true, lineClass: data.at(-1).priceGbp >= data[0].priceGbp ? 'positive-line' : 'negative-line' });
}

function drawChart(svg, data, opts={}) {
  const W=900,H=280,L=54,R=16,T=14,B=30;
  const vals=data.map(d=>d.v).filter(Number.isFinite), times=data.map(d=>d.t);
  let min=Math.min(...vals), max=Math.max(...vals);
  if (max===min) { max+=1; min-=1; }
  const pad=(max-min)*.08; min-=pad; max+=pad;
  const t0=Math.min(...times), t1=Math.max(...times);
  const x=t=>L+(t-t0)/(t1-t0||1)*(W-L-R);
  const y=v=>T+(max-v)/(max-min)*(H-T-B);
  const points=data.map(d=>`${x(d.t).toFixed(1)},${y(d.v).toFixed(1)}`).join(' ');
  const linePath=`M ${points.replace(/ /g,' L ')}`;
  const areaPath=`${linePath} L ${x(data.at(-1).t).toFixed(1)},${H-B} L ${x(data[0].t).toFixed(1)},${H-B} Z`;
  const grid=[];
  for(let i=0;i<4;i++){
    const yy=T+i*(H-T-B)/3, vv=max-i*(max-min)/3;
    grid.push(`<line class="chart-grid" x1="${L}" y1="${yy}" x2="${W-R}" y2="${yy}"/><text class="chart-label" x="0" y="${yy+4}">${opts.currency?shortGbp(vv):vv.toFixed(2)}</text>`);
  }
  const d0=new Date(t0*1000), d1=new Date(t1*1000);
  const dateFmt=new Intl.DateTimeFormat('en-GB',{day:'2-digit',month:'short'});
  const last=data.at(-1);
  svg.innerHTML=`
    <defs><linearGradient id="areaGradient" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#5fa8ff" stop-opacity=".55"/><stop offset="100%" stop-color="#5fa8ff" stop-opacity="0"/></linearGradient></defs>
    ${grid.join('')}
    <path class="chart-fill" d="${areaPath}"/>
    <path class="chart-line ${opts.lineClass||''}" d="${linePath}"/>
    <circle class="chart-dot" cx="${x(last.t)}" cy="${y(last.v)}" r="4"/>
    <text class="chart-label" x="${L}" y="${H-6}">${dateFmt.format(d0)}</text>
    <text class="chart-label" text-anchor="end" x="${W-R}" y="${H-6}">${dateFmt.format(d1)}</text>`;
}
function shortGbp(v){ if(Math.abs(v)>=1000)return `£${(v/1000).toFixed(1)}k`; return `£${v.toFixed(0)}`; }

function buildEditor() {
  els.positionEditor.innerHTML = ASSETS.map(a => {
    const p=getPosition(a.id);
    return `<div class="position-row">
      <div class="pos-title"><strong>${a.id} · ${a.name}</strong><small>${a.type}</small></div>
      <label>Quantity<input inputmode="decimal" data-field="quantity" data-id="${a.id}" value="${p.quantity || ''}" placeholder="0"></label>
      <label>Total book cost (£)<input inputmode="decimal" data-field="bookCost" data-id="${a.id}" value="${p.bookCost || ''}" placeholder="0.00"></label>
    </div>`;
  }).join('');
}

function saveEditor() {
  const next=structuredClone(EMPTY_PORTFOLIO);
  els.positionEditor.querySelectorAll('input[data-id]').forEach(input => {
    const id=input.dataset.id, field=input.dataset.field;
    const value=Number(String(input.value).replace(',','.')) || 0;
    next[id][field]=Math.max(0,value);
  });
  portfolio=next; savePortfolio(); recordSnapshot(); render(); showToast('Portfolio saved privately');
}

function exportPortfolio() {
  const blob=new Blob([JSON.stringify({version:1,positions:portfolio},null,2)],{type:'application/json'});
  const a=document.createElement('a'); a.href=URL.createObjectURL(blob); a.download='hold-private-portfolio.json'; a.click(); URL.revokeObjectURL(a.href);
}
async function importPortfolioFile(file) {
  try {
    const data=JSON.parse(await file.text());
    portfolio={...EMPTY_PORTFOLIO,...(data.positions||data)}; savePortfolio(); buildEditor(); recordSnapshot(); render(); showToast('Private portfolio imported');
  } catch { showToast('Invalid portfolio JSON'); }
}
function showToast(msg){ els.toast.textContent=msg; els.toast.classList.add('show'); clearTimeout(showToast.t); showToast.t=setTimeout(()=>els.toast.classList.remove('show'),2200); }

els.editPortfolioBtn.addEventListener('click',()=>{buildEditor(); els.portfolioDialog.showModal();});
els.portfolioForm.addEventListener('submit',e=>{ if(e.submitter?.value==='cancel') return; e.preventDefault(); saveEditor(); els.portfolioDialog.close(); });
els.exportBtn.addEventListener('click',exportPortfolio);
els.importFile.addEventListener('change',e=>{ const f=e.target.files?.[0]; if(f) importPortfolioFile(f); e.target.value=''; });
els.portfolioRange.addEventListener('click',e=>{ const b=e.target.closest('button[data-range]'); if(!b)return; currentRange=b.dataset.range==='all'?'all':Number(b.dataset.range); els.portfolioRange.querySelectorAll('button').forEach(x=>x.classList.toggle('active',x===b)); renderPortfolioChart(); });

importFromHash();
loadMarket();
setInterval(loadMarket, 60_000);
if (!ASSETS.some(a=>getPosition(a.id).quantity>0)) setTimeout(()=>{buildEditor(); els.portfolioDialog.showModal();},500);
