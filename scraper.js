const https = require("https");
const fs    = require("fs");
const path  = require("path");

function pad(n){ return String(n).padStart(2,"0"); }
function fmtISO(d){ return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`; }
function sleep(ms){ return new Promise(r => setTimeout(r, ms)); }

const API_KEY = process.env.APISPORTS_KEY;
if(!API_KEY){ console.error("❌ APISPORTS_KEY secret λείπει!"); process.exit(1); }

const FLAGS = {
  "Premier League":"🏴󠁧󠁢󠁥󠁮󠁧󠁿","La Liga":"🇪🇸","Bundesliga":"🇩🇪","Serie A":"🇮🇹",
  "Ligue 1":"🇫🇷","Eredivisie":"🇳🇱","Liga Portugal":"🇵🇹","Super Lig":"🇹🇷",
  "Champions League":"🇪🇺","Europa League":"🇪🇺","Conference League":"🇪🇺",
  "MLS":"🇺🇸","Brasileirao":"🇧🇷","Super League":"🇬🇷","Greek":"🇬🇷"
};
function flagFor(l=""){ for(const k in FLAGS) if(l.includes(k)) return FLAGS[k]; return "⚽"; }

function apiRequest(endpoint){
  return new Promise((resolve, reject) => {
    const options = {
      hostname: "v3.football.api-sports.io",
      path: endpoint,
      method: "GET",
      headers: {
        "x-apisports-key": API_KEY,
        "x-rapidapi-host": "v3.football.api-sports.io"
      },
      timeout: 15000
    };
    const req = https.request(options, res => {
      let body = "";
      res.on("data", c => body += c);
      res.on("end", () => {
        try{ resolve(JSON.parse(body)); }
        catch(e){ reject(new Error("JSON parse error")); }
      });
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("Timeout")); });
    req.end();
  });
}

function calcMetrics(stats){
  if(!stats) return null;
  try{
    const played = stats.fixtures?.played?.total || 0;
    if(!played) return null;
    const draws  = stats.fixtures?.draws?.total  || 0;
    const gf     = stats.goals?.for?.total?.total    || 0;
    const ga     = stats.goals?.against?.total?.total|| 0;
    const gpg    = +(gf/played).toFixed(2);
    const gag    = +(ga/played).toFixed(2);
    const exp    = +((gpg+gag)*0.88).toFixed(2);
    const form   = (stats.form||"").slice(-5);
    const drawPct= Math.round(draws/played*100);
    const btts   = Math.round((gpg>0.9&&gag>0.9?0.62:0.38)*100);
    const o25    = exp>2.5?65:exp>2.0?52:38;
    let p01,p23,p4p;
    if(exp<1.4)      {p01=32;p23=48;p4p=20;}
    else if(exp<2.0) {p01=22;p23=52;p4p=26;}
    else if(exp<2.6) {p01=14;p23=54;p4p=32;}
    else if(exp<3.2) {p01=10;p23=48;p4p=42;}
    else             {p01=7; p23=40;p4p=53;}
    return {played,draws,gpg,gag,exp,drawPct,form,btts,o25,p01,p23,p4p};
  } catch(e){ return null; }
}

function mergeMetrics(h,a){
  const s=(x,y,fb)=>x!=null&&y!=null?(x+y)/2:x!=null?x:y!=null?y:fb;
  const hh=h||{}; const aa=a||{};
  return {
    p01:    Math.round(s(hh.p01,aa.p01,18)),
    p23:    Math.round(s(hh.p23,aa.p23,52)),
    p4p:    Math.round(s(hh.p4p,aa.p4p,28)),
    drawPct:Math.round(s(hh.drawPct,aa.drawPct,27)),
    htDraw: Math.round(s(hh.drawPct,aa.drawPct,27)*0.82),
    btts:   Math.round(s(hh.btts,aa.btts,45)),
    o25:    Math.round(s(hh.o25,aa.o25,50)),
    expGoals:+s(hh.exp,aa.exp,2.5).toFixed(2),
    hForm:  hh.form||"",
    aForm:  aa.form||""
  };
}

async function main(){
  const today = fmtISO(new Date());
  const season = new Date().getFullYear();
  console.log(`\n🔍 ScoutCoupon · ${today}`);
  console.log("=".repeat(40));

  // Step 1: Get fixtures
  console.log("\n📅 Βήμα 1: Αντλώ αγώνες...");
 const fix = await apiRequest(`/fixtures?date=${today}&league=1&season=2025`); 
  const fixtures = fix.response || [];
  console.log(`   ✅ ${fixtures.length} αγώνες`);

  if(!fixtures.length){
    saveData(today,[]);
    console.log("   ⚠️ Δεν υπάρχουν αγώνες σήμερα");
    return;
  }

  // Step 2: Team stats (max 15 matches = 30 API calls)
  console.log(`\n📊 Βήμα 2: Στατιστικά ομάδων...`);
  const toProcess = fixtures.slice(0,15);
  const matches = [];

  for(let i=0; i<toProcess.length; i++){
    const f = toProcess[i];
    const league  = f.league?.name||"";
    const leagueId= f.league?.id;
    const home    = f.teams?.home?.name||"";
    const away    = f.teams?.away?.name||"";
    const homeId  = f.teams?.home?.id;
    const awayId  = f.teams?.away?.id;
    const time    = (f.fixture?.date||"").split("T")[1]?.substring(0,5)||"";

    console.log(`   [${i+1}/${toProcess.length}] ${home} vs ${away}`);

    await sleep(300);
    const hRes = await apiRequest(`/teams/statistics?team=${homeId}&league=${leagueId}&season=${season}`);
    await sleep(300);
    const aRes = await apiRequest(`/teams/statistics?team=${awayId}&league=${leagueId}&season=${season}`);

    const hM = calcMetrics(hRes.response);
    const aM = calcMetrics(aRes.response);
    const metrics = mergeMetrics(hM, aM);

    console.log(`      ✅ xG≈${metrics.expGoals} γκολ · Φόρμα H:${metrics.hForm} A:${metrics.aForm}`);

    matches.push({
      league, flag: flagFor(league),
      home, away, time, metrics
    });
  }

  saveData(today, matches);
  console.log(`\n✅ Τέλος! ${matches.length} αγώνες αναλύθηκαν.`);
}

function saveData(date, matches){
  const dir = path.join(__dirname,"data");
  if(!fs.existsSync(dir)) fs.mkdirSync(dir,{recursive:true});
  const payload = { date, generated: new Date().toISOString(), matchCount: matches.length, matches };
  fs.writeFileSync(path.join(dir,`${date}.json`), JSON.stringify(payload,null,2));
  fs.writeFileSync(path.join(dir,"latest.json"),   JSON.stringify(payload,null,2));
  console.log(`\n💾 Αποθηκεύτηκε: data/${date}.json`);
}

main().catch(e => { console.error("💥",e.message); process.exit(1); });
