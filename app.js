(function(){
  // A tree: chair type -> model -> variations. Each variation is one row on the server (category, model, name, ...).
  const $ = s => document.querySelector(s);
  const treeEl = $('#tree'), emptyEl = $('#empty'), stateEl = $('#state'), msgEl = $('#msg'), countEl = $('#count'), fileEl = $('#file'), catsEl = $('#cats');
  const API = 'https://hoowmkrwokdlbfwovvqn.supabase.co/functions/v1/intake';
  const ERR = {toolarge:'התמונה גדולה מדי.', notimage:'לא הצלחתי לקרוא את הקובץ כתמונה. נסה JPG או PNG.', toomany:'אפשר עד 30 תמונות לווריאציה.', full:'הרשימה מלאה. כתוב לניל.'};
  let docs = [], uploading = {}, pendingDel = null, fileTarget = null;
  const failed = []; // upload errors stay on screen until the page is reloaded
  // Text edits: every edit stays in `pending` until the server confirms that exact edit. Nothing is dropped on failure.
  const pending = {}; // key "id|field" -> {id, f, v, t, timer}
  const acked = {};   // key -> {id, f, v, at}: last confirmed edit, guards against an older list response
  let saveFailed = false, retryTimer = null;

  // The secret key comes from the link (#k=...). It is kept in this browser so a bookmark without it still works.
  let K = new URLSearchParams(location.hash.slice(1)).get('k') || '';
  try{ if(K) localStorage.setItem('intake-k', K); else K = localStorage.getItem('intake-k') || ''; }catch(e){}

  function setState(text, kind){ stateEl.textContent = text; stateEl.className = 'pill' + (kind ? ' ' + kind : ''); }
  function note(text){ msgEl.textContent = text; msgEl.hidden = !text; }
  function esc(s){ return String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
  function safeUrl(u){ try{ const x = new URL(u); return /^https?:$/.test(x.protocol) ? x.href : ''; }catch(e){ return ''; } }
  function fixLink(v){ v = v.trim(); return v && !/^[a-z]+:/i.test(v) ? 'https://' + v : v; }
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  // Row/image actions go one at a time. Text saves do not wait behind them (an upload can take long).
  let q = Promise.resolve();
  function call(fields, file){ const p = q.then(() => send(fields, file)); q = p.catch(() => {}); return p; }
  async function send(fields, file, keepalive){
    let body;
    if(file){ body = new FormData(); for(const k in fields) body.append(k, fields[k] ?? ''); body.append('k', K); body.append('file', file, fields.name || 'image.jpg'); }
    else body = JSON.stringify({ ...fields, k: K }); // sent as text/plain: no CORS preflight, works with keepalive
    let j = null; const t0 = performance.now();
    try{ const r = await fetch(API, { method:'POST', body, cache:'no-store', keepalive: !!keepalive }); j = await r.json(); }catch(e){}
    if(!j || !j.ok) throw { code: j && j.error || 'net', t: j && j.t };
    if(j.products){
      docs = j.products;
      // A list read on the server can be older than edits saved meanwhile: re-apply those, then what is still waiting.
      for(const key in acked){ const a = acked[key], d = docs.find(x => x.id === a.id); if(a.at > t0 && d) d[a.f] = a.v; }
      for(const key in pending){ const p = pending[key], d = docs.find(x => x.id === p.id); if(d) d[p.f] = p.v; } // what was typed wins over the server copy
      if(j.who) $('#hi').textContent = 'היי ' + j.who;
    }
    return j;
  }

  // ---------- grouping ----------
  // Groups are fixed ids (cat, mod) from the server, so renaming or clearing a name never splits or merges groups.
  function groups(){
    const cats = [], byCat = {};
    for(const d of docs){
      let c = byCat[d.cat]; if(!c){ c = byCat[d.cat] = { key: d.cat, name: d.category, models: [], byModel: {} }; cats.push(c); }
      let m = c.byModel[d.mod]; if(!m){ m = c.byModel[d.mod] = { key: d.mod, name: d.model, rows: [] }; c.models.push(m); }
      m.rows.push(d);
    }
    return cats;
  }
  function mainOf(m){ return m.rows.find(d => d.main) || m.rows[0]; } // none marked: the first one is the main

  function render(){
    const cats = groups();
    emptyEl.hidden = docs.length > 0;
    const models = cats.reduce((n,c) => n + c.models.length, 0), imgs = docs.reduce((n,d) => n + d.images.length, 0), noImg = docs.filter(d => !d.images.length).length;
    countEl.textContent = docs.length ? `${models} דגמים · ${docs.length} וריאציות · ${imgs} תמונות` + (noImg ? ` · ${noImg} בלי תמונה` : '') : '';
    catsEl.innerHTML = [...new Set(docs.map(d => d.category.trim()).filter(Boolean))].map(c => `<option value="${esc(c)}">`).join('');

    const keepC = new Set(), keepM = new Set(), keepR = new Set();
    cats.forEach((c, ci) => {
      keepC.add(c.key);
      const sec = treeEl.querySelector(`section[data-k="${c.key}"]`) || buildCat(c.key);
      if(treeEl.children[ci] !== sec) treeEl.insertBefore(sec, treeEl.children[ci] || null);
      sec._ids = c.models.flatMap(m => m.rows.map(d => d.id));
      setVal(sec.querySelector('.cat-in'), c.name);
      sec.querySelector('.cat-hint').hidden = !!c.name.trim();
      const box = sec.querySelector('.models');
      c.models.forEach((m, mi) => {
        keepM.add(m.key);
        const card = treeEl.querySelector(`article[data-k="${m.key}"]`) || buildModel(m.key);
        if(box.children[mi] !== card) box.insertBefore(card, box.children[mi] || null);
        card._ids = m.rows.map(d => d.id);
        setVal(card.querySelector('.model-in'), m.name);
        card.querySelector('.model-hint').hidden = !!m.name.trim();
        const main = mainOf(m), vars = card.querySelector('.vars');
        m.rows.forEach((d, i) => {
          keepR.add(d.id);
          const row = treeEl.querySelector(`.var[data-id="${d.id}"]`) || buildRow(d.id);
          if(vars.children[i] !== row) vars.insertBefore(row, vars.children[i] || null);
          fillRow(row, d, d === main, m.rows.length);
        });
      });
    });
    treeEl.querySelectorAll('.var').forEach(r => { if(!keepR.has(r.dataset.id)) r.remove(); });
    treeEl.querySelectorAll('article.model').forEach(a => { if(!keepM.has(a.dataset.k)) a.remove(); });
    treeEl.querySelectorAll('section.cat').forEach(s => { if(!keepC.has(s.dataset.k)) s.remove(); });
  }
  function setVal(inp, v){ if(document.activeElement !== inp) inp.value = v ?? ''; }

  function buildCat(key){
    const sec = document.createElement('section');
    sec.className = 'cat'; sec.dataset.k = key;
    sec.innerHTML = `
      <div class="cat-head">
        <label class="lbl"><span>סוג הכיסא</span><input class="cell cat-in" list="cats" maxlength="120" placeholder="למשל: כיסאות בר"></label>
        <button class="btn add-model" type="button">+ דגם בסוג הזה</button>
        <span class="hint cat-hint">חסר סוג הכיסא</span>
      </div>
      <div class="models"></div>`;
    headerInput(sec.querySelector('.cat-in'), sec, 'category');
    sec.querySelector('.add-model').onclick = () => addRow({ cat: key, category: sec.querySelector('.cat-in').value.trim() }, 'model');
    return sec;
  }
  function buildModel(key){
    const a = document.createElement('article');
    a.className = 'model'; a.dataset.k = key;
    a.innerHTML = `
      <div class="model-head">
        <label class="lbl"><span>דגם</span><input class="cell model-in" maxlength="120" placeholder="שם הדגם"></label>
        <button class="btn add-var" type="button">+ וריאציה</button>
        <span class="hint model-hint">חסר שם הדגם</span>
      </div>
      <div class="var var-head" aria-hidden="true"><span>ראשית</span><span>וריאציה</span><span>קישור לאתר שמוכר אותה</span><span>מחיר מכירה</span><span>תמונות</span><span>הערות</span><span></span></div>
      <div class="vars"></div>`;
    headerInput(a.querySelector('.model-in'), a, 'model');
    a.querySelector('.add-var').onclick = () => {
      const sec = a.closest('section.cat');
      addRow({ cat: sec.dataset.k, category: sec.querySelector('.cat-in').value.trim(), mod: key, model: a.querySelector('.model-in').value.trim() }, 'name');
    };
    return a;
  }
  // A type/model name lives on every variation under it, so editing the header saves it on all of them.
  function headerInput(inp, el, f){
    inp.addEventListener('input', () => { for(const id of el._ids || []){ const d = docs.find(x => x.id === id); if(d) d[f] = inp.value; queueSave(id, f, inp.value); } });
    inp.addEventListener('blur', () => { for(const id of el._ids || []) saveNow(id + '|' + f); render(); });
  }

  function buildRow(id){
    const row = document.createElement('div');
    row.className = 'var'; row.dataset.id = id;
    row.innerHTML = `
      <div class="c-main"><button class="star" type="button" aria-label="וריאציה ראשית">☆</button></div>
      <label data-l="וריאציה"><input class="cell" id="n-${id}" data-f="name" placeholder="צבע, בד, גובה…" maxlength="200" aria-label="שם הווריאציה"></label>
      <label data-l="קישור לאתר שמוכר אותה"><input class="cell ltr" data-f="link" type="url" inputmode="url" placeholder="https://" maxlength="1000" aria-label="קישור לאתר שמוכר אותה">
        <a class="go" target="_blank" rel="noopener noreferrer" hidden>פתיחת הקישור ↗</a></label>
      <label data-l="מחיר מכירה"><div class="price"><span>₪</span><input class="cell" data-f="price" type="text" inputmode="decimal" placeholder="0" maxlength="12" aria-label="מחיר מכירה בשקלים"></div></label>
      <div class="c-img" data-l="תמונות"><div class="imgs"></div></div>
      <label data-l="הערות"><textarea class="cell notes" data-f="notes" rows="1" maxlength="2000" placeholder="מה חשוב שנדע" aria-label="הערות לווריאציה"></textarea></label>
      <div class="c-del"></div>`;
    row.querySelectorAll('[data-f]').forEach(inp => {
      inp.addEventListener('input', () => { queueSave(id, inp.dataset.f, inp.value); if(inp.tagName === 'TEXTAREA') grow(inp); });
      inp.addEventListener('blur', () => saveNow(id + '|' + inp.dataset.f));
    });
    row.querySelector('.star').onclick = () => setMain(id, row.closest('article.model')._ids);
    row.addEventListener('dragover', e => { if(e.dataTransfer && [...e.dataTransfer.types].includes('Files')){ e.preventDefault(); row.querySelector('.drop')?.classList.add('on'); } });
    row.addEventListener('dragleave', () => row.querySelector('.drop')?.classList.remove('on'));
    row.addEventListener('drop', e => { e.preventDefault(); row.querySelector('.drop')?.classList.remove('on'); upload(id, e.dataTransfer.files); });
    return row;
  }
  function grow(t){ t.style.height = 'auto'; t.style.height = Math.min(t.scrollHeight + 2, 240) + 'px'; }

  function fillRow(row, d, isMain, count){
    for(const f of ['name','link','price','notes']){
      const inp = row.querySelector(`[data-f="${f}"]`);
      if(document.activeElement !== inp && !pending[d.id+'|'+f]){ inp.value = d[f] ?? ''; if(f === 'notes') grow(inp); }
    }
    const href = safeUrl(fixLink(d.link || '')), go = row.querySelector('.go');
    go.hidden = !href; if(href) go.href = href;
    const star = row.querySelector('.star');
    star.textContent = isMain ? '★' : '☆';
    star.classList.toggle('on', isMain);
    star.title = isMain ? 'זו הווריאציה הראשית של הדגם' : 'לסמן כווריאציה הראשית';
    star.setAttribute('aria-pressed', isMain);
    row.classList.toggle('is-main', isMain && count > 1);
    renderImgs(row, d);
    renderDel(row, d.id);
  }

  function renderImgs(row, d){
    const box = row.querySelector('.imgs');
    const imgs = d.images || [], up = uploading[d.id] || 0;
    const key = imgs.map(x => x.f).join(',') + '|' + up;
    if(box.dataset.key === key) return;
    box.dataset.key = key;
    box.innerHTML = imgs.map((im, k) => {
      const src = safeUrl(im.url);
      return `<div class="thumb"><a href="${esc(src)}" target="_blank" rel="noopener noreferrer"><img src="${esc(src)}" alt="תמונה ${k+1}" loading="lazy"></a>` +
        `<button class="x" type="button" data-f="${esc(im.f)}" aria-label="הסרת תמונה ${k+1}">✕</button></div>`;
    }).join('') + Array.from({length: up}, () => `<div class="thumb up">מעלה…</div>`).join('') +
      `<button class="drop${imgs.length || up ? '' : ' wide'}" type="button" aria-label="הוספת תמונות">${imgs.length || up ? '+' : '+ תמונה (מומלץ)'}</button>`;
    box.querySelector('.drop').addEventListener('click', () => { fileTarget = d.id; fileEl.value = ''; fileEl.click(); });
    box.querySelectorAll('.x').forEach(b => b.addEventListener('click', () => removeImg(d.id, b.dataset.f)));
  }

  function renderDel(row, id){
    const td = row.querySelector('.c-del');
    const mode = pendingDel === id ? 'ask' : 'btn';
    if(td.dataset.mode === mode) return;
    td.dataset.mode = mode;
    if(mode === 'ask'){
      td.innerHTML = `<div class="ask"><button class="btn" type="button" data-a="yes" style="background:var(--bad-bg);color:var(--bad)">מחיקה</button><button class="btn" type="button" data-a="no">ביטול</button></div>`;
      td.querySelector('[data-a=yes]').onclick = () => removeRow(id);
      td.querySelector('[data-a=no]').onclick = () => { pendingDel = null; render(); };
    } else {
      td.innerHTML = `<button class="del" type="button" aria-label="מחיקת הווריאציה">🗑</button>`;
      td.querySelector('.del').onclick = () => { pendingDel = id; render(); };
    }
  }

  // ---------- saving ----------
  function cleanPrice(v){ return String(v).replace(/[₪,\s]/g, ''); } // "1,500 ₪" -> "1500"; "1500-1800" stays and is refused
  function value(p){ return p.f === 'link' ? fixLink(p.v) : p.f === 'price' ? cleanPrice(p.v) : p.v; }
  function updateState(){
    const ups = Object.values(uploading).some(n => n > 0), n = Object.keys(pending).length;
    if(saveFailed && n) setState('לא נשמר עדיין · מנסה שוב', 'bad');
    else if(n || ups) setState('שומר…');
    else setState('נשמר', 'ok');
  }
  function queueSave(id, f, v){
    const key = id + '|' + f, old = pending[key];
    if(old) clearTimeout(old.timer);
    const p = pending[key] = { id, f, v, t: Date.now() };
    p.timer = setTimeout(() => saveNow(key), 700);
    updateState();
    if(f === 'link'){ const go = treeEl.querySelector(`.var[data-id="${id}"] .go`); const href = safeUrl(fixLink(v)); go.hidden = !href; if(href) go.href = href; }
  }
  async function saveNow(key){
    const p = pending[key]; if(!p || p.sending) return;
    clearTimeout(p.timer); p.sending = true;
    try{
      await send({ action:'update', id:p.id, field:p.f, value:value(p), t:p.t }, null, true);
      p.sending = false;
      if(pending[key] === p){ // nothing newer was typed meanwhile
        delete pending[key];
        const d = docs.find(x => x.id === p.id), v = value(p);
        const dv = p.f === 'price' ? (v === '' ? null : Number(v)) : v;
        if(d) d[p.f] = dv;
        acked[key] = { id: p.id, f: p.f, v: dv, at: performance.now() };
      }
      saveFailed = false; updateState();
      if(pending[key]) saveNow(key);
    }catch(e){
      p.sending = false;
      if(e.code === 'stale' && pending[key] === p){ p.t = Math.max(Date.now(), (Number(e.t) || 0) + 1); return saveNow(key); } // a clock behind: this edit is still the newest one here
      if(['notfound','link','price','field','t','stale'].includes(e.code)){ // retrying will not help
        if(pending[key] === p) delete pending[key];
        if(e.code === 'link') note('הקישור לא תקין. העתק את הקישור המלא מהדפדפן.');
        if(e.code === 'price') note('המחיר לא תקין. כתוב מספר אחד, למשל 1500. טווח או הסבר אפשר לכתוב בהערות.');
        updateState(); return;
      }
      saveFailed = true; updateState();
      clearTimeout(retryTimer); retryTimer = setTimeout(retryAll, 3000);
    }
  }
  function retryAll(){ for(const key in pending) saveNow(key); }
  window.addEventListener('online', retryAll);
  // Leaving the page or switching apps: send everything still waiting right now, with keepalive so it survives the tab closing.
  // The server keeps only the newest edit per field (by time), so sending twice is harmless.
  function flushNow(){
    for(const key in pending){
      const p = pending[key]; clearTimeout(p.timer);
      send({ action:'update', id:p.id, field:p.f, value:value(p), t:p.t }, null, true).catch(() => {});
    }
  }
  document.addEventListener('visibilitychange', () => { if(document.visibilityState === 'hidden') flushNow(); else retryAll(); });
  window.addEventListener('pagehide', flushNow);
  window.addEventListener('beforeunload', e => {
    const busy = Object.values(uploading).some(n => n > 0) || Object.keys(pending).length > 0;
    flushNow();
    if(busy){ e.preventDefault(); e.returnValue = ''; }
  });

  // ---------- actions ----------
  async function addRow(fields, focus){
    document.activeElement?.blur?.(); // Safari does not move focus to a clicked button; a focused name field would hold the redraw
    try{
      const before = new Set(docs.map(d => d.id));
      await call({ action:'add', ...fields }); render(); updateState();
      const fresh = docs.find(d => !before.has(d.id)); if(!fresh) return;
      setTimeout(() => {
        const row = treeEl.querySelector(`.var[data-id="${fresh.id}"]`);
        const el = focus === 'category' ? row?.closest('section.cat').querySelector('.cat-in')
                 : focus === 'model' ? row?.closest('article.model').querySelector('.model-in')
                 : document.getElementById('n-' + fresh.id);
        el?.focus(); el?.scrollIntoView({ block:'center', behavior:'smooth' });
      }, 50);
    }catch(e){ note(ERR[e.code] || 'לא הצלחתי להוסיף. נסה שוב.'); }
  }

  async function setMain(id, ids){
    const d = docs.find(x => x.id === id); if(!d) return;
    for(const x of docs) if(ids.includes(x.id)) x.main = x.id === id; // show it right away
    render();
    try{ await call({ action:'main', id, ids: ids.join(',') }); render(); }
    catch(e){ note('לא הצלחתי לסמן את הווריאציה הראשית. נסה שוב.'); try{ await call({ action:'list' }); }catch(_){} render(); }
  }

  async function removeRow(id){
    pendingDel = null;
    try{
      await call({ action:'delete', id });
      for(const key in pending) if(pending[key].id === id){ clearTimeout(pending[key].timer); delete pending[key]; }
      updateState();
    }
    catch(e){ note('המחיקה לא הצליחה. נסה שוב.'); }
    render();
  }

  // Shrink to max 2000px and re-encode as JPEG in the browser: smaller upload, fixes rotation, drops GPS/EXIF.
  async function toJpeg(f){
    let bmp;
    try{ bmp = await createImageBitmap(f, { imageOrientation:'from-image' }); }
    catch(e){
      bmp = await new Promise((res, rej) => { const u = URL.createObjectURL(f), im = new Image(); im.onload = () => { URL.revokeObjectURL(u); res(im); }; im.onerror = () => { URL.revokeObjectURL(u); rej({ code:'notimage' }); }; im.src = u; });
    }
    const w0 = bmp.width, h0 = bmp.height, s = Math.min(1, 2000 / Math.max(w0, h0));
    const c = document.createElement('canvas'); c.width = Math.round(w0 * s); c.height = Math.round(h0 * s);
    const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height); g.drawImage(bmp, 0, 0, c.width, c.height);
    const blob = await new Promise(res => c.toBlob(res, 'image/jpeg', 0.88));
    if(!blob) throw { code:'notimage' };
    return blob;
  }

  async function upload(id, files){
    const list = [...(files||[])].filter(f => /^image\//.test(f.type) || /\.(jpe?g|png|webp|heic|heif|gif)$/i.test(f.name));
    if(!list.length) return;
    uploading[id] = (uploading[id]||0) + list.length; render(); updateState();
    for(const f of list){
      try{
        if(f.size > 60*1024*1024) throw { code:'toolarge' };
        const jpg = await toJpeg(f);
        for(let n = 0; ; n++){
          try{ await call({ action:'upload', id, name: f.name.replace(/\.[^.]+$/, '') + '.jpg' }, jpg); break; }
          catch(e){ if(n >= 2 || (e.code !== 'net' && e.code !== 'db' && e.code !== 'storage')) throw e; await sleep(2000 * (n + 1)); }
        }
      }catch(e){ failed.push(`${f.name}: ${ERR[e.code] || 'לא עלתה. נסה להעלות אותה שוב.'}`); note(failed.join('\n')); }
      finally{ uploading[id]--; render(); updateState(); }
    }
  }

  async function removeImg(id, f){
    try{ await call({ action:'rmimg', id, f }); render(); }
    catch(e){ note('לא הצלחתי להסיר את התמונה.'); }
  }

  fileEl.addEventListener('change', () => { if(fileTarget) upload(fileTarget, fileEl.files); });
  $('#add').onclick = $('#add2').onclick = () => addRow({}, 'category');

  (async function start(){
    if(!K){ setState('אין גישה', 'bad'); note('הקישור לא שלם. פתח את הקישור המלא שקיבלת מניל.'); return; }
    try{
      await call({ action:'list' });
      setState('מחובר', 'ok');
      $('#add').disabled = $('#add2').disabled = false;
      render();
    }catch(e){
      setState('אין חיבור', 'bad');
      note(e.code === 'auth' ? 'הקישור לא נכון. פתח את הקישור המלא שקיבלת מניל.' : 'לא מצליח לטעון את הרשימה. בדוק את האינטרנט ורענן את הדף.');
    }
  })();
})();
