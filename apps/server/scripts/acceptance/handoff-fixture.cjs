// The S11 fixture: a page with everything a person might have to do, which reports what it
// sees back here, so a check doesn't need to read the page (a 2fa handoff refuses that).
const http = require("node:http");
const PORT = Number(process.env.FIXTURE_PORT || 18990);
const HOST = process.env.FIXTURE_HOST || "127.0.0.1";
const reports = [];
const hooks = [];

const page = () => `<!doctype html><html><head><meta charset="utf-8"><title>Fixture page</title>
<style>
body{font:18px sans-serif;margin:12px;background:#fff;color:#111}
input,button,select{font-size:18px;margin:4px}
#text{width:420px}
iframe{border:2px solid #36c;width:640px;height:110px;display:block;margin-top:6px}
.tall{height:1400px;background:linear-gradient(#fff,#ccd)}
</style></head><body>
<h1 id="h" style="margin:4px 0;font-size:24px">Handoff fixture page</h1>
<div><input id="text" placeholder="type here"> <button id="btn">Click me</button> <b id="count">0</b></div>
<div><select id="sel"><option>one</option><option>two</option><option>three</option></select>
<button id="alert">alert</button><button id="confirm">confirm</button><button id="prompt">prompt</button>
<button id="popup">popup</button></div>
<div><input id="file" type="file"> <button id="pick">pick by click()</button> <b id="picked">none</b></div>
<iframe id="fr" src="http://localhost:${PORT}/frame"></iframe>
<div class="tall"></div>
<script>
function report(o){o.frame='main';fetch('/report',{method:'POST',body:JSON.stringify(o)}).catch(function(){});}
var t=document.getElementById('text');
addEventListener('keydown',function(e){report({ev:'keydown',key:e.key,code:e.code,trusted:e.isTrusted,target:e.target.id||e.target.tagName});},true);
t.addEventListener('input',function(e){report({ev:'input',value:t.value,trusted:e.isTrusted});});
document.getElementById('btn').addEventListener('click',function(e){var c=document.getElementById('count');c.textContent=String(+c.textContent+1);report({ev:'click',target:'btn',trusted:e.isTrusted,count:+c.textContent,x:e.clientX,y:e.clientY});});
document.getElementById('sel').addEventListener('change',function(e){report({ev:'select',value:e.target.value,trusted:e.isTrusted});});
document.getElementById('alert').onclick=function(){alert('Plain alert message');report({ev:'alert-closed'});};
document.getElementById('confirm').onclick=function(){report({ev:'confirm',result:confirm('Confirm <b>this</b>?')});};
document.getElementById('prompt').onclick=function(){report({ev:'prompt',result:prompt('Your name?','default')});};
document.getElementById('popup').onclick=function(){window.open('/popup','_blank','width=500,height=400');report({ev:'popup-opened'});};
document.getElementById('pick').onclick=function(){document.getElementById('file').click();};
document.getElementById('file').addEventListener('change',function(e){var f=e.target.files[0];document.getElementById('picked').textContent=f?f.name:'none';
  if(!f){report({ev:'file',none:true});return;}f.text().then(function(body){report({ev:'file',name:f.name,size:f.size,body:body.slice(0,64),trusted:e.isTrusted});});});
addEventListener('wheel',function(e){report({ev:'wheel',dy:e.deltaY,trusted:e.isTrusted});},{passive:true,capture:true});
report({ev:'loaded',ua:navigator.userAgent});
</script></body></html>`;

const frame = () => `<!doctype html><html><head><meta charset="utf-8"><title>Frame</title></head><body style="font:16px sans-serif;background:#eef">
<div>Cross-origin frame: <input id="ftext" placeholder="frame input" style="font-size:16px;width:220px"> <button id="fbtn" style="font-size:16px">frame click</button></div>
<script>
function report(o){o.frame='oopif';o.origin=location.origin;fetch('/report',{method:'POST',body:JSON.stringify(o)}).catch(function(){});}
document.getElementById('fbtn').addEventListener('click',function(e){report({ev:'click',target:'fbtn',trusted:e.isTrusted});});
document.getElementById('ftext').addEventListener('input',function(e){report({ev:'input',value:e.target.value,trusted:e.isTrusted});});
['mousedown','mouseup','click','focus','blur','keydown'].forEach(function(n){addEventListener(n,function(e){report({ev:'f-'+n,target:(e.target&&e.target.id)||String(e.target),active:document.activeElement&&(document.activeElement.id||document.activeElement.tagName),hasFocus:document.hasFocus(),defaultPrevented:e.defaultPrevented});},true);});
</script></body></html>`;

const popup = () => `<!doctype html><html><head><meta charset="utf-8"><title>Popup window</title></head><body style="font:18px sans-serif">
<h2>Popup page</h2><input id="ptext" placeholder="popup input" style="font-size:18px"> <button id="pbtn" style="font-size:18px">popup click</button>
<script>
function report(o){o.frame='popup';fetch('/report',{method:'POST',body:JSON.stringify(o)}).catch(function(){});}
document.getElementById('pbtn').addEventListener('click',function(e){report({ev:'click',target:'pbtn',trusted:e.isTrusted});});
document.getElementById('ptext').addEventListener('input',function(e){report({ev:'input',value:e.target.value,trusted:e.isTrusted});});
</script></body></html>`;

http
  .createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    if (req.method === "POST" && url.pathname === "/report") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        try {
          reports.push(JSON.parse(body));
        } catch {}
        res.writeHead(204).end();
      });
      return;
    }
    if (req.method === "POST" && url.pathname === "/hook") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        hooks.push({ url: req.url, headers: req.headers, body: JSON.parse(body) });
        res.writeHead(204).end();
      });
      return;
    }
    if (url.pathname === "/hooks") {
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(hooks));
      return;
    }
    if (url.pathname === "/reports") {
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(reports));
      return;
    }
    if (url.pathname === "/clear") {
      reports.length = 0;
      res.writeHead(204).end();
      return;
    }
    if (url.pathname === "/big") {
      const size = Number(url.searchParams.get("bytes") || 20 * 1024 * 1024);
      res.writeHead(200, {
        "content-type": "application/octet-stream",
        "content-disposition": 'attachment; filename="big <b>.bin"',
        "content-length": String(size),
      });
      res.end(Buffer.alloc(size, 0x61));
      return;
    }
    const body = url.pathname === "/frame" ? frame() : url.pathname === "/popup" ? popup() : page();
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(body);
  })
  .listen(PORT, HOST, () => console.log(`fixture on ${HOST}:${PORT}`));
