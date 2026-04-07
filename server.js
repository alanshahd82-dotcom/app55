import http from "http";
import https from "https";
import { URL } from "url";
import crypto from "crypto";

const PORT = process.env.PORT || 3000;
const PASSWORD = process.env.RESOLVER_PASSWORD || "";
const COOKIE_NAME = "m3u8_auth";

function makeToken(pass) {
  return crypto.createHash("sha256").update(pass + "m3u8secret").digest("hex");
}

function parseCookies(header) {
  const cookies = {};
  if (!header) return cookies;
  header.split(";").forEach(part => {
    const [k, ...v] = part.trim().split("=");
    cookies[k.trim()] = v.join("=").trim();
  });
  return cookies;
}

function isAuthenticated(req) {
  if (!PASSWORD) return true;
  const cookies = parseCookies(req.headers["cookie"]);
  return cookies[COOKIE_NAME] === makeToken(PASSWORD);
}

// ─── M3U8 Resolver Logic ───────────────────────────────────────────────────

function fetchUrl(rawUrl, redirectCount = 0) {
  return new Promise((resolve, reject) => {
    if (redirectCount > 15) return reject(new Error("Too many redirects"));

    let parsed;
    try { parsed = new URL(rawUrl); } catch (e) { return reject(e); }

    const lib = parsed.protocol === "https:" ? https : http;
    const options = {
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === "https:" ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: "GET",
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36",
        "Accept": "*/*",
      },
      timeout: 15000,
    };

    const req = lib.request(options, (res) => {
      const status = res.statusCode;
      const location = res.headers["location"];

      if (status >= 300 && status < 400 && location) {
        const nextUrl = new URL(location, rawUrl).href;
        return fetchUrl(nextUrl, redirectCount + 1).then(r => {
          r.redirectChain.unshift(rawUrl);
          resolve(r);
        }).catch(reject);
      }

      let body = "";
      res.setEncoding("utf8");
      res.on("data", chunk => body += chunk);
      res.on("end", () => resolve({ finalUrl: rawUrl, redirectChain: [], headers: res.headers, body, status }));
      res.on("error", reject);
    });

    req.on("timeout", () => { req.destroy(); reject(new Error("Request timed out")); });
    req.on("error", reject);
    req.end();
  });
}

function resolveUrl(base, relative) {
  if (relative.startsWith("http://") || relative.startsWith("https://")) return relative;
  try { return new URL(relative, base).href; } catch {
    const parts = base.split("/"); parts.pop();
    return parts.join("/") + "/" + relative;
  }
}

function parseM3U8(content, baseUrl) {
  const lines = content.split("\n").map(l => l.trim()).filter(Boolean);
  const nestedPlaylists = [];
  const mediaSegments = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith("#")) {
      const uriMatch = line.match(/URI="([^"]+)"/);
      if (uriMatch) {
        const uri = resolveUrl(baseUrl, uriMatch[1]);
        (uri.includes(".m3u") ? nestedPlaylists : mediaSegments).push(uri);
      }
      if (line.startsWith("#EXT-X-STREAM-INF")) {
        const next = lines[i + 1];
        if (next && !next.startsWith("#")) {
          nestedPlaylists.push(resolveUrl(baseUrl, next));
          i++;
        }
      }
      continue;
    }
    const resolved = resolveUrl(baseUrl, line);
    (line.includes(".m3u") ? nestedPlaylists : mediaSegments).push(resolved);
  }
  return { nestedPlaylists, mediaSegments };
}

async function resolveM3U8(url, depth = 0, visited = new Set()) {
  if (depth > 10 || visited.has(url)) return [];
  visited.add(url);

  const result = await fetchUrl(url);
  const { nestedPlaylists, mediaSegments } = parseM3U8(result.body, result.finalUrl);

  const sourceServers = new Set();
  for (const seg of mediaSegments) {
    try { sourceServers.add(new URL(seg).origin); } catch {}
  }

  const chain = [{
    url, finalUrl: result.finalUrl, redirectChain: result.redirectChain,
    nestedPlaylists, mediaSegments, totalSegments: mediaSegments.length,
    sourceUrls: [...sourceServers], m3u8Content: result.body,
    responseHeaders: result.headers,
  }];

  for (const nested of nestedPlaylists) {
    chain.push(...await resolveM3U8(nested, depth + 1, visited));
  }
  return chain;
}

// ─── HTML Pages ───────────────────────────────────────────────────────────

const LOGIN_HTML = `<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>تسجيل الدخول</title>
  <style>
    *{margin:0;padding:0;box-sizing:border-box}
    body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#0a0a0f;color:#e0e0e0;min-height:100vh;display:flex;align-items:center;justify-content:center}
    .box{background:#12121a;border:1px solid #2a2a3a;border-radius:16px;padding:40px;width:360px;text-align:center}
    h1{font-size:1.6rem;margin-bottom:6px;background:linear-gradient(135deg,#00d4ff,#7b2ff7);-webkit-background-clip:text;-webkit-text-fill-color:transparent}
    p{color:#888;font-size:.85rem;margin-bottom:28px}
    input{width:100%;padding:13px 16px;border:1px solid #2a2a3a;border-radius:10px;background:#0d0d15;color:#fff;font-size:1rem;margin-bottom:14px;outline:none;direction:ltr;text-align:center;transition:border-color .3s}
    input:focus{border-color:#7b2ff7}
    button{width:100%;padding:13px;border:none;border-radius:10px;background:linear-gradient(135deg,#7b2ff7,#00d4ff);color:#fff;font-size:1rem;font-weight:600;cursor:pointer}
    .err{color:#ff6666;font-size:.85rem;margin-top:10px}
  </style>
</head>
<body>
  <div class="box">
    <h1>M3U8 Resolver</h1>
    <p>أداة خاصة — أدخل كلمة المرور للمتابعة</p>
    <form method="POST" action="/login">
      <input type="password" name="password" placeholder="كلمة المرور" autofocus />
      <button type="submit">دخول</button>
      {{ERROR}}
    </form>
  </div>
</body>
</html>`;

const UI_HTML = `<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>M3U8 Source Resolver</title>
  <style>
    *{margin:0;padding:0;box-sizing:border-box}
    body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#0a0a0f;color:#e0e0e0;min-height:100vh;padding:24px}
    .wrap{max-width:900px;margin:0 auto}
    .header{display:flex;justify-content:space-between;align-items:center;margin-bottom:28px}
    h1{font-size:2rem;background:linear-gradient(135deg,#00d4ff,#7b2ff7);-webkit-background-clip:text;-webkit-text-fill-color:transparent}
    .logout{padding:8px 18px;border:1px solid #2a2a3a;border-radius:8px;background:transparent;color:#888;cursor:pointer;font-size:.85rem;text-decoration:none}
    .logout:hover{color:#fff;border-color:#555}
    .row{display:flex;gap:10px;margin-bottom:20px}
    input{flex:1;padding:14px 18px;border:1px solid #2a2a3a;border-radius:12px;background:#12121a;color:#fff;font-size:1rem;direction:ltr;outline:none;transition:border-color .3s}
    input:focus{border-color:#7b2ff7}
    button{padding:14px 28px;border:none;border-radius:12px;background:linear-gradient(135deg,#7b2ff7,#00d4ff);color:#fff;font-size:1rem;font-weight:600;cursor:pointer;white-space:nowrap}
    button:disabled{opacity:.5;cursor:not-allowed}
    .loading{text-align:center;padding:40px;color:#7b2ff7}
    .card{background:#12121a;border:1px solid #2a2a3a;border-radius:12px;padding:20px;margin-bottom:14px}
    .card-title{font-size:1.1rem;font-weight:600;margin-bottom:12px;color:#00d4ff}
    .url-box{background:#0d1117;border:1px solid #3a3a5a;border-radius:8px;padding:12px 16px;margin:6px 0;direction:ltr;font-family:monospace;font-size:.87rem;word-break:break-all;cursor:pointer;transition:background .2s}
    .url-box:hover{background:#1a1a2e}
    .url-box.green{color:#00ff88}.url-box.blue{color:#00aaff}.url-box.orange{color:#ffaa00}
    .info-row{display:flex;justify-content:space-between;padding:7px 0;border-bottom:1px solid #1a1a2a;font-size:.9rem}
    .info-label{color:#888}.info-val{direction:ltr;color:#e0e0e0}
    .m3u8-pre{background:#0d0d15;border:1px solid #2a2a3a;border-radius:8px;padding:12px;font-family:monospace;font-size:.78rem;color:#aaa;direction:ltr;max-height:280px;overflow-y:auto;white-space:pre-wrap;word-break:break-all;margin-top:8px;display:none}
    .tog{background:#1a1a2e;border:1px solid #3a3a5a;border-radius:6px;color:#888;cursor:pointer;font-size:.78rem;padding:5px 12px;margin-top:8px}
    .tog:hover{color:#fff}
    .err{background:#1a0a0a;border:1px solid #ff3333;border-radius:12px;padding:16px;color:#ff6666;text-align:center}
    .step{border-right:3px solid #7b2ff7;padding-right:14px;margin-bottom:14px}
    .step:last-child{border-right-color:#00d4ff}
    .badge{display:inline-block;padding:3px 10px;border-radius:20px;font-size:.72rem;font-weight:600;margin:2px}
    .b-r{background:#2a1a00;color:#ffaa00}.b-p{background:#0a1a2a;color:#00aaff}.b-s{background:#0a2a1a;color:#00ff88}
    .hint{color:#555;font-size:.72rem;margin-top:3px}
  </style>
</head>
<body>
<div class="wrap">
  <div class="header">
    <h1>M3U8 Source Resolver</h1>
    ${PASSWORD ? '<a class="logout" href="/logout">خروج</a>' : ""}
  </div>
  <div class="row">
    <input id="u" type="text" placeholder="https://example.com/stream/playlist.m3u8" />
    <button id="btn" onclick="go()">تتبع</button>
  </div>
  <div id="out"></div>
</div>
<script>
async function go(){
  const url=document.getElementById('u').value.trim();
  if(!url)return;
  const out=document.getElementById('out'),btn=document.getElementById('btn');
  btn.disabled=true;out.innerHTML='<div class="loading">جاري التتبع...</div>';
  try{
    const r=await fetch('/resolve',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({url})});
    const d=await r.json();
    if(!d.success){out.innerHTML='<div class="err">'+esc(d.error)+'</div>';btn.disabled=false;return;}
    let h='<div>';
    h+='<div class="card"><div class="card-title">الملخص</div>';
    h+='<div class="info-row"><span class="info-label">الرابط المدخل</span><span class="info-val">'+esc(d.inputUrl)+'</span></div>';
    h+='<div class="info-row"><span class="info-label">سيرفرات المصدر</span><span class="info-val">'+d.summary.sourceServers.length+'</span></div>';
    h+='<div class="info-row"><span class="info-label">تحويلات</span><span class="info-val">'+d.summary.totalRedirects+'</span></div>';
    h+='<div class="info-row"><span class="info-label">قوائم متداخلة</span><span class="info-val">'+d.summary.totalNestedPlaylists+'</span></div>';
    h+='<div class="info-row"><span class="info-label">ملفات ميديا</span><span class="info-val">'+d.summary.totalMediaSegments+'</span></div>';
    h+='</div>';
    if(d.summary.sourceServers.length){
      h+='<div class="card"><div class="card-title">المصادر الأصلية</div>';
      d.summary.sourceServers.forEach(s=>h+='<div class="url-box green" onclick="cp(this)">'+esc(s)+'<div class="hint">اضغط للنسخ</div></div>');
      h+='</div>';
    }
    d.chain.forEach((st,i)=>{
      h+='<div class="card step"><div class="card-title">المرحلة '+(i+1)+'</div>';
      h+='<div class="info-row"><span class="info-label">URL</span><span class="info-val">'+esc(st.url)+'</span></div>';
      if(st.finalUrl!==st.url)h+='<div class="info-row"><span class="info-label">Final URL</span><span class="info-val">'+esc(st.finalUrl)+'</span></div>';
      if(st.redirectChain.length){h+='<span class="badge b-r">'+st.redirectChain.length+' redirects</span>';st.redirectChain.forEach(r=>h+='<div class="url-box orange" onclick="cp(this)">'+esc(r)+'</div>');}
      if(st.nestedPlaylists.length){h+='<span class="badge b-p">'+st.nestedPlaylists.length+' playlists</span>';st.nestedPlaylists.forEach(p=>h+='<div class="url-box blue" onclick="cp(this)">'+esc(p)+'</div>');}
      if(st.sourceUrls.length){h+='<br><span class="badge b-s">مصادر</span>';st.sourceUrls.forEach(s=>h+='<div class="url-box green" onclick="cp(this)">'+esc(s)+'<div class="hint">اضغط للنسخ</div></div>');}
      if(st.mediaSegments.length){h+='<span class="badge b-s">'+st.totalSegments+' segments</span>';st.mediaSegments.forEach(s=>h+='<div class="url-box green" onclick="cp(this)" style="font-size:.8rem">'+esc(s)+'</div>');if(st.totalSegments>5)h+='<div style="color:#555;font-size:.78rem;margin-top:4px">... و '+(st.totalSegments-5)+' أخرى</div>';}
      h+='<button class="tog" onclick="tog(this)">عرض M3U8</button><pre class="m3u8-pre">'+esc(st.m3u8Content)+'</pre>';
      h+='</div>';
    });
    h+='</div>';
    out.innerHTML=h;
  }catch(e){out.innerHTML='<div class="err">'+esc(e.message)+'</div>';}
  btn.disabled=false;
}
function cp(el){const t=el.childNodes[0].textContent.trim();navigator.clipboard.writeText(t).then(()=>{const o=el.style.borderColor;el.style.borderColor='#00ff88';setTimeout(()=>el.style.borderColor=o,600);});}
function tog(b){const p=b.nextElementSibling;p.style.display=p.style.display==='none'?'block':'none';b.textContent=p.style.display==='none'?'عرض M3U8':'إخفاء M3U8';}
function esc(s){if(!s)return'';const d=document.createElement('div');d.textContent=s;return d.innerHTML;}
document.addEventListener('DOMContentLoaded',()=>{document.getElementById('u').addEventListener('keydown',e=>{if(e.key==='Enter')go();});});
</script>
</body>
</html>`;

// ─── HTTP Server ───────────────────────────────────────────────────────────

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", c => body += c);
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

function parseForm(body) {
  const params = {};
  body.split("&").forEach(part => {
    const [k, v] = part.split("=");
    params[decodeURIComponent(k)] = decodeURIComponent((v || "").replace(/\+/g, " "));
  });
  return params;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

  // Login POST
  if (req.method === "POST" && url.pathname === "/login") {
    const body = await readBody(req);
    const { password } = parseForm(body);
    if (password === PASSWORD) {
      const token = makeToken(PASSWORD);
      res.writeHead(302, {
        "Set-Cookie": `${COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=2592000`,
        "Location": "/",
      });
      res.end();
    } else {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(LOGIN_HTML.replace("{{ERROR}}", '<p class="err">كلمة المرور غير صحيحة</p>'));
    }
    return;
  }

  // Logout
  if (url.pathname === "/logout") {
    res.writeHead(302, {
      "Set-Cookie": `${COOKIE_NAME}=; Path=/; HttpOnly; Max-Age=0`,
      "Location": "/",
    });
    res.end();
    return;
  }

  // Auth check
  if (!isAuthenticated(req)) {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(LOGIN_HTML.replace("{{ERROR}}", ""));
    return;
  }

  // UI
  if (req.method === "GET" && (url.pathname === "/" || url.pathname === "")) {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(UI_HTML);
    return;
  }

  // Resolve API
  if (req.method === "POST" && url.pathname === "/resolve") {
    try {
      const body = await readBody(req);
      const { url: targetUrl } = JSON.parse(body);
      if (!targetUrl) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: false, error: "url is required" }));
        return;
      }
      console.log(`[${new Date().toISOString()}] Resolving: ${targetUrl}`);
      const chain = await resolveM3U8(targetUrl);
      const allServers = new Set();
      let totalRedirects = 0, totalSegments = 0;
      for (const c of chain) {
        c.sourceUrls.forEach(s => allServers.add(s));
        totalRedirects += c.redirectChain.length;
        totalSegments += c.totalSegments;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        success: true, inputUrl: targetUrl,
        summary: { sourceServers: [...allServers], totalRedirects, totalNestedPlaylists: chain.length - 1, totalMediaSegments: totalSegments },
        chain,
      }));
    } catch (e) {
      console.error(`[ERROR] ${e.message}`);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: false, error: e.message }));
    }
    return;
  }

  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("Not Found");
});

server.listen(PORT, () => {
  console.log(`M3U8 Resolver running on http://localhost:${PORT}${PASSWORD ? " [password protected]" : " [no password]"}`);
});
