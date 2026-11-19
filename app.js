(function(){
  const $ = s => document.querySelector(s);
  const rowsEl = $('#rows'), emptyEl = $('#empty'), stateEl = $('#state'), msgEl = $('#msg'), countEl = $('#count'), fileEl = $('#file');
  const API = 'https://hoowmkrwokdlbfwovvqn.supabase.co/functions/v1/intake';
  const ERR = {toolarge:'התמונה גדולה מדי.', notimage:'לא הצלחתי לקרוא את הקובץ כתמונה. נסה JPG או PNG.', toomany:'אפשר עד 30 תמונות למוצר.', full:'הרשימה מלאה. כתוב לניל.'};
  let docs = [], uploading = {}, pendingDel = null, fileTarget = null;
  const timers = {}; // key id|field -> {id, f, v, t}

  // The secret key comes from the link (#k=...). It is kept in this browser so a bookmark without it still works.
  let K = new URLSearchParams(location.hash.slice(1)).get('k') || '';
  try{ if(K) localStorage.setItem('intake-k', K); else K = localStorage.getItem('intake-k') || ''; }catch(e){}

  function setState(text, kind){ stateEl.textContent = text; stateEl.className = 'pill' + (kind ? ' ' + kind : ''); }
  function note(text){ msgEl.textContent = text; msgEl.hidden = !text; }
  function esc(s){ return String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
  function safeUrl(u){ try{ const x = new URL(u); return /^https?:$/.test(x.protocol) ? x.href : ''; }catch(e){ return ''; } }
  function fixLink(v){ v = v.trim(); return v && !/^[a-z]+:/i.test(v) ? 'https://' + v : v; }

  // One request at a time, so saves land in order.
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
        if(document.activeElement !== inp && !timers[d.id+'|'+f]) inp.value = d[f] ?? '';
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
      <td class="c-price" data-l="מחיר מכירה"><div class="price"><span>₪</span><input class="cell" id="p-${id}" data-f="price" type="number" inputmode="decimal" min="0" step="1" placeholder="0" aria-label="מחיר מכירה בשקלים"></div></td>
      <td class="c-img" data-l="תמונות"><div class="imgs"></div></td>
      <td class="c-del"></td>`;
    tr.querySelectorAll('[data-f]').forEach(inp => {
      inp.addEventListener('input', () => queueSave(id, inp.dataset.f, inp.value));
      inp.addEventListener('blur', () => flush(id + '|' + inp.dataset.f));
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

  function queueSave(id, f, v){
    setState('שומר…');
    const key = id + '|' + f;
    clearTimeout(timers[key]?.t);
    timers[key] = { id, f, v, t: setTimeout(() => flush(key), 700) };
    if(f === 'link'){ const go = rowsEl.querySelector(`tr[data-id="${id}"] .go`); const href = safeUrl(fixLink(v)); go.hidden = !href; if(href) go.href = href; }
  }
  function body(p){ return { action:'update', id:p.id, field:p.f, value: p.f === 'link' ? fixLink(p.v) : p.v }; }
  async function flush(key){
    const p = timers[key]; if(!p) return;
    clearTimeout(p.t); delete timers[key];
    try{
      await call(body(p));
      const d = docs.find(x => x.id === p.id); if(d) d[p.f] = p.f === 'price' ? (p.v === '' ? null : Number(p.v)) : body(p).value;
      if(!Object.keys(timers).length) setState('נשמר', 'ok');
      note(''); render();
    }catch(e){ setState('לא נשמר', 'bad'); note('השינוי לא נשמר. בדוק שיש אינטרנט וכתוב שוב.'); }
  }
  // Leaving the page or switching apps: send what is still waiting right away, with keepalive so it survives the tab closing.
  function flushNow(){
    for(const key in timers){ const p = timers[key]; clearTimeout(p.t); delete timers[key]; send(body(p), null, true).catch(() => {}); }
  }
  document.addEventListener('visibilitychange', () => { if(document.visibilityState === 'hidden') flushNow(); });
  window.addEventListener('pagehide', flushNow);
  window.addEventListener('beforeunload', e => {
    const busy = Object.keys(uploading).some(k => uploading[k] > 0);
    flushNow();
    if(busy){ e.preventDefault(); e.returnValue = ''; }
  });

  async function addRow(){
    try{
      const before = new Set(docs.map(d => d.id));
      await call({ action:'add' }); render(); setState('נשמר', 'ok');
      const fresh = docs.find(d => !before.has(d.id));
      if(fresh) setTimeout(() => document.getElementById('n-' + fresh.id)?.focus(), 50);
    }catch(e){ note(ERR[e.code] || 'לא הצלחתי להוסיף שורה. נסה שוב.'); }
  }

  async function removeRow(id){
    pendingDel = null;
    try{ await call({ action:'delete', id }); setState('נמחק', 'ok'); }
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
    uploading[id] = (uploading[id]||0) + list.length; render();
    for(const f of list){
      try{
        if(f.size > 60*1024*1024) throw { code:'toolarge' };
        const jpg = await toJpeg(f);
        await call({ action:'upload', id, name: f.name.replace(/\.[^.]+$/, '') + '.jpg' }, jpg);
        setState('נשמר', 'ok');
      }catch(e){ note(`${f.name}: ${ERR[e.code] || 'לא הצלחתי להעלות. נסה שוב.'}`); }
      finally{ uploading[id]--; render(); }
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
