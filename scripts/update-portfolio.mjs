import fs from 'node:fs/promises';

const OUT = new URL('../portfolio/data/market.json', import.meta.url);
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/126 Safari/537.36';
const YAHOO = 'https://query1.finance.yahoo.com/v8/finance/chart';
const STOCKS = [
  { id:'TSM', symbol:'TSM', mode:'USD' },
  { id:'TXN', symbol:'TXN', mode:'USD' },
  { id:'GSK', symbol:'GSK.L', mode:'GBp' },
  { id:'QCOM', symbol:'QCOM', mode:'USD' },
  { id:'SNPS', symbol:'SNPS', mode:'USD' },
  { id:'AVGO', symbol:'AVGO', mode:'USD' },
  { id:'CCJ', symbol:'CCJ', mode:'USD' }
];

async function retry(fn, tries=3) {
  let err;
  for (let i=0;i<tries;i++) {
    try { return await fn(); } catch(e) { err=e; await new Promise(r=>setTimeout(r, 900*(i+1))); }
  }
  throw err;
}
async function fetchText(url) {
  return retry(async()=>{
    const r=await fetch(url,{headers:{'User-Agent':UA,'Accept':'text/html,application/json;q=0.9,*/*;q=0.8'}});
    if(!r.ok) throw new Error(`${r.status} ${r.statusText} for ${url}`);
    return r.text();
  });
}
async function yahoo(symbol, range='1y', interval='1d') {
  const url=`${YAHOO}/${encodeURIComponent(symbol)}?range=${range}&interval=${interval}&includePrePost=false&events=div%2Csplits`;
  const txt=await fetchText(url);
  const j=JSON.parse(txt); const r=j?.chart?.result?.[0];
  if(!r) throw new Error(`Yahoo returned no data for ${symbol}`);
  return r;
}
function tsDate(t){ return new Date(t*1000).toISOString().slice(0,10); }
function nearestFx(fxByDate, t, fallback) {
  const d=tsDate(t); if(fxByDate.has(d)) return fxByDate.get(d);
  for(let off=1;off<=4;off++){
    const prev=new Date(t*1000-off*86400000).toISOString().slice(0,10);
    if(fxByDate.has(prev)) return fxByDate.get(prev);
  }
  return fallback;
}
function convert(v, mode, gbpUsd) {
  if(!Number.isFinite(v)) return null;
  if(mode==='USD') return v/gbpUsd;
  if(mode==='GBp') return v/100;
  return v;
}

async function fetchBlackRockFund(previousQuote) {
  const url='https://www.blackrock.com/uk/individual/products/230270/ishares-corporate-bond-index-fund-uk';
  try {
    const html=await fetchText(url);
    const flat=html.replace(/\s+/g,' ');
    const isin='GB00B7J60R40';
    const idx=flat.indexOf(isin);
    if(idx<0) throw new Error('ISIN not found');
    const chunk=flat.slice(Math.max(0,idx-3000), idx+300);
    let m=chunk.match(/Class D[\s\S]{0,1200}?GBP[\s\S]{0,300}?([0-9]+\.[0-9]{2,6})[\s\S]{0,1800}?GB00B7J60R40/i);
    if(!m) {
      const nums=[...chunk.matchAll(/>([0-9]+\.[0-9]{2,6})</g)].map(x=>Number(x[1])).filter(x=>x>.5&&x<2.5);
      if(!nums.length) throw new Error('NAV not parsed');
      m=[null,String(nums[0])];
    }
    const priceGbp=Number(m[1]);
    if(!(priceGbp>.5&&priceGbp<2.5)) throw new Error(`Suspicious NAV ${priceGbp}`);
    const prev=previousQuote?.priceGbp;
    return { priceGbp, prevCloseGbp:Number.isFinite(prev)?prev:null, dayPct:Number.isFinite(prev)&&prev ? (priceGbp/prev-1)*100:null, source:'BlackRock daily NAV', marketAsOf:new Date().toISOString().slice(0,10) };
  } catch(e) {
    console.warn('Fund fetch failed:', e.message);
    return previousQuote ? { ...previousQuote, source:`${previousQuote.source || 'Previous'} (fund refresh failed)` } : null;
  }
}

let previous={quotes:{},history:{}};
try { previous=JSON.parse(await fs.readFile(OUT,'utf8')); } catch {}

const fx=await yahoo('GBPUSD=X');
const fxMeta=fx.meta||{};
const gbpUsd=Number(fxMeta.regularMarketPrice || fxMeta.previousClose);
if(!Number.isFinite(gbpUsd)) throw new Error('Could not resolve GBPUSD');
const fxByDate=new Map();
const fxCloses=fx.indicators?.quote?.[0]?.close||[];
(fx.timestamp||[]).forEach((t,i)=>{ const v=fxCloses[i]; if(Number.isFinite(v)) fxByDate.set(tsDate(t),v); });

const quotes={}; const history={};
for(const s of STOCKS) {
  try {
    const r=await yahoo(s.symbol);
    const meta=r.meta||{};
    const currentNative=Number(meta.regularMarketPrice);
    const previousNative=Number(meta.chartPreviousClose ?? meta.previousClose);
    const currentGbp=convert(currentNative,s.mode,gbpUsd);
    const prevGbp=convert(previousNative,s.mode,gbpUsd);
    const quoteSeries=r.indicators?.quote?.[0]?.close||[];
    const hist=[];
    (r.timestamp||[]).forEach((t,i)=>{
      const native=quoteSeries[i]; if(!Number.isFinite(native)) return;
      const fxDay=nearestFx(fxByDate,t,gbpUsd);
      const priceGbp=convert(native,s.mode,fxDay);
      if(Number.isFinite(priceGbp)) hist.push({t,priceGbp:+priceGbp.toFixed(6)});
    });
    quotes[s.id]={
      priceGbp:+currentGbp.toFixed(6),
      prevCloseGbp:Number.isFinite(prevGbp)?+prevGbp.toFixed(6):null,
      dayPct:Number.isFinite(currentGbp)&&Number.isFinite(prevGbp)&&prevGbp ? +((currentGbp/prevGbp-1)*100).toFixed(4):null,
      source:'Yahoo Finance market data',
      marketAsOf:meta.regularMarketTime?new Date(meta.regularMarketTime*1000).toISOString():new Date().toISOString(),
      symbol:s.symbol,
      nativeCurrency:s.mode==='GBp'?'GBp':'USD'
    };
    history[s.id]=hist.slice(-370);
  } catch(e) {
    console.warn(`${s.id} fetch failed:`,e.message);
    if(previous.quotes?.[s.id]) quotes[s.id]={...previous.quotes[s.id],source:`${previous.quotes[s.id].source || 'Previous'} (refresh failed)`};
    history[s.id]=previous.history?.[s.id]||[];
  }
}

quotes.MYKAAN=await fetchBlackRockFund(previous.quotes?.MYKAAN);
const oldFundHist=Array.isArray(previous.history?.MYKAAN)?previous.history.MYKAAN:[];
history.MYKAAN=[...oldFundHist];
if(quotes.MYKAAN?.priceGbp){
  const t=Math.floor(Date.now()/1000); const d=tsDate(t);
  const last=history.MYKAAN.at(-1);
  if(last && tsDate(last.t)===d) history.MYKAAN[history.MYKAAN.length-1]={t,priceGbp:quotes.MYKAAN.priceGbp};
  else history.MYKAAN.push({t,priceGbp:quotes.MYKAAN.priceGbp});
  history.MYKAAN=history.MYKAAN.slice(-400);
}

const out={
  updatedAt:new Date().toISOString(),
  fx:{gbpUsd:+gbpUsd.toFixed(6),usdGbp:+(1/gbpUsd).toFixed(6),source:'Yahoo Finance'},
  quotes,
  history
};
await fs.writeFile(OUT, JSON.stringify(out,null,2)+'\n');
console.log(`Updated ${Object.keys(quotes).length} quotes at ${out.updatedAt}`);
