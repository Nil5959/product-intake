(function(){
  const $ = s => document.querySelector(s);
  const rowsEl = $('#rows'), emptyEl = $('#empty'), stateEl = $('#state'), msgEl = $('#msg'), countEl = $('#count'), fileEl = $('#file');
  const API = 'https://hoowmkrwokdlbfwovvqn.supabase.co/functions/v1/intake';
  const ERR = {toolarge:'התמונה גדולה מדי.', notimage:'לא הצלחתי לקרוא את הקובץ כתמונה. נסה JPG או PNG.', toomany:'אפשר עד 30 תמונות למוצר.', full:'הרשימה מלאה. כתוב לניל.'};
  let docs = [], uploading = {}, pendingDel = null, fileTarget = null;
  const failed = []; // upload errors stay on screen until the page is reloaded
  // Text edits: every edit stays in `pending` until the server confirms that exact edit. Nothing is dropped on failure.
  const pending = {}; // key "id|field" -> {id, f, v, t, timer}
  let saveFailed = false, retryTimer = null;

  // The secret key comes from the link (#k=...). It is kept in this browser so a bookmark without it still works.
  let K = new URLSearchParams(location.hash.slice(1)).get('k') || '';
  try{ if(K) localStorage.setItem('intake-k', K); else K = localStorage.getItem('intake-k') || ''; }catch(e){}

  function setState(text, kind){ stateEl.textContent = text; stateEl.className = 'pill' + (kind ? ' ' + kind : ''); }
  function note(text){ msgEl.textContent = text; msgEl.hidden = !text; }
  function esc(s){ return String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
  function safeUrl(u){ try{ const x = new URL(u); return /^https?:$/.test(x.protocol) ? x.href : ''; }catch(e){ return ''; } }
  function fixLink(v){ v = v.trim(); return v && !/^[a-z]+:/i.test(v) ? 'https://' + v : v; }

  // One request at a time, so saves land in order.
  // Row/image actions go one at a time. Text saves do not wait behind them (an upload can take long).
  let q = Promise.resolve();
  function call(fields, file){ const p = q.then(() => send(fields, file)); q = p.catch(() => {}); return p; }
  async function send(fields, file, keepalive){
    let body;
    if(file){ body = new FormData(); for(const k in fields) body.append(k, fields[k] ?? ''); body.append('k', K); body.append('file', file, fields.name || 'image.jpg'); }
    else body = JSON.stringify({ ...fields, k: K }); // sent as text/plain: no CORS preflight, works with keepalive
    let r, j = null;
    try{ r = await fetch(API, { method:'POST', body, cache:'no-store', keepalive: !!keepalive }); j = await r.json(); }catch(e){}
    if(!j || !j.ok) throw { code: j && j.error || 'net' };
    if(j.products){ docs = j.products; if(j.who) $('#hi').textContent = 'היי ' + j.who; }
    return j;
  }

  function render(){
    emptyEl.hidden = docs.length > 0;
    const imgCount = docs.reduce((n,d) => n + (d.images||[]).length, 0);
    countEl.textContent = docs.length ? `${docs.length} מוצרים · ${imgCount} תמונות` : '';
    const seen = new Set();
    docs.forEach((d, i) => {
      seen.add(d.id);
      let tr = rowsEl.querySelector(`tr[data-id="${d.id}"]`);
      if(!tr) tr = buildRow(d.id);
      if(rowsEl.children[i] !== tr) rowsEl.insertBefore(tr, rowsEl.children[i] || null);
      tr.querySelector('.num').textContent = i + 1;
      for(const f of ['name','link','price']){
        const inp = tr.querySelector(`[data-f="${f}"]`);
        if(document.activeElement !== inp && !pending[d.id+'|'+f]) inp.value = d[f] ?? '';
      }
      const href = safeUrl(d.link), go = tr.querySelector('.go');
      go.hidden = !href; if(href) go.href = href;
      renderImgs(tr, d);
      renderDel(tr, d.id);
    });
    [...rowsEl.children].forEach(tr => { if(!seen.has(tr.dataset.id)) tr.remove(); });
  }

  function buildRow(id){
    const tr = document.createElement('tr');
    tr.dataset.id = id;
    tr.innerHTML = `
      <td class="num"></td>
      <td data-l="שם המוצר"><input class="cell" id="n-${id}" data-f="name" placeholder="למשל: כיסא אוכל עץ אלון" maxlength="200" aria-label="שם המוצר"></td>
      <td data-l="קישור לאתר שמוכר אותו"><input class="cell ltr" id="l-${id}" data-f="link" type="url" inputmode="url" placeholder="https://" maxlength="1000" aria-label="קישור לאתר שמוכר אותו">
        <a class="go" target="_blank" rel="noopener noreferrer" hidden>פתיחת הקישור ↗</a></td>
      <td class="c-price" data-l="מחיר מכירה"><div class="price"><span>₪</span><input class="cell" id="p-${id}" data-f="price" type="text" inputmode="decimal" placeholder="0" maxlength="12" aria-label="מחיר מכירה בשקלים"></div></td>
      <td class="c-img" data-l="תמונות"><div class="imgs"></div></td>
      <td class="c-del"></td>`;
    tr.querySelectorAll('[data-f]').forEach(inp => {
      inp.addEventListener('input', () => queueSave(id, inp.dataset.f, inp.value));
      inp.addEventListener('blur', () => saveNow(id + '|' + inp.dataset.f));
    });
    tr.addEventListener('dragover', e => { if(e.dataTransfer && [...e.dataTransfer.types].includes('Files')){ e.preventDefault(); tr.querySelector('.drop')?.classList.add('on'); } });
    tr.addEventListener('dragleave', () => tr.querySelector('.drop')?.classList.remove('on'));
    tr.addEventListener('drop', e => { e.preventDefault(); tr.querySelector('.drop')?.classList.remove('on'); upload(id, e.dataTransfer.files); });
    return tr;
  }

  function renderImgs(tr, d){
    const box = tr.querySelector('.imgs');
    const imgs = d.images || [], up = uploading[d.id] || 0;
    const key = imgs.map(x => x.f).join(',') + '|' + up;
    if(box.dataset.key === key) return;
    box.dataset.key = key;
    box.innerHTML = imgs.map((im, k) => {
      const src = safeUrl(im.url);
      return `<div class="thumb"><a href="${esc(src)}" target="_blank" rel="noopener noreferrer"><img src="${esc(src)}" alt="תמונה ${k+1}" loading="lazy"></a>` +
        `<button class="x" type="button" data-f="${esc(im.f)}" aria-label="הסרת תמונה ${k+1}">✕</button></div>`;
    }).join('') + Array.from({length: up}, () => `<div class="thumb up">מעלה…</div>`).join('') +
      `<button class="drop${imgs.length ? '' : ' wide'}" type="button" aria-label="הוספת תמונות">${imgs.length ? '+' : '+ תמונות'}</button>`;
    box.querySelector('.drop').addEventListener('click', () => { fileTarget = d.id; fileEl.value = ''; fileEl.click(); });
    box.querySelectorAll('.x').forEach(b => b.addEventListener('click', () => removeImg(d.id, b.dataset.f)));
  }

  function renderDel(tr, id){
    const td = tr.querySelector('.c-del');
    const mode = pendingDel === id ? 'ask' : 'btn';
    if(td.dataset.mode === mode) return;
    td.dataset.mode = mode;
    if(mode === 'ask'){
      td.innerHTML = `<div class="ask"><button class="btn" type="button" data-a="yes" style="background:var(--bad-bg);color:var(--bad)">מחיקה</button><button class="btn" type="button" data-a="no">ביטול</button></div>`;
      td.querySelector('[data-a=yes]').onclick = () => removeRow(id);
      td.querySelector('[data-a=no]').onclick = () => { pendingDel = null; render(); };
    } else {
      td.innerHTML = `<button class="del" type="button" aria-label="מחיקת המוצר">🗑</button>`;
      td.querySelector('.del').onclick = () => { pendingDel = id; render(); };
    }
  }

  function cleanPrice(v){ return String(v).replace(/[^\d.]/g, ''); } // "1,500 ₪" -> "1500"
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
    if(f === 'link'){ const go = rowsEl.querySelector(`tr[data-id="${id}"] .go`); const href = safeUrl(fixLink(v)); go.hidden = !href; if(href) go.href = href; }
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
        if(d) d[p.f] = p.f === 'price' ? (v === '' ? null : Number(v)) : v;
      }
      saveFailed = false; updateState();
      if(pending[key]) saveNow(key);
    }catch(e){
      p.sending = false;
      if(['notfound','link','price','field','t'].includes(e.code)){ // retrying will not help
        if(pending[key] === p) delete pending[key];
        if(e.code === 'link') note('הקישור לא תקין. העתק את הקישור המלא מהדפדפן.');
        if(e.code === 'price') note('המחיר לא תקין. כתוב רק מספר, למשל 1500.');
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

  async function addRow(){
    try{
      const before = new Set(docs.map(d => d.id));
      await call({ action:'add' }); render(); updateState();
      const fresh = docs.find(d => !before.has(d.id));
      if(fresh) setTimeout(() => document.getElementById('n-' + fresh.id)?.focus(), 50);
    }catch(e){ note(ERR[e.code] || 'לא הצלחתי להוסיף שורה. נסה שוב.'); }
  }

  async function removeRow(id){
    pendingDel = null;
    for(const key in pending) if(pending[key].id === id){ clearTimeout(pending[key].timer); delete pending[key]; }
    try{ await call({ action:'delete', id }); updateState(); }
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
          catch(e){ if(n >= 2 || (e.code !== 'net' && e.code !== 'db' && e.code !== 'storage')) throw e; await new Promise(r => setTimeout(r, 2000 * (n + 1))); }
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
  $('#add').onclick = addRow; $('#add2').onclick = addRow;

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
