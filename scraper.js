const https = require("https");
const fs    = require("fs");
const path  = require("path");

function pad(n){ return String(n).padStart(2,"0"); }
function fmtISO(d){ return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`; }
function sleep(ms){ return new Promise(r => setTimeout(r, ms)); }

const API_KEY = process.env.APISPORTS_KEY;
if(!API_KEY){ console.error("❌ APISPORTS_KEY secret λείπει!"); process.exit(1); }

const FLAGS = {
  "World Cup":"🌍","FIFA World Cup":"🌍","Premier League":"🏴󠁧󠁢󠁥󠁮󠁧󠁿",
  "La Liga":"🇪🇸","Bundesliga":"🇩🇪","Serie A":"🇮🇹","Ligue 1":"🇫🇷",
  "Champions League":"🇪🇺","Europa League":"🇪🇺","Super League":"🇬🇷",
  "MLS":"🇺🇸","Brasileirao":"🇧🇷","Club World Cup":"🌍"
};
function flagFor(l=""){ for(const k in FLAGS) if(l.includes(k)) return FLAGS[k]; return "⚽"; }

function apiRequest(endpoint){
  return new Promise((resolve,reject)=>{
    const opts = {
      hostname:"v3.football.api-sports.io",
      path:endpoint,
      method:"GET",
      headers:{"x-apisports-key":API_KEY},
      timeout:15000
    };
    const req = https.request(opts, res=>{
      let body="";
      res.on("data",c=>body+=c);
      res.on("end",()=>{ try{ resolve(JSON.parse(body)); }catch(e){ reject(new Error("JSON error")); } });
    });
    req.on("error",reject);
    req.on("timeout",()=>{ req.destroy(); reject(new Error("Timeout")); });
    req.end();
  });
}

// Λίγκες που θέλουμε — World Cup 2026 + μεγάλες λίγκες
const LEAGUES = [
  {id:1,   season:2026, name:"FIFA World Cup 2026"},
  {id:39,  season:2024, name:"Premier League"},
  {id:140, season:2024, name:"La Liga"},
  {id:78,  season:2024, name:"Bundesliga"},
  {id:135, season:2024, name:"Serie A"},
  {id:61,  season:2024, name:"Ligue 1"},
  {id:2,   season:2024, name:"Champions League"},
  {id:3,   season:2024, name:"Europa League"},
  {id:197, season:2024, name:"Super League Greece"},
  {id:253, season:2024, name:"MLS"},
  {id:71,  season:2024, name:"Brasileirao"},
  {id:15,  season:2026, name:"FIFA Club World Cup"},
];

function calcMetrics(stats){
  if(!stats) return null;
  try{
    const played = stats.fixtures?.played?.total||0;
    if(!played) return null;
    const draws = stats.fixtures?.draws?.total||0;
    const gf    = stats.goals?.for?.total?.total||0;
    const ga    = stats.goals?.against?.total?.total||0;
    const gpg   = +(gf/played).toFixed(2);
    const gag   = +(ga/played).toFixed(2);
    const exp   = +((gpg+gag)*0.88).toFixed(2);
    const form  = (stats.form||"").slice(-5);
    let p01,p23,p4p;
    if(exp<1.4)      {p01=32;p23=48;p4p=20;}
    else if(exp<2.0) {p01=22;p23=52;p4p=26;}
    else if(exp<2.6) {p01=14;p23=54;p4p=32;}
    else if(exp<3.2) {p01=10;p23=48;p4p=42;}
    else             {p01=7; p23=40;p4p=53;}
    return {
      gpg,gag,exp,form,
      drawPct:Math.round(draws/played*100),
      btts:Math.round((gpg>0.9&&gag>0.9?62:40)),
      o25:exp>2.5?65:exp>2.0?52:38,
      p01,p23,p4p
    };
  }catch(e){ return null; }
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
  const allFixtures = [];
  const seen = new Set();

  console.log(`\n🔍 ScoutCoupon · ${today}`);
  console.log("=".repeat(40));
  console.log("\n📅 Αντλώ αγώνες...");

  for(const lg of LEAGUES){
    try{
      await sleep(300);
      const r = await apiRequest(`/fixtures?date=${today}&league=${lg.id}&season=${lg.season}`);
      const fixtures = (r.response||[]).filter(f=>{
        const s=(f.fixture?.status?.short||"");
        return !["FT","AET","PEN","CANC","ABD","AWD","WO"].includes(s);
      });
      if(fixtures.length){
        console.log(`   ✅ ${lg.name}: ${fixtures.length} αγώνες`);
        for(const f of fixtures){
          const key=`${f.teams?.home?.name}_${f.teams?.away?.name}`;
          if(!seen.has(key)){ seen.add(key); allFixtures.push({...f, leagueName:lg.name, leagueSeason:lg.season}); }
        }
      }
    }catch(e){ console.log(`   ⚠️ ${lg.name}: ${e.message}`); }
  }

  console.log(`\n   📊 Σύνολο: ${allFixtures.length} αγώνες`);

  if(!allFixtures.length){
    saveData(today,[]);
    console.log("   ⚠️ Δεν βρέθηκαν αγώνες");
    return;
  }

  // Team stats για max 15 αγώνες
  console.log(`\n📈 Στατιστικά (max 15)...`);
  const toProcess = allFixtures.slice(0,15);
  const matches = [];

  for(let i=0; i<toProcess.length; i++){
    const f = toProcess[i];
    const league = f.leagueName||f.league?.name||"";
    const home   = f.teams?.home?.name||"";
    const away   = f.teams?.away?.name||"";
    const time   = (f.fixture?.date||"").split("T")[1]?.substring(0,5)||"";
    const leagueId = f.league?.id;
    const season   = f.leagueSeason;

    console.log(`   [${i+1}/${toProcess.length}] ${home} vs ${away}`);

    await sleep(300);
    const hRes = await apiRequest(`/teams/statistics?team=${f.teams?.home?.id}&league=${leagueId}&season=${season}`);
    await sleep(300);
    const aRes = await apiRequest(`/teams/statistics?team=${f.teams?.away?.id}&league=${leagueId}&season=${season}`);

    const metrics = mergeMetrics(calcMetrics(hRes.response), calcMetrics(aRes.response));
    console.log(`      ✅ Exp:${metrics.expGoals} H:${metrics.hForm} A:${metrics.aForm}`);

    matches.push({ league, flag:flagFor(league), home, away, time, metrics });
  }

  saveData(today, matches);
  console.log(`\n✅ Τέλος! ${matches.length} αγώνες.`);
}

function saveData(date,matches){
  const dir=path.join(__dirname,"data");
  if(!fs.existsSync(dir)) fs.mkdirSync(dir,{recursive:true});
  const payload={date,generated:new Date().toISOString(),matchCount:matches.length,matches};
  fs.writeFileSync(path.join(dir,`${date}.json`),JSON.stringify(payload,null,2));
  fs.writeFileSync(path.join(dir,"latest.json"),JSON.stringify(payload,null,2));
  console.log(`💾 data/${date}.json`);
}

main().catch(e=>{ console.error("💥",e.message); process.exit(1); });
