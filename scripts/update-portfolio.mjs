import fs from 'node:fs/promises';

const OUT = new URL('../portfolio/data/market.json', import.meta.url);
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/126 Safari/537.36';
const STOCKS = [
  { id:'TSM', symbol:'TSM', mode:'USD' }, { id:'TXN', symbol:'TXN', mode:'USD' },
  { id:'GSK', symbol:'GSK.L', mode:'GBp' }, { id:'QCOM', symbol:'QCOM', mode:'USD' },
  { id:'SNPS', symbol:'SNPS', mode:'USD' }, { id:'AVGO', symbol:'AVGO', mode:'USD' },
  { id:'CCJ', symbol:'CCJ', mode:'USD' }
];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const valid = n => Number.isFinite(n) && n > 0;
const round = (n, places=6) => +n.toFixed(places);
const date = t => new Date(t*1000).toISOString().slice(0,10);
const parsePrice = value => {
  const cleaned=String(value ?? '').replace(/[$,]/g,'').trim();
  return cleaned ? Number(cleaned) : NaN;
};
const recent = timestamp => Number.isFinite(timestamp) && timestamp<=Date.now()+300000 && Date.now()-timestamp<4*86400000;
function nasdaqTime(value) {
  const match=String(value ?? '').match(/^(.+) ET$/);
  if (!match) return NaN;
  const approximate=Date.parse(match[1]);
  if (!Number.isFinite(approximate)) return NaN;
  const zone=new Intl.DateTimeFormat('en-US',{timeZone:'America/New_York',timeZoneName:'short'})
    .formatToParts(approximate).find(part=>part.type==='timeZoneName')?.value;
  return Date.parse(`${match[1]} ${zone}`);
}

async function fetchText(url) {
  let error;
  for (let attempt=0; attempt<3; attempt++) {
    try {
      const response = await fetch(url, { headers:{'User-Agent':UA, Accept:'application/json,text/html;q=0.9,*/*;q=0.8'}, signal:AbortSignal.timeout(15000) });
      if (!response.ok) {
        const failure=new Error(`HTTP ${response.status} for ${url}`);
        failure.retryable=response.status===408 || response.status===429 || response.status>=500;
        const retryAfter=response.headers.get('Retry-After');
        const seconds=Number(retryAfter);
        failure.retryAfter=Number.isFinite(seconds) && seconds>=0 ? Math.min(seconds*1000,10000) : 0;
        throw failure;
      }
      return await response.text();
    } catch (e) {
      error=e;
      if (e.retryable===false) break;
      if (attempt<2) await sleep(Math.max(800 * 2**attempt,e.retryAfter || 0));
    }
  }
  throw error;
}
async function fetchJson(url) { return JSON.parse(await fetchText(url)); }
function historicalFx(rates) {
  return new Map(Object.entries(rates || {}).map(([day, value]) => [day, Number(value?.USD)]).filter(([,value]) => valid(value)));
}
function nearestFx(fxByDate, t, fallback) {
  for (let offset=0; offset<=5; offset++) {
    const day=new Date(t*1000-offset*86400000).toISOString().slice(0,10);
    if (fxByDate.has(day)) return fxByDate.get(day);
  }
  return fallback;
}
function convert(value, mode, gbpUsd) {
  return mode==='USD' ? value/gbpUsd : value/100;
}
function mergeHistory(oldRows, newRows) {
  const byDay=new Map();
  for (const row of [...(Array.isArray(oldRows) ? oldRows : []), ...newRows]) {
    if (Number.isFinite(row?.t) && valid(row?.priceGbp)) byDay.set(date(row.t), row);
  }
  return [...byDay.values()].sort((a,b)=>a.t-b.t).slice(-400);
}
async function yahoo(symbol) {
  const path=`/v8/finance/chart/${encodeURIComponent(symbol)}?range=1y&interval=1d&includePrePost=false`;
  let error;
  for (const host of ['query2.finance.yahoo.com','query1.finance.yahoo.com']) {
    try {
      const result=(await fetchJson(`https://${host}${path}`))?.chart?.result?.[0];
      if (!result) throw new Error(`No Yahoo data for ${symbol}`);
      return result;
    } catch (e) { error=e; }
  }
  throw error;
}
async function nasdaq(symbol, start, end) {
  const base=`https://api.nasdaq.com/api/quote/${symbol}`;
  const [info, historical]=await Promise.all([
    fetchJson(`${base}/info?assetclass=stocks`),
    fetchJson(`${base}/historical?assetclass=stocks&fromdate=${start}&todate=${end}&limit=400`)
  ]);
  const primary=info?.data?.primaryData;
  const current=parsePrice(primary?.lastSalePrice);
  const rows=historical?.data?.tradesTable?.rows;
  if (!valid(current) || !Array.isArray(rows) || !rows.length) throw new Error(`Incomplete Nasdaq data for ${symbol}`);
  const series=rows.map(row => {
    const [month,day,year]=String(row.date).split('/').map(Number);
    return { t:Date.UTC(year,month-1,day,21)/1000, native:parsePrice(row.close) };
  }).filter(row => Number.isFinite(row.t) && valid(row.native)).sort((a,b)=>a.t-b.t);
  if (!series.length) throw new Error(`No valid Nasdaq closes for ${symbol}`);
  const change=parsePrice(primary.netChange);
  const quoteTime=nasdaqTime(primary.lastTradeTimestamp);
  if (!recent(quoteTime)) throw new Error(`Stale or invalid Nasdaq quote time for ${symbol}`);
  const lastClose=series.at(-1);
  const earlierClose=date(lastClose.t)===date(quoteTime/1000) ? series.at(-2) : lastClose;
  const previous=Number.isFinite(change) ? current-change : earlierClose?.native;
  const asOf=new Date(quoteTime).toISOString();
  return { current, previous, series, asOf, source:'Nasdaq market data' };
}
async function ftGsk(start, end) {
  const page=await fetchText('https://markets.ft.com/data/equities/tearsheet/summary?s=GSK:LSE');
  const price=page.match(/Price \(GBX\)<\/span><span class="mod-ui-data-list__value">([\d,.]+)/)?.[1];
  const previous=page.match(/Previous close<\/th><td>([\d,.]+)/)?.[1];
  const xid=page.match(/&quot;xid&quot;:&quot;(\d+)&quot;[^>]*&quot;symbol&quot;:&quot;GSK:LSE&quot;/)?.[1];
  if (!valid(parsePrice(price)) || !xid) throw new Error('Incomplete FT GSK quote');
  const url=`https://markets.ft.com/data/equities/ajax/get-historical-prices?startDate=${start.replaceAll('-','%2F')}&endDate=${end.replaceAll('-','%2F')}&symbol=${xid}`;
  const html=(await fetchJson(url))?.html;
  if (typeof html!=='string') throw new Error('Incomplete FT GSK history');
  const series=[...html.matchAll(/<tr>\s*<td[^>]*>\s*<span[^>]*>([^<]+)<\/span>[\s\S]*?<\/td>\s*<td[^>]*>[\s\S]*?<\/td>\s*<td[^>]*>[\s\S]*?<\/td>\s*<td[^>]*>[\s\S]*?<\/td>\s*<td[^>]*>([\d,.]+)<\/td>/g)]
    .map(([,day,close])=>({t:Date.parse(`${day} GMT`)/1000,native:parsePrice(close)}))
    .filter(row=>Number.isFinite(row.t)&&valid(row.native)).sort((a,b)=>a.t-b.t);
  if (!series.length) throw new Error('No valid FT GSK closes');
  const asOf=new Date(series.at(-1).t*1000).toISOString();
  if (!recent(series.at(-1).t*1000)) throw new Error('Stale FT GSK history');
  return {current:parsePrice(price),previous:parsePrice(previous),series,asOf,source:'Financial Times market data'};
}
function yahooData(result, symbol) {
  const meta=result.meta || {};
  const current=Number(meta.regularMarketPrice);
  const previous=Number(meta.chartPreviousClose ?? meta.previousClose);
  const closes=result.indicators?.quote?.[0]?.close || [];
  const series=(result.timestamp || []).map((t,i)=>({t,native:closes[i]})).filter(row=>Number.isFinite(row.t)&&valid(row.native));
  if (!valid(current) || !series.length) throw new Error(`Incomplete Yahoo data for ${symbol}`);
  return { current, previous, series, asOf:meta.regularMarketTime ? new Date(meta.regularMarketTime*1000).toISOString() : new Date().toISOString(), source:'Yahoo Finance market data' };
}
async function fund(previousQuote) {
  const url='https://www.blackrock.com/uk/individual/products/230270/ishares-corporate-bond-index-fund-uk';
  try {
    const html=(await fetchText(url)).replace(/\s+/g,' ');
    if (!html.includes('GB00B7J60R40')) throw new Error('ISIN not found');
    const nav=html.match(/class="navAmount "[\s\S]{0,500}?NAV as of\s*([^<]+)<[\s\S]{0,200}?class="header-nav-data">\s*GBP\s*([\d,.]+)/);
    const priceGbp=parsePrice(nav?.[2]);
    if (!(priceGbp>.5&&priceGbp<2.5)) throw new Error('NAV not parsed');
    const navDate=nav?.[1]?.trim();
    const parts=navDate?.match(/^(\d{1,2})\/([A-Za-z]+)\/(\d{4})$/);
    const month=parts && ['jan','feb','mar','apr','may','jun','jul','aug','sept','oct','nov','dec'].indexOf(parts[2].toLowerCase());
    const marketAsOf=parts && month>=0 ? `${parts[3]}-${String(month+1).padStart(2,'0')}-${parts[1].padStart(2,'0')}` : new Date().toISOString().slice(0,10);
    const previous=previousQuote?.source==='BlackRock daily NAV'
      ? previousQuote.marketAsOf===marketAsOf ? previousQuote.prevCloseGbp : previousQuote.priceGbp : null;
    return { priceGbp, prevCloseGbp:valid(previous)?previous:null, dayPct:valid(previous)?round((priceGbp/previous-1)*100,4):null, source:'BlackRock daily NAV', marketAsOf };
  } catch (e) {
    console.warn('Fund fetch failed:',e.message);
    return valid(previousQuote?.priceGbp) ? previousQuote : null;
  }
}

let previous={quotes:{},history:{}};
try { previous=JSON.parse(await fs.readFile(OUT,'utf8')); } catch (e) { if (e.code!=='ENOENT') throw e; }
const today=new Date().toISOString().slice(0,10);
const start=new Date(Date.now()-370*86400000).toISOString().slice(0,10);
let gbpUsd, fxSource, fxByDate=new Map(), fxCached=false;
try {
  const [latest, historical]=await Promise.all([
    fetchJson('https://api.frankfurter.dev/v1/latest?base=GBP&symbols=USD'),
    fetchJson(`https://api.frankfurter.dev/v1/${start}..${today}?base=GBP&symbols=USD`)
  ]);
  gbpUsd=Number(latest?.rates?.USD);
  fxByDate=historicalFx(historical?.rates);
  if (!valid(gbpUsd) || !fxByDate.size || !recent(Date.parse(`${latest?.date}T00:00:00Z`))) throw new Error('Incomplete or stale Frankfurter FX data');
  fxSource='Frankfurter (ECB reference rates)';
} catch (e) {
  console.warn('Frankfurter FX failed:',e.message);
  try {
    const result=await yahoo('GBPUSD=X');
    gbpUsd=Number(result.meta?.regularMarketPrice ?? result.meta?.previousClose);
    const closes=result.indicators?.quote?.[0]?.close || [];
    fxByDate=new Map((result.timestamp || []).map((t,i)=>[date(t),closes[i]]).filter(([,value])=>valid(value)));
    if (!valid(gbpUsd) || !recent(Number(result.meta?.regularMarketTime)*1000)) throw new Error('Incomplete or stale Yahoo FX data');
    fxSource='Yahoo Finance';
  } catch (fallbackError) {
    console.warn('Yahoo FX failed:',fallbackError.message);
    gbpUsd=Number(previous.fx?.gbpUsd);
    if (!valid(gbpUsd)) throw new Error('No valid GBP/USD rate available');
    fxSource=`${previous.fx.source || 'Previous'} (cached)`;
    fxCached=true;
  }
}
const quotes={}, history={};
for (const stock of STOCKS) {
  let data;
  try {
    if (fxCached && stock.mode==='USD') throw new Error('No current FX rate; retaining previous GBP quote');
    if (stock.mode==='USD') {
      try { data=await nasdaq(stock.symbol,start,today); }
      catch (e) { console.warn(`${stock.id} Nasdaq failed:`,e.message); data=yahooData(await yahoo(stock.symbol),stock.symbol); }
    } else {
      try { data=await ftGsk(start,today); }
      catch (e) { console.warn('GSK FT failed:',e.message); data=yahooData(await yahoo(stock.symbol),stock.symbol); }
    }
    const priceGbp=convert(data.current,stock.mode,gbpUsd);
    const prevCloseGbp=valid(data.previous)?convert(data.previous,stock.mode,gbpUsd):null;
    if (!valid(priceGbp)) throw new Error('Invalid converted price');
    quotes[stock.id]={ priceGbp:round(priceGbp), prevCloseGbp:valid(prevCloseGbp)?round(prevCloseGbp):null,
      dayPct:valid(prevCloseGbp)?round((priceGbp/prevCloseGbp-1)*100,4):null,
      source:data.source, marketAsOf:data.asOf, symbol:stock.symbol, nativeCurrency:stock.mode };
    const rows=data.series.map(({t,native})=>({t,priceGbp:round(convert(native,stock.mode,nearestFx(fxByDate,t,gbpUsd)))})).filter(row=>valid(row.priceGbp));
    history[stock.id]=mergeHistory(previous.history?.[stock.id],rows);
  } catch (e) {
    console.warn(`${stock.id} refresh failed:`,e.message);
    if (valid(previous.quotes?.[stock.id]?.priceGbp)) quotes[stock.id]=previous.quotes[stock.id];
    history[stock.id]=mergeHistory(previous.history?.[stock.id],[]);
  }
}
quotes.MYKAAN=await fund(previous.quotes?.MYKAAN);
history.MYKAAN=mergeHistory(previous.history?.MYKAAN,quotes.MYKAAN?.priceGbp && quotes.MYKAAN.source==='BlackRock daily NAV'
  ? [{t:Date.parse(`${quotes.MYKAAN.marketAsOf}T12:00:00Z`)/1000,priceGbp:quotes.MYKAAN.priceGbp}] : []);
const out={updatedAt:new Date().toISOString(),fx:{gbpUsd:round(gbpUsd),usdGbp:round(1/gbpUsd),source:fxSource},quotes,history};
await fs.writeFile(OUT,JSON.stringify(out,null,2)+'\n');
console.log(`Updated ${Object.values(quotes).filter(Boolean).length} quotes at ${out.updatedAt}`);
