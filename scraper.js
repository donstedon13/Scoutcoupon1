/**
 * ScoutCoupon Scraper
 * Τρέχει κάθε πρωί μέσω GitHub Actions
 * Αντλεί αγώνες + φόρμα + xG από FBref
 * Αποθηκεύει JSON στο data/YYYY-MM-DD.json
 */

const https = require("https");
const fs    = require("fs");
const path  = require("path");

// ── Helpers ────────────────────────────────────────────────────
function pad(n){ return String(n).padStart(2,"0"); }
function fmtISO(d){ return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`; }
function sleep(ms){ return new Promise(r => setTimeout(r, ms)); }

// ── HTTP fetch (no external deps) ─────────────────────────────
function fetchHTML(url){
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; ScoutCoupon/1.0)",
        "Accept": "text/html,application/xhtml+xml",
        "Accept-Language": "en-US,en;q=0.9"
      },
      timeout: 20000
    }, res => {
      // Follow redirects
      if(res.statusCode >= 300 && res.statusCode < 400 && res.headers.location){
        return fetchHTML(res.headers.location).then(resolve).catch(reject);
      }
      if(res.statusCode !== 200){
        return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      }
      let body = "";
      res.setEncoding("utf8");
      res.on("data", c => body += c);
      res.on("end", () => resolve(body));
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("Timeout")); });
  });
}

// ── League flag map ────────────────────────────────────────────
const FLAGS = {
  "Premier League":"🏴󠁧󠁢󠁥󠁮󠁧󠁿","La Liga":"🇪🇸","Bundesliga":"🇩🇪","Serie A":"🇮🇹",
  "Ligue 1":"🇫🇷","Eredivisie":"🇳🇱","Liga Portugal":"🇵🇹","Super Lig":"🇹🇷",
  "Belgian Pro":"🇧🇪","Scottish Prem":"🏴󠁧󠁢󠁳󠁣󠁴󠁿","Champions League":"🇪🇺",
  "Europa League":"🇪🇺","Conference League":"🇪🇺","Nations League":"🌍",
  "World Cup":"🌍","Copa America":"🌎","Copa Libertadores":"🌎",
  "MLS":"🇺🇸","Brasileirao":"🇧🇷","Primera Division":"🇦🇷","Liga MX":"🇲🇽",
  "Saudi Pro":"🇸🇦","J1 League":"🇯🇵","K League":"🇰🇷","A-League":"🇦🇺",
  "Super League":"🇬🇷","Greek":"🇬🇷"
};
function flagFor(l=""){
  for(const k in FLAGS) if(l.toLowerCase().includes(k.toLowerCase())) return FLAGS[k];
  return l.toLowerCase().includes("cup") ? "🏆" : "⚽";
}

// ── Parse FBref matches page ───────────────────────────────────
function parseMatchesPage(html){
  const matches = [];
  // Extract all sched_ tables via regex (no DOM in Node)
  const tableRx = /<table[^>]+id="sched_[^"]*"[^>]*>([\s\S]*?)<\/table>/gi;
  let tableMatch;

  while((tableMatch = tableRx.exec(html)) !== null){
    const tableHTML = tableMatch[0];

    // Get caption (league name)
    const capMatch = tableHTML.match(/<caption[^>]*>([\s\S]*?)<\/caption>/i);
    let league = "Football";
    if(capMatch){
      league = capMatch[1].replace(/<[^>]+>/g,"").trim()
                          .replace(/\s+/g," ")
                          .split("Scores")[0]
                          .split("Fixtures")[0].trim();
    }
    const flag = flagFor(league);

    // Get rows
    const rowRx = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
    let rowMatch;
    while((rowMatch = rowRx.exec(tableHTML)) !== null){
      const row = rowMatch[1];
      if(row.includes('class="thead"')) continue;

      // Extract data-stat values
      function getStat(stat){
        const rx = new RegExp(`data-stat="${stat}"[^>]*>([\\s\\S]*?)<\\/td>`,"i");
        const m  = row.match(rx);
        if(!m) return "";
        return m[1].replace(/<[^>]+>/g,"").trim();
      }
      function getStatHref(stat){
        const rx = new RegExp(`data-stat="${stat}"[^>]*>[\\s\\S]*?href="([^"]+)"[\\s\\S]*?<\\/td>`,"i");
        const m  = row.match(rx);
        return m ? m[1] : null;
      }

      const home = getStat("home_team") || getStat("squad_h");
      const away = getStat("away_team") || getStat("squad_a");
      if(!home || !away || home.length < 2 || away === home) continue;

      const score = getStat("score") || getStat("result");
      if(/\d/.test(score)) continue; // already played

      const xgH   = parseFloat(getStat("xg")     || getStat("xg_h"))   || null;
      const xgA   = parseFloat(getStat("xg_opp") || getStat("xg_a"))   || null;
      const time  = getStat("time") || getStat("start_time") || "";

      // Try to get team page links for form scraping
      const homeHref = getStatHref("home_team") || getStatHref("squad_h");
      const awayHref = getStatHref("away_team") || getStatHref("squad_a");

      const dup = matches.some(m => m.home===home && m.away===away && m.league===league);
      if(dup) continue;

      matches.push({ league, flag, home, away, time,
                     homeHref, awayHref,
                     xgH, xgA,
                     hScore: null, aScore: null });
    }
  }
  return matches;
}

// ── Parse team page for last-5 form ───────────────────────────
function parseTeamForm(html, teamName){
  // Look for the scores/results table on the team page
  // FBref team pages have a table with id containing "matchlogs" or "scores"
  const results = [];
  const tableRx = /<table[^>]+id="[^"]*(?:matchlogs|scores_and_fixtures)[^"]*"[^>]*>([\s\S]*?)<\/table>/i;
  const tm = html.match(tableRx);
  if(!tm) return null;

  const rowRx = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let row;
  const rows = [];
  while((row = rowRx.exec(tm[1])) !== null){
    if(row[1].includes('class="thead"')) continue;
    rows.push(row[1]);
  }

  // Take last 8 rows (most recent matches)
  const recent = rows.slice(-8);
  for(const r of recent){
    function getStat(stat){
      const rx = new RegExp(`data-stat="${stat}"[^>]*>([\\s\\S]*?)<\\/td>`,"i");
      const m = r.match(rx);
      return m ? m[1].replace(/<[^>]+>/g,"").trim() : "";
    }
    const result = getStat("result"); // W / D / L
    const gf     = parseInt(getStat("goals_for") || getStat("gf")) || 0;
    const ga     = parseInt(getStat("goals_against") || getStat("ga")) || 0;
    const venue  = getStat("venue"); // Home / Away
    const xgf    = parseFloat(getStat("xg_for")   || getStat("xg"))     || null;
    const xga    = parseFloat(getStat("xg_against")|| getStat("xga"))    || null;

    if(!result || !["W","D","L"].includes(result)) continue;
    results.push({ result, gf, ga, venue, xgf, xga });
  }

  if(!results.length) return null;

  // Calculate stats from last 5
  const last5 = results.slice(-5);
  const wins   = last5.filter(r => r.result==="W").length;
  const draws  = last5.filter(r => r.result==="D").length;
  const losses = last5.filter(r => r.result==="L").length;
  const goalsFor  = last5.reduce((s,r) => s+r.gf, 0);
  const goalsAgainst = last5.reduce((s,r) => s+r.ga, 0);
  const xgForAvg  = last5.filter(r=>r.xgf!==null).length ?
    last5.filter(r=>r.xgf!==null).reduce((s,r)=>s+r.xgf,0) /
    last5.filter(r=>r.xgf!==null).length : null;
  const xgAgainstAvg = last5.filter(r=>r.xga!==null).length ?
    last5.filter(r=>r.xga!==null).reduce((s,r)=>s+r.xga,0) /
    last5.filter(r=>r.xga!==null).length : null;

  const bttsCount = last5.filter(r => r.gf>0 && r.ga>0).length;
  const over25    = last5.filter(r => r.gf+r.ga > 2).length;

  return {
    last5: { wins, draws, losses },
    goalsFor:      +(goalsFor/last5.length).toFixed(2),
    goalsAgainst:  +(goalsAgainst/last5.length).toFixed(2),
    xgForAvg:      xgForAvg   !== null ? +xgForAvg.toFixed(2)   : null,
    xgAgainstAvg:  xgAgainstAvg!==null ? +xgAgainstAvg.toFixed(2): null,
    bttsRate:      +(bttsCount/last5.length*100).toFixed(0),
    over25Rate:    +(over25/last5.length*100).toFixed(0),
    formString:    last5.map(r=>r.result).join("")
  };
}

// ── Algorithm: calculate percentages from real data ───────────
const HIGH_SCORING = ["Bundesliga","Premier League","Eredivisie","MLS","Brasileirao","Ligue 1","Saudi Pro","Allsvenskan","Eliteserien","A-League"];
const LOW_SCORING  = ["Serie A","La Liga","Scottish Prem","Super Lig","Greek","Super League","K League"];
const HIGH_DRAW    = ["Serie A","La Liga","Greek","Super League","Belgian Pro","Liga Portugal","Argentine"];
const LOW_DRAW     = ["Bundesliga","Premier League","Champions League","Eredivisie","MLS","Brasileirao"];

function leagueGoalFactor(l=""){
  if(HIGH_SCORING.some(x=>l.includes(x))) return 1;
  if(LOW_SCORING.some(x=>l.includes(x)))  return -1;
  return 0;
}
function leagueDrawFactor(l=""){
  if(HIGH_DRAW.some(x=>l.includes(x))) return 1;
  if(LOW_DRAW.some(x=>l.includes(x)))  return -1;
  return 0;
}
function importanceFactor(l=""){
  if(/champions league|europa league|copa libertadores|world cup|nations league|qualifier/i.test(l)) return 1;
  if(/conference league|copa america|afcon/i.test(l)) return 0.5;
  return 0;
}

function calculateAnalysis(match, homeForm, awayForm){
  const lgF  = leagueGoalFactor(match.league);
  const drF  = leagueDrawFactor(match.league);
  const impF = importanceFactor(match.league);

  // ── xG data (prefer match-level, fallback to team form) ──
  let xgH = match.xgH;
  let xgA = match.xgA;
  if(xgH === null && homeForm?.xgForAvg  !== null) xgH = homeForm.xgForAvg;
  if(xgA === null && awayForm?.xgForAvg  !== null) xgA = awayForm.xgForAvg;
  const totXg = (xgH !== null && xgA !== null) ? xgH + xgA : null;

  // ── Goals scored per game (real data) ──
  const homeGpg = homeForm ? homeForm.goalsFor   : null;
  const awayGpg = awayForm ? awayForm.goalsFor   : null;
  const homeGag = homeForm ? homeForm.goalsAgainst: null;
  const awayGag = awayForm ? awayForm.goalsAgainst: null;

  // Expected goals per game for this match
  let expGoals = null;
  if(homeGpg!==null && awayGpg!==null && homeGag!==null && awayGag!==null){
    expGoals = +((homeGpg + awayGpg + homeGag + awayGag) / 2 * 0.9).toFixed(2);
  } else if(totXg !== null){
    expGoals = totXg;
  }

  // ── BTTS & Over2.5 from real form ──
  const bttsRate  = homeForm && awayForm ? Math.round((homeForm.bttsRate + awayForm.bttsRate)/2) : null;
  const over25Rate= homeForm && awayForm ? Math.round((homeForm.over25Rate+ awayForm.over25Rate)/2): null;

  // ── GOALS distribution ──
  let base01 = 18, base23 = 52, base4p = 28;

  // Real xG adjustment
  if(totXg !== null){
    if(totXg < 1.5)       { base01 += 14; base23 -= 6;  base4p -= 10; }
    else if(totXg < 2.2)  { base01 +=  4; base23 +=  4; base4p -=  4; }
    else if(totXg < 3.0)  { base01 -=  6; base23 +=  7; base4p +=  4; }
    else                   { base01 -= 10; base23 -=  4; base4p += 16; }
  }

  // Real goals-per-game adjustment
  if(expGoals !== null){
    if(expGoals < 1.5)     { base01 += 10; base23 -=  5; base4p -=  8; }
    else if(expGoals < 2.5){ base01 +=  0; base23 +=  5; base4p -=  2; }
    else if(expGoals < 3.5){ base01 -=  5; base23 +=  5; base4p +=  6; }
    else                   { base01 -=  8; base23 -=  2; base4p += 12; }
  }

  // League factor
  base01 += lgF * -6;
  base23 += lgF *  2;
  base4p += lgF *  6;

  // Importance (defensive)
  base01 += impF * 6;
  base4p += impF * -6;

  // Form-based small variance (deterministic from team names)
  const hashStr = match.home + match.away + match.league;
  let hash = 0;
  for(let i=0; i<hashStr.length; i++) hash=((hash<<5)-hash)+hashStr.charCodeAt(i);
  hash = Math.abs(hash);
  base01 += (hash % 7) - 3;
  base23 += ((hash>>4) % 7) - 3;
  base4p += ((hash>>8) % 5) - 2;

  const pct01 = Math.max(8,  Math.min(45, Math.round(base01)));
  const pct23 = Math.max(28, Math.min(68, Math.round(base23)));
  const pct4p = Math.max(5,  Math.min(48, Math.round(base4p)));

  const best01 = pct01>=pct23 && pct01>=pct4p;
  const best23 = pct23>=pct01 && pct23>=pct4p;
  const best4p = pct4p>=pct01 && pct4p>=pct23;

  // Detail strings with real data
  const xgStr  = totXg!==null ? ` · xG ${totXg.toFixed(1)}` : "";
  const gpgStr = expGoals!==null ? ` · Μ.Ο.γκολ ${expGoals}` : "";

  const detail01 = `Αμυντ. αγώνας${xgStr}${gpgStr}`;
  const detail23 = `Πιο πιθανό εύρος${xgStr}${gpgStr}`;
  const detail4p = `Επιθ. ματς${xgStr}${gpgStr}`;

  // ── DRAW analysis ──
  let baseHT = 28, baseFT = 27;
  baseHT += drF * 5;
  baseFT += drF * 5;

  // Form draws
  if(homeForm && awayForm){
    const avgDraws = (homeForm.last5.draws + awayForm.last5.draws) / 2;
    baseHT += (avgDraws - 1) * 5;
    baseFT += (avgDraws - 1) * 5;
  }

  // xG balance → balanced xG = more likely draw
  let xgBal = 0;
  if(xgH!==null && xgA!==null){
    const diff = Math.abs(xgH - xgA);
    if(diff < 0.3)      xgBal = 10;
    else if(diff < 0.7) xgBal =  4;
    else if(diff > 1.4) xgBal = -8;
  }

  baseHT += xgBal * 0.7;
  baseFT += xgBal;
  baseHT += impF * 4;
  baseFT += impF * 4;
  baseHT += ((hash>>6)%7) - 3;
  baseFT += ((hash>>10)%7) - 3;

  const pctHT = Math.max(12, Math.min(52, Math.round(baseHT)));
  const pctFT = Math.max(10, Math.min(50, Math.round(baseFT)));

  // Draw detail
  const formH = homeForm ? `${match.home}: ${homeForm.formString}` : "";
  const formA = awayForm ? `${match.away}: ${awayForm.formString}` : "";
  const xgBalStr = xgBal>4?"Ισορ.xG:ΝΑΙ":xgBal<-4?"Ισορ.xG:ΟΧΙ":"";

  return {
    goals:{
      pct01, pct23, pct4p,
      best01, best23, best4p,
      detail01, detail23, detail4p,
      bttsRate, over25Rate
    },
    draw:{
      ht: pctHT, ft: pctFT,
      htDetail: `${formH} ${xgBalStr}`.trim(),
      ftDetail: `${formA} ${xgBalStr}`.trim()
    },
    meta:{
      expGoals, totXg,
      homeForm: homeForm || null,
      awayForm: awayForm || null,
      dataSource: (homeForm||awayForm) ? "fbref+form" : totXg ? "fbref+xg" : "fbref+league"
    }
  };
}

// ── Main scraper ───────────────────────────────────────────────
async function main(){
  const today  = new Date();
  const isoDate= fmtISO(today);

  console.log(`\n🔍 ScoutCoupon Scraper — ${isoDate}`);
  console.log("=".repeat(45));

  // 1. Get today's matches
  console.log("\n📅 Βήμα 1: Αντλώ αγώνες από FBref...");
  let matchesRaw = [];
  try{
    const html = await fetchHTML(`https://fbref.com/en/matches/${isoDate}`);
    matchesRaw = parseMatchesPage(html);
    console.log(`   ✅ Βρέθηκαν ${matchesRaw.length} αγώνες`);
  } catch(e){
    console.error(`   ❌ FBref error: ${e.message}`);
    process.exit(1);
  }

  if(!matchesRaw.length){
    console.log("   ⚠️ Δεν υπάρχουν αγώνες σήμερα");
    saveData(isoDate, []);
    return;
  }

  // 2. For each match, scrape team form pages
  console.log(`\n📊 Βήμα 2: Αντλώ φόρμα για ${matchesRaw.length} αγώνες...`);
  console.log("   (στάση 1.5s μεταξύ κλήσεων για να μην φάμε ban)\n");

  const DELAY_MS = 1500;
  const formCache = {}; // avoid re-fetching same team

  const matches = [];
  for(let i=0; i<matchesRaw.length; i++){
    const m = matchesRaw[i];
    console.log(`   [${i+1}/${matchesRaw.length}] ${m.home} vs ${m.away} (${m.league})`);

    let homeForm = null, awayForm = null;

    // Home team form
    if(m.homeHref && !formCache[m.homeHref]){
      try{
        await sleep(DELAY_MS);
        const html = await fetchHTML(`https://fbref.com${m.homeHref}`);
        formCache[m.homeHref] = parseTeamForm(html, m.home);
        console.log(`      ✅ ${m.home}: ${formCache[m.homeHref]?.formString || "N/A"}`);
      } catch(e){
        console.log(`      ⚠️ ${m.home}: ${e.message}`);
        formCache[m.homeHref] = null;
      }
    }
    homeForm = m.homeHref ? formCache[m.homeHref] : null;

    // Away team form
    if(m.awayHref && !formCache[m.awayHref]){
      try{
        await sleep(DELAY_MS);
        const html = await fetchHTML(`https://fbref.com${m.awayHref}`);
        formCache[m.awayHref] = parseTeamForm(html, m.away);
        console.log(`      ✅ ${m.away}: ${formCache[m.awayHref]?.formString || "N/A"}`);
      } catch(e){
        console.log(`      ⚠️ ${m.away}: ${e.message}`);
        formCache[m.awayHref] = null;
      }
    }
    awayForm = m.awayHref ? formCache[m.awayHref] : null;

    // Calculate analysis with real data
    const analysis = calculateAnalysis(m, homeForm, awayForm);

    matches.push({
      league:  m.league,
      flag:    m.flag,
      home:    m.home,
      away:    m.away,
      time:    m.time,
      xgH:     m.xgH,
      xgA:     m.xgA,
      hScore:  null,
      aScore:  null,
      analysis
    });
  }

  // 3. Save to JSON
  console.log(`\n💾 Βήμα 3: Αποθήκευση δεδομένων...`);
  saveData(isoDate, matches);

  console.log(`\n✅ Ολοκληρώθηκε! ${matches.length} αγώνες αναλύθηκαν.`);
  console.log(`   Αρχείο: data/${isoDate}.json\n`);
}

function saveData(date, matches){
  const dir = path.join(__dirname, "data");
  if(!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const outPath = path.join(dir, `${date}.json`);
  const payload = {
    date,
    generated: new Date().toISOString(),
    matchCount: matches.length,
    matches
  };
  fs.writeFileSync(outPath, JSON.stringify(payload, null, 2), "utf8");
  console.log(`   ✅ Αποθηκεύτηκε: ${outPath}`);

  // Also write latest.json for easy access
  const latestPath = path.join(dir, "latest.json");
  fs.writeFileSync(latestPath, JSON.stringify(payload, null, 2), "utf8");
  console.log(`   ✅ Αποθηκεύτηκε: data/latest.json`);
}

main().catch(e => {
  console.error("💥 Fatal error:", e);
  process.exit(1);
});
