const https = require("https");
const fs    = require("fs");
const path  = require("path");

function pad(n){ return String(n).padStart(2,"0"); }
function fmtISO(d){ return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`; }
function sleep(ms){ return new Promise(r => setTimeout(r, ms)); }

const FLAGS = {
  "English Premier League":"🏴󠁧󠁢󠁥󠁮󠁧󠁿","La Liga":"🇪🇸","Bundesliga":"🇩🇪",
  "Serie A":"🇮🇹","Ligue 1":"🇫🇷","Eredivisie":"🇳🇱","Primeira Liga":"🇵🇹",
  "Super Lig":"🇹🇷","Champions League":"🇪🇺","UEFA Champions League":"🇪🇺",
  "Europa League":"🇪🇺","UEFA Europa League":"🇪🇺","Conference League":"🇪🇺",
  "MLS":"🇺🇸","Brasileirao":"🇧🇷","Super League":"🇬🇷","Greek":"🇬🇷",
  "Scottish":"🏴󠁧󠁢󠁳󠁣󠁴󠁿","Belgian":"🇧🇪","Argentine":"🇦🇷","Mexican":"🇲🇽",
  "Saudi":"🇸🇦","Japanese":"🇯🇵","Korean":"🇰🇷","Australian":"🇦🇺",
  "Club World Cup":"🌍","FIFA":"🌍","World Cup":"🌍"
};
function flagFor(l=""){
  for(const k in FLAGS) if(l.includes(k)) return FLAGS[k];
  return l.toLowerCase().includes("cup")?"🏆":"⚽";
}

function apiGet(url){
  return new Promise((resolve,reject)=>{
    https.get(url,{
      headers:{"User-Agent":"ScoutCoupon/1.0"},
      timeout:15000
    },res=>{
      let body="";
      res.on("data",c=>body+=c);
      res.on("end",()=>{
        try{ resolve(JSON.parse(body)); }
        catch(e){ reject(new Error("JSON error")); }
      });
    }).on("error",reject).on("timeout",function(){ this.destroy(); reject(new Error("Timeout")); });
  });
}

// TheSportsDB League IDs (δωρεάν)
const LEAGUES = [
  {id:"4328",name:"English Premier League"},
  {id:"4335",name:"La Liga"},
  {id:"4331",name:"Bundesliga"},
  {id:"4332",name:"Serie A"},
  {id:"4334",name:"Ligue 1"},
  {id:"4337",name:"Eredivisie"},
  {id:"4344",name:"Primeira Liga"},
  {id:"4338",name:"Super Lig"},
  {id:"4346",name:"Scottish Premiership"},
  {id:"4399",name:"Belgian Pro League"},
  {id:"4480",name:"MLS"},
  {id:"4351",name:"Brasileirao"},
  {id:"4406",name:"Argentine Primera"},
  {id:"4443",name:"Super League Greece"},
  {id:"4480",name:"Liga MX"},
  {id:"4356",name:"UEFA Champions League"},
  {id:"4358",name:"UEFA Europa League"},
  {id:"4882",name:"FIFA Club World Cup"},
  {id:"4579",name:"Saudi Pro League"},
  {id:"4395",name:"J1 League"},
  {id:"4341",name:"Primeira Liga"},
  {id:"4347",name:"Championship"},
  {id:"4350",name:"League One"},
];

function calcAnalysis(homeStats, awayStats){
  const safe=(a,b,fb)=>a!=null&&b!=null?(a+b)/2:a!=null?a:b!=null?b:fb;

  const hGpg = homeStats?.gpg || 1.4;
  const aGpg = awayStats?.gpg || 1.2;
  const hGag = homeStats?.gag || 1.2;
  const aGag = awayStats?.gag || 1.2;
  const exp  = +((hGpg+aGpg+hGag+aGag)/2*0.85).toFixed(2);

  let p01,p23,p4p;
  if(exp<1.4)      {p01=32;p23=48;p4p=20;}
  else if(exp<2.0) {p01=22;p23=52;p4p=26;}
  else if(exp<2.6) {p01=14;p23=54;p4p=32;}
  else if(exp<3.2) {p01=10;p23=48;p4p=42;}
  else             {p01=7; p23=40;p4p=53;}

  const hDraw = homeStats?.drawPct || 27;
  const aDraw = awayStats?.drawPct || 27;
  const ftDraw= Math.round((hDraw+aDraw)/2);
  const htDraw= Math.round(ftDraw*0.82);
  const btts  = Math.round((hGpg>0.9&&aGpg>0.9?62:40));
  const o25   = exp>2.5?65:exp>2.0?52:38;

  return {
    p01,p23,p4p,ftDraw,htDraw,btts,o25,exp,
    hForm: homeStats?.form||"",
    aForm: awayStats?.form||""
  };
}

async function getTeamStats(teamId, leagueId){
  try{
    // TheSportsDB team last 5 results
    const url = `https://www.thesportsdb.com/api/v1/json/3/eventslast.php?id=${teamId}`;
    const data = await apiGet(url);
    const events = (data.results||[]).slice(-8);
    if(!events.length) return null;

    let gf=0,ga=0,draws=0,played=0;
    let form="";
    for(const e of events.slice(-5)){
      const hScore = parseInt(e.intHomeScore||0);
      const aScore = parseInt(e.intAwayScore||0);
      const isHome = e.idHomeTeam === String(teamId);
      const myG  = isHome ? hScore : aScore;
      const oppG = isHome ? aScore : hScore;
      gf += myG; ga += oppG; played++;
      if(myG>oppG) form+="W";
      else if(myG===oppG){ form+="D"; draws++; }
      else form+="L";
    }
    if(!played) return null;
    return {
      gpg:+(gf/played).toFixed(2),
      gag:+(ga/played).toFixed(2),
      drawPct:Math.round(draws/played*100),
      form
    };
  }catch(e){ return null; }
}

async function main(){
  const today = fmtISO(new Date());
  console.log(`\n🔍 ScoutCoupon · ${today}`);
  console.log("=".repeat(40));

  const allMatches = [];
  const seenMatches = new Set();

  console.log(`\n📅 Αντλώ αγώνες από TheSportsDB...`);

  for(const league of LEAGUES){
    try{
      await sleep(300);
      const url = `https://www.thesportsdb.com/api/v1/json/3/eventsday.php?d=${today}&s=Soccer&l=${league.id}`;
      const data = await apiGet(url);
      const events = data.events || [];

      for(const e of events){
        const key = `${e.strHomeTeam}_${e.strAwayTeam}`;
        if(seenMatches.has(key)) continue;
        seenMatches.add(key);

        // Only upcoming matches
        const status = (e.strStatus||"").toLowerCase();
        if(status==="finished"||status==="ft"||status==="aet") continue;

        allMatches.push({
          league: e.strLeague||league.name,
          flag: flagFor(e.strLeague||league.name),
          home: e.strHomeTeam||"",
          away: e.strAwayTeam||"",
          time: e.strTime ? e.strTime.substring(0,5) : "",
          homeId: e.idHomeTeam,
          awayId: e.idAwayTeam,
          leagueId: league.id
        });
      }
      if(events.length) console.log(`   ✅ ${league.name}: ${events.length} αγώνες`);
    }catch(e){
      console.log(`   ⚠️ ${league.name}: ${e.message}`);
    }
  }

  console.log(`\n   📊 Σύνολο: ${allMatches.length} αγώνες`);

  if(!allMatches.length){
    saveData(today,[]);
    console.log("   ⚠️ Δεν βρέθηκαν αγώνες");
    return;
  }

  // Get team stats (max 15 matches)
  console.log(`\n📈 Στατιστικά ομάδων (max 15)...`);
  const toProcess = allMatches.slice(0,15);
  const processed = [];

  for(let i=0; i<toProcess.length; i++){
    const m = toProcess[i];
    console.log(`   [${i+1}/${toProcess.length}] ${m.home} vs ${m.away}`);

    await sleep(400);
    const hStats = await getTeamStats(m.homeId, m.leagueId);
    await sleep(400);
    const aStats = await getTeamStats(m.awayId, m.leagueId);

    const analysis = calcAnalysis(hStats, aStats);
    console.log(`      ✅ Exp:${analysis.exp} · H:${analysis.hForm} A:${analysis.aForm}`);

    processed.push({
      league: m.league,
      flag:   m.flag,
      home:   m.home,
      away:   m.away,
      time:   m.time,
      analysis
    });
  }

  saveData(today, processed);
  console.log(`\n✅ Τέλος! ${processed.length} αγώνες αναλύθηκαν.`);
}

function saveData(date, matches){
  const dir = path.join(__dirname,"data");
  if(!fs.existsSync(dir)) fs.mkdirSync(dir,{recursive:true});
  const payload = {date, generated:new Date().toISOString(), matchCount:matches.length, matches};
  fs.writeFileSync(path.join(dir,`${date}.json`), JSON.stringify(payload,null,2));
  fs.writeFileSync(path.join(dir,"latest.json"),   JSON.stringify(payload,null,2));
  console.log(`💾 data/${date}.json`);
}

main().catch(e=>{ console.error("💥",e.message); process.exit(1); });
