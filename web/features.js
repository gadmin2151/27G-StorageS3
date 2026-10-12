export function createFeatures(context) {
  const { $, $$, esc, icon, button, bytes, number, date, duration, state, api, toast, heading, openDialog, confirmAction, submit, loadPage, init, wiki } = context;
  const names = { admin: 'Администратор', operator: 'Оператор', viewer: 'Наблюдатель' };
  const permissionNames = { read: 'Чтение файлов', list: 'Просмотр списка', write: 'Загрузка файлов', delete: 'Удаление файлов', createBucket: 'Создание бакетов', deleteBucket: 'Удаление бакетов' };
  const partSize = 8 * 1024 * 1024;
  const username = () => typeof state.user === 'string' ? state.user : state.user?.username;
  const admin = () => state.role === 'admin';
  const writable = () => state.role !== 'viewer';
  const query = value => new URLSearchParams(value).toString();
  const field = (label, name, type = 'text', value = '', extra = '') => `<div class="field"><label for="feature-${esc(name)}">${esc(label)}</label><input id="feature-${esc(name)}" name="${esc(name)}" type="${type}" value="${esc(value)}" ${extra}></div>`;
  const actions = label => `<div class="form-error" role="alert"></div><div class="form-actions">${button('Отмена','close-dialog')}<button class="button primary" type="submit">${esc(label)}</button></div>`;
  const panel = (title, body, description = '', extra = '') => `<section class="panel"><div class="panel-head"><div><h2>${esc(title)}</h2>${description ? `<p>${esc(description)}</p>` : ''}</div>${extra}</div><div class="panel-body">${body}</div></section>`;
  const checked = (name, value, label, on = false) => `<label class="check-label"><input type="checkbox" name="${esc(name)}" value="${esc(value)}" ${on ? 'checked' : ''}>${esc(label)}</label>`;
  let users = [], serverUploads = [], monitoring = null, uploadOwner = null;

  function formDialog(title, content, label, work) {
    openDialog(title, `<form>${content}${actions(label)}</form>`, async event => {
      event.preventDefault(); const form = event.target;
      await submit(form, $('.form-error', form), () => work(new FormData(form), form));
    });
  }
  function acceptSession(result) {
    if (result.csrf) state.csrf = result.csrf;
    if (result.user) state.user = result.user;
    if (result.role) state.role = result.role;
  }
  function decorateLogin() {
    const form = $('#auth-form');
    if (!form || $('[name=code]', form)) return;
    $('#auth-error').insertAdjacentHTML('beforebegin', `<div class="field"><label for="login-mfa">Код MFA или код восстановления</label><input id="login-mfa" name="code" autocomplete="one-time-code" maxlength="32" placeholder="Если включена двухфакторная защита"><small>Шесть цифр из приложения-аутентификатора. Код восстановления используется один раз.</small></div>`);
    const setup = $('[name=setupToken]', form); if (setup) setup.required = false;
  }
  async function usersPage() {
    const result = await api('/api/users'); users = result.users || [];
    return heading('Пользователи и права', 'Отдельные учётные записи, роли и лимиты хранения.', button('Добавить пользователя','user-new','primary','plus')) +
      `<div class="notice">${icon('shield')}<div>Наблюдатель читает данные. Оператор работает с объектами и своими ключами. Администратор управляет доступом, системой и кластером. Последнего активного администратора отключить нельзя.</div></div>` +
      `<section class="panel section-gap"><div class="table-wrap"><table><thead><tr><th>Пользователь</th><th>Роль</th><th>Состояние</th><th>Хранение</th><th>MFA</th><th>Действия</th></tr></thead><tbody>${users.map(user => `<tr><td><strong>${esc(user.username)}</strong>${user.username === username() ? '<div class="tiny muted">Ваш аккаунт</div>' : ''}</td><td>${esc(names[user.role] || user.role)}</td><td><span class="badge ${user.enabled ? 'success' : 'warn'}">${user.enabled ? 'Активен' : 'Отключён'}</span></td><td><div>${bytes(user.usage?.bytes ?? 0)} / ${user.quotaBytes === null ? 'без лимита' : bytes(user.quotaBytes)}</div><div class="tiny muted">${number(user.usage?.objects ?? 0)} / ${user.quotaObjects === null ? 'без лимита' : number(user.quotaObjects)} объектов</div></td><td>${user.mfaEnabled ? 'Включена' : 'Не включена'}</td><td class="table-actions">${button('Изменить','user-edit','small','settings',`data-user="${esc(user.username)}"`)}</td></tr>`).join('')}</tbody></table></div></section>`;
  }
  function editUser(name) {
    const user = name ? users.find(value => value.username === name) : null;
    if (name && !user) throw new Error('Обновите список пользователей.');
    const content = `<div class="form-grid">${field('Имя пользователя','username','text',user?.username || '',`${user ? 'readonly' : 'required'} minlength="3" maxlength="80" autocomplete="off"`)}<div class="field"><label for="user-role">Роль</label><select id="user-role" name="role">${Object.entries(names).map(([value,label])=>`<option value="${value}" ${(user?.role || 'viewer') === value ? 'selected' : ''}>${label}</option>`).join('')}</select></div>${field(user ? 'Новый пароль (необязательно)' : 'Пароль','password','password','',`${user ? '' : 'required'} minlength="12" autocomplete="new-password"`)}${field('Квота хранения, МиБ','quotaMB','number',user?.quotaBytes === null || !user ? '' : user.quotaBytes / 1048576,'min="0" step="any" placeholder="Без лимита"')}${field('Квота объектов и версий','quotaObjects','number',user?.quotaObjects ?? '', 'min="0" step="1" placeholder="Без лимита"')}</div><p class="small-summary">Квота учитывает сохранённые версии и незавершённые загрузки. Пустое поле означает отсутствие лимита, 0 запрещает новые данные.</p>${user ? checked('enabled','yes','Учётная запись активна',user.enabled) : ''}`;
    formDialog(user ? `Пользователь ${name}` : 'Добавить пользователя', content, user ? 'Сохранить' : 'Создать', async fd => {
      const body = { username: String(fd.get('username')), role: fd.get('role'), quotaBytes: fd.get('quotaMB') === '' ? null : Math.round(Number(fd.get('quotaMB')) * 1048576), quotaObjects: fd.get('quotaObjects') === '' ? null : Number(fd.get('quotaObjects')) };
      if (fd.get('password')) body.password = fd.get('password');
      if (user) body.enabled = fd.get('enabled') === 'yes';
      await api(user ? '/api/users/' + encodeURIComponent(name) : '/api/users', { method: user ? 'PUT' : 'POST', body });
      $('#dialog').close(); toast(user ? 'Пользователь обновлён' : 'Пользователь создан');
      if (name === username()) await init(); else loadPage();
    });
  }
  async function mfaPanel() {
    const mfa = await api('/api/mfa');
    return panel('Двухфакторная защита', `<div class="settings-item"><span>Приложение-аутентификатор</span><span class="badge ${mfa.enabled ? 'success' : ''}">${mfa.enabled ? 'Включено' : 'Не настроено'}</span></div>${mfa.enabled ? `<p class="small-summary">Одноразовых кодов восстановления осталось: ${number(mfa.recoveryCodesRemaining)}. Сохранённый код можно использовать вместо кода приложения.</p>${button('Отключить MFA','mfa-disable','','shield')}` : `<p class="small-summary">Подключите приложение с TOTP. Секрет добавляется вручную; после подтверждения вы получите одноразовые коды восстановления.</p>${button('Настроить MFA','mfa-enroll','primary','shield')}`}`);
  }
  function enrollMfa() {
    formDialog('Настроить MFA',field('Текущий пароль','currentPassword','password','','required autocomplete="current-password"'),'Продолжить',async fd=>{
      const result=await api('/api/mfa/enroll',{method:'POST',body:{currentPassword:fd.get('currentPassword')}});
      $('#dialog').close();
      formDialog('Добавьте аккаунт в аутентификатор',`<p>В приложении выберите ручное добавление: TOTP, 6 цифр, SHA-1, интервал 30 секунд. Введите этот секрет:</p><div class="secret-value">${esc(result.secret)}</div>${button('Скопировать секрет','copy','small','copy',`data-copy="${esc(result.secret)}"`)}<p class="tiny muted">Настройка действует до ${date(result.expiresAt)}. После подтверждения секрет повторно не показывается.</p>${field('Код из приложения','code','text','','required inputmode="numeric" pattern="[0-9]{6}" maxlength="6" autocomplete="one-time-code"')}`,'Включить MFA',async codeForm=>{
        const confirmed=await api('/api/mfa/confirm',{method:'POST',body:{code:codeForm.get('code')}});acceptSession(confirmed);$('#dialog').close();
        openDialog('Сохраните коды восстановления',`<div class="notice warn">${icon('shield')}<div>Коды показаны один раз. Каждый заменяет код MFA при входе и работает только один раз. Сохраните их отдельно от устройства с аутентификатором.</div></div><pre class="recovery-codes">${esc((confirmed.recoveryCodes || []).join('\n'))}</pre>${button('Скопировать коды','copy','','copy',`data-copy="${esc((confirmed.recoveryCodes || []).join('\n'))}"`)}<div class="form-actions">${button('Я сохранил коды','close-dialog','primary','check')}</div>`);
        toast('Двухфакторная защита включена');loadPage();
      });
    });
  }
  function disableMfa() {
    formDialog('Отключить MFA',`<p>Подтвердите текущим паролем и неиспользованным кодом приложения или восстановления.</p>${field('Текущий пароль','currentPassword','password','','required autocomplete="current-password"')}${field('Код MFA или восстановления','code','text','','required maxlength="32" autocomplete="one-time-code"')}`,'Отключить MFA',async fd=>{ const result=await api('/api/mfa/disable',{method:'POST',body:{currentPassword:fd.get('currentPassword'),code:fd.get('code')}});acceptSession(result);$('#dialog').close();toast('MFA отключена');loadPage(); });
  }
  async function newKey() {
    const [buckets, accountList] = await Promise.all([api('/api/buckets'),admin()?api('/api/users'):Promise.resolve({users:[]})]);
    const choices=accountList.users || [];
    const content=`<div class="stack">${field('Название приложения','label','text','','required maxlength="100"')}${admin()?`<div class="field"><label for="key-owner">Владелец</label><select id="key-owner" name="owner">${choices.filter(user=>user.enabled).map(user=>`<option value="${esc(user.username)}" ${user.username===username()?'selected':''}>${esc(user.username)} · ${esc(names[user.role])}</option>`).join('')}</select></div>`:''}<fieldset><legend>Разрешённые операции</legend><div class="permission-grid">${Object.entries(permissionNames).filter(([key])=>writable()||['read','list'].includes(key)).map(([key,label])=>checked('permissions',key,label,['read','list'].includes(key))).join('')}</div></fieldset><fieldset><legend>Бакеты</legend>${checked('allBuckets','yes','Все существующие и будущие бакеты',true)}<div class="permission-grid section-gap">${(buckets.buckets || []).map(bucket=>checked('buckets',bucket.name,bucket.name)).join('')}</div></fieldset><div class="field"><label for="key-prefixes">Разрешённые префиксы, по одному в строке</label><textarea id="key-prefixes" name="prefixes" rows="3" placeholder="photos/\nbackups/"></textarea><small>Пусто — все объекты. С префиксами нельзя разрешить создание и удаление бакетов.</small></div>${field('Срок действия (необязательно)','expiresAt','datetime-local')}</div>`;
    formDialog('Создать ключ доступа',content,'Создать ключ',async fd=>{
      const permissions=fd.getAll('permissions'), all=fd.get('allBuckets')==='yes', selected=fd.getAll('buckets');
      if(!all&&!selected.length)throw new Error('Выберите хотя бы один бакет.');
      const body={label:String(fd.get('label')).trim(),role:permissions.some(p=>!['read','list'].includes(p))?'readwrite':'readonly',permissions,buckets:all?[]:selected,prefixes:String(fd.get('prefixes')).split('\n').map(s=>s.trim()).filter(Boolean),expiresAt:fd.get('expiresAt')?new Date(fd.get('expiresAt')).toISOString():null};
      if(admin())body.owner=fd.get('owner');
      const result=await api('/api/keys',{method:'POST',body});$('#dialog').close();
      openDialog('Ключ доступа создан',`<div class="notice warn">${icon('key')}<div>Сохраните секрет сейчас. Он не будет показан повторно.</div></div><div class="stack section-gap">${field('Access key','accessKey','text',result.accessKey,'readonly')}${field('Secret key','secretKey','text',result.secretKey,'readonly')}${button('Скопировать секрет','copy','','copy',`data-copy="${esc(result.secretKey)}"`)}</div><div class="form-actions">${button('Я сохранил ключ','close-dialog','primary','check')}</div>`);if(state.page==='keys')loadPage();
    });
  }

  // Multipart descriptors contain file identity and upload IDs, never credentials.
  const descriptorsKey = () => `27g:multipart:${username()}`;
  const descriptor = item => ({ id:item.id,bucket:item.bucket,key:item.key,name:item.name,size:item.size,lastModified:item.lastModified,partSize:item.partSize,fingerprint:item.fingerprint,partHashes:item.partHashes });
  function persistUploads() {
    if (!username()) return;
    try { localStorage.setItem(descriptorsKey(),JSON.stringify(state.uploads.filter(item=>item.id&&!['done','cancelled'].includes(item.status)).map(descriptor))); }
    catch { toast('Браузер не смог сохранить сведения для продолжения загрузки после закрытия вкладки.',true); }
  }
  async function fileIdentity(file,stopped=()=>false) {
    const hashes=[];
    for(let offset=0;offset<file.size || offset===0;offset+=partSize){if(stopped())throw new Error('Проверка файла приостановлена.');const chunk=await file.slice(offset,Math.min(offset+partSize,file.size)).arrayBuffer();const digest=await crypto.subtle.digest('SHA-256',chunk);hashes.push([...new Uint8Array(digest)].map(n=>n.toString(16).padStart(2,'0')).join(''));if(!file.size)break;}
    const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(`${file.size}:${partSize}:${hashes.join(':')}`));
    return {fingerprint:[...new Uint8Array(digest)].map(n=>n.toString(16).padStart(2,'0')).join(''),partHashes:hashes};
  }
  const uploadUrl = (item,suffix='') => `/api/uploads/${encodeURIComponent(item.id)}${suffix}?${query({bucket:item.bucket,key:item.key})}`;
  function normalizeUpload(row) {return { ...row,id:row.uploadId||row.id,name:row.key.split('/').pop(),status:'paused',progress:0,error:'',partSize };}
  async function restoreUploads() {
    if(!state.user)return;
    if(uploadOwner!==username()){for(const item of state.uploads){item.stopRequested=true;item.xhr?.abort();}state.uploads=[];uploadOwner=username();}
    let stored=[];try{stored=JSON.parse(localStorage.getItem(descriptorsKey())||'[]');if(!Array.isArray(stored))stored=[];}catch{}
    const result=await api('/api/uploads');serverUploads=result.uploads||[];
    const existing=new Map(state.uploads.filter(item=>item.id).map(item=>[item.id,item]));
    const recovered=serverUploads.map(row=>{
      const id=row.uploadId||row.id,live=existing.get(id);if(live)return live;
      const saved=stored.slice(0,100).find(item=>item.id===id&&item.bucket===row.bucket&&item.key===row.key);
      return {...normalizeUpload(row),...(saved||{}),owner:row.owner};
    });
    const stillNew=state.uploads.filter(item=>!item.id&&['queued','checking','uploading'].includes(item.status));
    state.uploads=[...recovered,...stillNew,...state.uploads.filter(item=>item.status==='done').slice(-10)];persistUploads();renderQueue();
  }
  const statusNames={queued:'В очереди',checking:'Проверяем файл',uploading:'Загружается',paused:'Приостановлено',error:'Ошибка',done:'Готово',cancelled:'Отменено'};
  function uploadButtons(item) {
    const ref=esc(item.clientId||item.id);
    if(['uploading','checking','queued'].includes(item.status))return button('Пауза','upload-pause','small','clock',`data-upload="${ref}"`);
    if(['paused','error'].includes(item.status))return button(item.file?'Продолжить':'Выбрать исходный файл','upload-resume','small','upload',`data-upload="${ref}"`)+button('Отменить загрузку','upload-abort','small danger','x',`data-upload="${ref}"`);
    return '';
  }
  function uploadRow(item,compact=false) {
    return `<div class="upload-row"><div class="row between wrap"><div class="upload-name"><strong title="${esc(item.key)}">${esc(item.key)}</strong><small>${esc(item.bucket)}${Number.isFinite(item.size)?' · '+bytes(item.size):''}</small></div><span class="badge ${item.status==='done'?'success':item.status==='error'?'warn':''}">${esc(statusNames[item.status]||item.status)}${item.status==='uploading'?' · '+item.progress+'%':''}</span></div>${item.status==='uploading'?`<progress max="100" value="${item.progress}" aria-label="Загрузка ${esc(item.key)}"></progress>`:''}${item.error?`<p class="form-error" role="status">${esc(item.error)}</p>`:''}<div class="row wrap ${compact?'':'section-gap'}">${uploadButtons(item)}</div></div>`;
  }
  function renderQueue() {
    const host=$('#upload-container');if(!host)return;
    if(!state.uploads.length||state.page==='uploads'){host.innerHTML='';if(state.page==='uploads'&&$('#upload-list'))$('#upload-list').innerHTML=state.uploads.length?state.uploads.map(item=>uploadRow(item)).join(''):'<div class="empty"><h3>Нет незавершённых загрузок</h3><p>Откройте бакет и выберите файлы.</p></div>';return;}
    const active=state.uploads.filter(item=>['queued','checking','uploading'].includes(item.status)).length;
    host.innerHTML=`<section class="queue-drawer" aria-label="Очередь загрузки"><div class="queue-head"><a href="#uploads"><strong>${active?'Загружаем файлов: '+active:'Загрузки: '+state.uploads.length}</strong></a>${active?button('Пауза всем','cancel-uploads','small ghost','clock'):button('Скрыть завершённые','uploads-clear','small ghost','check')}</div><div class="queue-list">${state.uploads.slice(-5).map(item=>uploadRow(item,true)).join('')}</div></section>`;
  }
  function pauseAll() { for(const item of state.uploads){if(['queued','uploading','checking'].includes(item.status)){item.stopRequested=true;item.status='paused';item.xhr?.abort();}}persistUploads();renderQueue(); }
  async function enqueueFiles(files) {
    if(!writable())throw new Error('Наблюдателю недоступна загрузка файлов.');
    if(!crypto.subtle)throw new Error('Для безопасного продолжения загрузок откройте панель через HTTPS или localhost.');
    const selected=[...files].slice(0,Math.max(0,100-state.uploads.filter(item=>item.status!=='done').length));
    if(selected.length<files.length)toast('Одновременно можно хранить до 100 заданий в браузере.',true);
    for(const file of selected){state.uploads.push({clientId:crypto.randomUUID(),file,name:file.name,size:file.size,lastModified:file.lastModified,bucket:state.bucket,key:state.prefix+file.name,partSize,status:'queued',progress:0,error:''});}
    renderQueue();pumpUploads();
  }
  function pumpUploads(){if(!state.user)return;const active=state.uploads.filter(item=>item.running).length;state.uploads.filter(item=>item.status==='queued'&&item.file&&!item.running).slice(0,Math.max(0,state.uploadConcurrency-active)).forEach(item=>{item.runPromise=startUpload(item);});}
  async function allParts(item){let marker,parts=[];do{const result=await api(uploadUrl(item)+(marker?'&partNumberMarker='+marker:''));parts.push(...(result.parts||[]));marker=result.isTruncated?result.nextPartNumberMarker:null;if(result.isTruncated&&!marker)throw new Error('Сервер не вернул продолжение списка частей.');}while(marker);return parts;}
  function sendPart(item,n,blob,completedBytes){return new Promise((resolve,reject)=>{
    const xhr=new XMLHttpRequest();item.xhr=xhr;xhr.open('PUT',uploadUrl(item,`/parts/${n}`));xhr.setRequestHeader('Content-Type','application/octet-stream');xhr.setRequestHeader('X-CSRF-Token',state.csrf||'');
    xhr.upload.onprogress=event=>{if(event.lengthComputable){item.progress=Math.min(99,Math.round((completedBytes+event.loaded)/Math.max(1,item.file.size)*100));renderQueue();}};
    xhr.onload=()=>{item.xhr=null;let value;try{value=JSON.parse(xhr.responseText);}catch{}if(xhr.status>=200&&xhr.status<300)resolve(value);else reject(new Error(value?.error?.message||value?.error||`Ошибка части ${n}: ${xhr.status}`));};
    xhr.onerror=()=>{item.xhr=null;reject(new Error('Соединение прервано. Сохранённые части можно продолжить позже.'));};xhr.onabort=()=>{item.xhr=null;reject(new Error('Загрузка приостановлена.'));};xhr.send(blob);
  });}
  async function startUpload(item){
    const actor=username(), stopped=()=>item.stopRequested||username()!==actor;
    item.running=true;item.stopRequested=false;item.status='checking';item.error='';renderQueue();
    try{
      const identity=await fileIdentity(item.file,stopped);if(stopped())return;
      if(item.fingerprint&&identity.fingerprint!==item.fingerprint)throw new Error('Выбран другой файл: контрольная сумма не совпадает с исходной загрузкой.');
      Object.assign(item,identity,{name:item.file.name,size:item.file.size,lastModified:item.file.lastModified});
      if(!item.id){const created=await api('/api/uploads',{method:'POST',body:{bucket:item.bucket,key:item.key,contentType:item.file.type||'application/octet-stream'}});item.id=created.uploadId;item.initiated=created.initiated;persistUploads();}
      if(stopped())return;
      const remote=await allParts(item),uploaded=new Map(remote.map(p=>[p.partNumber,p]));if(stopped())return;
      for(const part of remote){if(part.partNumber>identity.partHashes.length||part.sha256!==identity.partHashes[part.partNumber-1])throw new Error('Исходный файл не совпадает с уже сохранёнными частями. Выберите правильный файл или отмените это задание.');}
      item.status='uploading';const parts=[];let completedBytes=0;
      for(let n=1;n<=identity.partHashes.length;n++){
        if(stopped())return;
        const from=(n-1)*partSize,to=Math.min(n*partSize,item.file.size);let result=uploaded.get(n);
        if(!result)result=await sendPart(item,n,item.file.slice(from,to),completedBytes);
        if(stopped())return;
        parts.push({partNumber:n,etag:result.etag});completedBytes+=to-from;item.progress=Math.round(completedBytes/Math.max(1,item.file.size)*100);persistUploads();renderQueue();
      }
      await api(uploadUrl(item,'/complete'),{method:'POST',body:{parts}});item.status='done';item.progress=100;item.file=null;persistUploads();if(username()!==actor)return;toast(`Файл «${item.key}» сохранён`);
      if(state.page==='objects'&&state.bucket===item.bucket)loadPage();
    }catch(error){if(!stopped()){item.status='error';item.error=error.message;}persistUploads();}
    finally{item.xhr=null;item.running=false;renderQueue();pumpUploads();}
  }
  function findUpload(id){return state.uploads.find(item=>item.id===id||item.clientId===id);}
  function resumeUpload(item){
    if(item.file){item.status='queued';pumpUploads();return;}
    openDialog('Продолжить загрузку',`<p>Выберите исходный файл для <strong>${esc(item.key)}</strong>. Система сверит контрольные суммы и отправит только отсутствующие части.</p>${item.size!==undefined?`<p class="small-summary">Размер исходного файла: ${bytes(item.size)}.</p>`:''}<div class="field"><label for="resume-file">Исходный файл</label><input id="resume-file" type="file" required></div><div class="form-error" role="alert"></div>`);
    $('#resume-file').addEventListener('change',event=>{const file=event.target.files[0];if(!file)return;if(item.size!==undefined&&item.size!==file.size){$('.form-error',$('#dialog')).textContent='Размер не совпадает с исходным файлом.';return;}item.file=file;item.status='queued';$('#dialog').close();pumpUploads();});
  }
  async function uploadsPage() {await restoreUploads();return heading('Загрузки','Части хранятся на сервере. После обрыва выберите тот же файл и продолжите.',button('Обновить','refresh','','refresh'))+`<div class="notice">${icon('info')}<div>Файлы передаются частями по 8 МиБ. Пауза сохраняет уже принятые части; отмена удаляет задание. После перезагрузки страницы браузеру нужно повторно указать исходный файл.</div></div><section class="panel section-gap"><div id="upload-list">${state.uploads.length?state.uploads.map(item=>uploadRow(item)).join(''):'<div class="empty"><h3>Нет незавершённых загрузок</h3><p>Откройте бакет и выберите файлы.</p></div>'}</div></section>`; }
  async function showVersions(key) {
    const bucket=state.bucket,result=await api('/api/versions?'+query({bucket,key})),versions=(result.versions||[]).filter(version=>version.key===key);
    openDialog('История файла',`<div class="share-object-name">${icon('file')}<strong>${esc(key)}</strong></div><p class="small-summary">Хранятся до пяти версий содержимого. Удаление создаёт отметку в корзине. Восстановление публикует выбранную версию как текущую.</p>${versions.length?`<div class="version-list">${versions.map(version=>`<article class="version-row"><div><strong>${version.isDeleteMarker?'Удалён в корзину':date(version.modifiedAt)}</strong><p class="tiny muted">${version.isDeleteMarker?date(version.modifiedAt):bytes(version.size)+' · '+esc(version.owner||'—')}</p><code class="tiny">${esc(version.versionId)}</code></div><div class="stack">${version.isLatest?'<span class="badge accent">Текущее состояние</span>':''}<div class="row wrap">${!version.isDeleteMarker?`<a class="button small" href="/api/object?${query({bucket,key,versionId:version.versionId})}" download>${icon('download')}Скачать</a>${writable()?button('Восстановить','version-restore','small','refresh',`data-bucket="${esc(bucket)}" data-key="${esc(key)}" data-version="${esc(version.versionId)}"`):''}`:''}${admin()?button('Удалить навсегда','version-delete','small danger','trash',`data-bucket="${esc(bucket)}" data-key="${esc(key)}" data-version="${esc(version.versionId)}"`):''}</div></div></article>`).join('')}</div>`:'<p>Сохранённых версий нет.</p>'}`);
  }
  async function showTrash() {
    const bucket=state.bucket,result=await api('/api/trash?'+query({bucket})),objects=result.objects||[];
    openDialog(`Корзина: ${bucket}`,`<p class="small-summary">Удалённые файлы сохраняют историю. Полная очистка удаляет все версии выбранного объекта и не может быть отменена.</p>${objects.length?`<div class="version-list">${objects.map(object=>`<article class="version-row"><div><strong>${esc(object.key)}</strong><p class="tiny muted">${date(object.modifiedAt)}</p></div><div class="row wrap">${writable()&&object.restoreVersionId?button('Восстановить','version-restore','small','refresh',`data-bucket="${esc(bucket)}" data-key="${esc(object.key)}" data-version="${esc(object.restoreVersionId)}"`):'<span class="tiny muted">Нет версии для восстановления</span>'}${admin()?button('Удалить навсегда','trash-purge','small danger','trash',`data-bucket="${esc(bucket)}" data-key="${esc(object.key)}"`):''}</div></article>`).join('')}</div>`:'<div class="empty"><h3>Корзина пуста</h3><p>Здесь появятся удалённые объекты.</p></div>'}`);
  }
  function permanentDelete(target,all=false) {
    const {bucket,key,version}=target.dataset;
    formDialog(all?'Удалить все версии навсегда?':'Удалить эту версию навсегда?',`<div class="notice warn">${icon('trash')}<div>${all?'Будут удалены все сохранённые версии объекта':'Будет безвозвратно удалена выбранная версия'} <strong>${esc(key)}</strong>. Это действие нельзя отменить.</div></div>${field('Введите УДАЛИТЬ для подтверждения','confirmation','text','','required autocomplete="off"')}`,'Удалить навсегда',async fd=>{
      if(fd.get('confirmation')!=='УДАЛИТЬ')throw new Error('Для подтверждения введите УДАЛИТЬ.');
      await api(all?'/api/trash/purge':'/api/version?'+query({bucket,key,versionId:version}),all?{method:'POST',body:{bucket,key}}:{method:'DELETE'});$('#dialog').close();toast('Данные удалены окончательно');loadPage();
    });
  }
  async function bucketQuota() {
    const bucket=state.bucket,data=await api('/api/bucket-quota?'+query({bucket})),limits=data.quota||data;
    formDialog(`Квота бакета ${bucket}`,`<p class="small-summary">Учитываются текущие объекты, сохранённые версии и незавершённые части. Пусто — без лимита, 0 — запрет новых данных.</p><div class="form-grid">${field('Максимальный объём, МиБ','maxMB','number',limits.maxBytes==null?'':limits.maxBytes/1048576,'min="0" step="any" placeholder="Без лимита"')}${field('Максимум объектов и версий','maxObjects','number',limits.maxObjects??'','min="0" step="1" placeholder="Без лимита"')}</div>`,'Сохранить квоту',async fd=>{await api('/api/bucket-quota?'+query({bucket}),{method:'PUT',body:{maxBytes:fd.get('maxMB')===''?null:Math.round(Number(fd.get('maxMB'))*1048576),maxObjects:fd.get('maxObjects')===''?null:Number(fd.get('maxObjects'))}});$('#dialog').close();toast('Квота сохранена');});
  }
  function metric(label,value,note='') { return `<article class="metric-card"><span>${esc(label)}</span><strong>${esc(value)}</strong>${note?`<small>${esc(note)}</small>`:''}</article>`; }
  function historyChart(series) {
    const values=series.map(point=>({at:point.at,p95:Number(point.p95??point.metrics?.p95??0)})).filter(point=>Number.isFinite(point.p95));
    if(values.length<2)return '<p class="small-summary">Для графика нужно несколько замеров. Обновите экран после работы с файлами.</p>';
    const max=Math.max(1,...values.map(point=>point.p95)),points=values.map((point,i)=>`${Math.round(i/(values.length-1)*600)},${Math.round(110-point.p95/max*100)}`).join(' ');
    return `<figure class="latency-chart"><figcaption>Задержка p95 · от 0 до ${Math.ceil(max)} мс</figcaption><svg role="img" aria-label="Задержка запросов p95 по времени" viewBox="0 0 600 120" preserveAspectRatio="none"><path d="M0 110H600" class="chart-grid"/><polyline points="${points}" class="chart-line"/></svg><div class="row between tiny muted"><span>${date(values[0].at)}</span><span>${date(values.at(-1).at)}</span></div></figure>`;
  }
  async function monitoringPage() {
    monitoring=await api('/api/monitor');const m=monitoring.metrics||{},thresholds=monitoring.settings||{},alerts=monitoring.alerts||[],ha=monitoring.ha||{};
    return heading('Диагностика','Запросы, нагрузка, предупреждения и состояние копий.',button('Обновить','refresh','','refresh'))+`<div class="metrics-grid">${metric('Запросов',number(m.requests))}${metric('Ошибок',number(m.errors))}${metric('Задержка p95',number(m.p95)+' мс','p50 '+number(m.p50)+' · p99 '+number(m.p99)+' мс')}${metric('Память процесса',bytes(m.rssBytes))}${metric('Загрузки',number(m.activeUploads),'В очереди '+number(m.queuedUploads))}${metric('Попадания в кэш',Number.isFinite(m.cacheHitRatio)?Math.round(m.cacheHitRatio*100)+'%':'—')}</div><div class="overview-grid section-gap">${panel('Задержки запросов',historyChart(monitoring.series||[]))}${panel('Предупреждения',alerts.length?`<div class="stack">${alerts.map(alert=>`<div class="alert-item ${esc(alert.severity)}"><strong>${esc(alert.message)}</strong><div class="row between"><small>${alert.acknowledgedAt?'Прочитано '+date(alert.acknowledgedAt):'Требует внимания'}</small>${admin()&&!alert.acknowledgedAt?button('Прочитано','monitor-ack','small','check',`data-id="${esc(alert.id)}"`):''}</div></div>`).join('')}</div>`:'<p class="small-summary">Активных предупреждений нет.</p>')}</div><div class="overview-grid section-gap">${panel('Сохранность и доступность',`<div class="settings-item"><span>Режим координатора</span><strong>${esc(ha.role||'Одиночный')}</strong></div><div class="settings-item"><span>Узлы онлайн</span><strong>${(monitoring.nodes||[]).filter(node=>node.online).length} / ${(monitoring.nodes||[]).length}</strong></div><p class="small-summary">${esc(monitoring.note||'Онлайн-статус узлов не заменяет проверку целостности и независимости копий.')}</p>${monitoring.scrub?`<p class="small-summary">Последняя проверка: ${monitoring.scrub.at||monitoring.scrub.finishedAt?date(monitoring.scrub.at||monitoring.scrub.finishedAt):'время не сохранено'}. Проверено: ${number(monitoring.scrub.checked??monitoring.scrub.result?.checked)}, восстановлено: ${number(monitoring.scrub.repaired??monitoring.scrub.result?.repaired)}.</p>`:''}<a href="#cluster">Перейти к кластеру →</a>`)}${admin()?panel('Пороги предупреждений',`<form id="monitor-settings"><div class="form-grid">${field('Заполнение диска, %','diskPercent','number',thresholds.diskPercent??85,'required min="1" max="100"')}${field('Заполнение очереди, %','queuePercent','number',thresholds.queuePercent??80,'required min="1" max="100"')}${field('Задержка p95, мс','latencyMs','number',thresholds.latencyMs??1000,'required min="10" max="300000"')}</div>${actions('Сохранить пороги')}</form>`):''}</div>`;
  }
  async function accountPage() {
    return heading('Настройки аккаунта',`${username()} · ${names[state.role]||state.role}`)+`<div class="settings-layout"><div class="stack">${panel('Изменить пароль',`<form id="password-form"><div class="stack">${field('Текущий пароль','currentPassword','password','','required autocomplete="current-password"')}${field('Новый пароль','password','password','','required minlength="12" autocomplete="new-password"')}${field('Повторите пароль','repeatPassword','password','','required minlength="12" autocomplete="new-password"')}</div><div class="form-error" id="password-error" role="alert"></div><div class="form-actions"><button type="submit" class="button primary">Обновить пароль</button></div></form>`)}</div><div class="stack">${await mfaPanel()}</div></div>`;
  }
  async function networkPanel() {
    const settings=await api('/api/settings');
    return panel('Публичный адрес и CORS',`<form id="network-settings" data-original-origin="${esc(settings.publicOrigin||'')}">${field('Публичный адрес хранилища','publicOrigin','url',settings.publicOrigin||'','placeholder="https://s3.example.com"')}<p class="small-summary">Этот адрес используется в новых ссылках и для управления панелью. Сначала настройте DNS, HTTPS и прокси на сервере. После смены адреса новые действия в панели потребуется выполнять с выбранного домена. Пустое поле возвращает локальный адрес.</p><div class="field"><label for="cors-origins">Разрешённые сайты для S3-запросов, по одному в строке</label><textarea id="cors-origins" name="corsOrigins" rows="3" placeholder="https://app.example.com">${esc((settings.corsOrigins||[]).join('\n'))}</textarea><small>Только точные адреса с http:// или https://, без пути. Это не открывает доступ к панели или приватным файлам.</small></div>${actions('Сохранить адреса')}</form>`);
  }
  async function clusterPanels() {
    const [ha,connections]=await Promise.all([admin()?api('/api/ha'):Promise.resolve(state.status?.ha||{enabled:false}),admin()?api('/api/disk-agents'):Promise.resolve({agents:[]})]);
    const agents=connections.agents||[];
    const currentRole=ha.activeRole||ha.role||'single',enabled=Boolean(ha.enabled);
    return `<div class="overview-grid section-gap">${panel('Координаторы и доступность',`<div class="settings-item"><span>Режим</span><strong>${enabled?'HA · '+esc(currentRole):'Одиночный координатор'}</strong></div><div class="settings-item"><span>Готовность</span><span class="badge ${ha.ready?'success':'warn'}">${ha.ready?'Готов к работе':enabled?'Проверьте состояние':'Один экземпляр'}</span></div>${ha.leaderId?`<div class="settings-item"><span>Активный координатор</span><strong>${esc(ha.leaderId)}</strong></div>`:''}${ha.error?`<p class="form-error">${esc(ha.error)}</p>`:''}<p class="small-summary">${esc(ha.message||ha.note||(enabled?'Роль задаёт участие координатора. Право записи определяется актуальным лидерством и доступностью quorum.':'Для HA сначала разверните профиль с независимыми координаторами и сервисом quorum по инструкции.'))}</p>${admin()&&enabled?`<div class="row wrap">${button('Роль master','ha-role','','server','data-role="master"')}${button('Роль slave','ha-role','','server','data-role="slave"')}</div>`:''}<a class="small-summary" href="#wiki-cluster">Инструкция по кластеру →</a>`)}${panel('Серверы и подключённые диски',`<p class="small-summary">Дисковый агент на сервере подключает существующие диски, папки, SMB и NFS. Новый диск появится в форме узлов; затем проверьте план и сохраните топологию.</p>${agents.length?`<div class="stack">${agents.map(agent=>`<div class="agent-row"><div><strong>${esc(agent.label||agent.id)}</strong><small>${esc(agent.url)}</small></div><div class="row wrap">${button('Диски','agent-disks','small','server',`data-agent="${esc(agent.id)}"`)}${button('Отключить связь','agent-remove','small danger','x',`data-agent="${esc(agent.id)}"`)}</div></div>`).join('')}</div>`:'<p class="small-summary">Подключённых дисковых агентов пока нет. Установите агент на сервере один раз, затем добавьте его адрес.</p>'}${admin()?`<div class="form-actions">${button('Добавить сервер','agent-add','primary','plus')}</div>`:''}`)}</div>`;
  }
  function addAgent() {
    formDialog('Подключить сервер дисков',`<p class="small-summary">Агент должен быть запущен на сервере с нужными дисками. Используйте внутреннюю сеть или HTTPS. Его токен не показывается повторно.</p><div class="form-grid">${field('ID сервера','id','text','','required pattern="[a-zA-Z0-9_-]+" maxlength="64"')}${field('Название','label','text','','required maxlength="80"')}${field('Адрес агента','url','url','','required placeholder="http://disk-agent:9200"')}${field('Токен агента','token','password','','required autocomplete="new-password"')}</div>`,'Подключить сервер',async fd=>{await api('/api/disk-agents',{method:'POST',body:Object.fromEntries(fd)});$('#dialog').close();toast('Сервер подключён');loadPage();});
  }
  async function agentDisks(id) {
    const result=await api(`/api/disk-agents/${encodeURIComponent(id)}/disks`),disks=result.disks||[];
    const devices=Array.isArray(result.devices)?result.devices:(result.devices?.blockdevices||[]);
    openDialog('Диски сервера',`<p class="small-summary">Форматирование не выполняется. Подключайте существующую файловую систему или сетевой ресурс. Несколько папок одного физического диска не дают независимых копий.</p>${disks.length?`<div class="version-list">${disks.map(disk=>`<article class="version-row"><div><strong>${esc(disk.label||disk.id)}</strong><p class="tiny muted">${esc(disk.kind)} · ${esc(disk.source)}</p><span class="badge">${esc(disk.state||'—')}</span></div>${button('Проверить / подключить','disk-retry','small','refresh',`data-agent="${esc(id)}" data-disk="${esc(disk.id)}"`)}</article>`).join('')}</div>`:'<p>Ресурсы ещё не подключены.</p>'}${devices.length?`<details class="section-gap"><summary>Обнаруженные устройства</summary><ul class="disk-inventory">${devices.map(device=>`<li><code>${esc(device.path||device.name)}</code> · ${esc(device.fstype||'без файловой системы')} · ${esc(device.size||'')}${device.children?.length?`<ul>${device.children.map(child=>`<li><code>${esc(child.path||child.name)}</code> · ${esc(child.fstype||'—')} · ${esc(child.size||'')}</li>`).join('')}</ul>`:''}</li>`).join('')}</ul></details>`:''}<div class="form-actions">${button('Подключить диск или ресурс','disk-add','primary','plus',`data-agent="${esc(id)}" data-devices="${result.allowDevices?'yes':'no'}"`)}</div>`);
  }
  function addDisk(target) {
    const id=target.dataset.agent,devices=target.dataset.devices==='yes';
    formDialog('Подключить диск или сетевой ресурс',`<div class="form-grid"><div class="field"><label for="disk-kind">Тип ресурса</label><select name="kind" id="disk-kind"><option value="folder">Папка сервера</option>${devices?'<option value="device">Существующий физический раздел</option>':''}<option value="smb">SMB / Windows share</option><option value="nfs">NFS</option></select></div>${field('Название','label','text','','required maxlength="80"')}${field('Путь или адрес ресурса','source','text','','required placeholder="/srv/storage/data"')}</div><p id="disk-source-help" class="small-summary">Папка должна находиться в разрешённом корне дискового агента.</p><div id="smb-fields" class="form-grid hidden">${field('Пользователь SMB','username','text','','autocomplete="off" disabled')}${field('Пароль SMB','password','password','','autocomplete="new-password" disabled')}${field('Домен SMB (необязательно)','domain','text','','disabled')}</div>`,'Подключить и добавить узел',async fd=>{
      const body=Object.fromEntries(fd);if(body.kind==='smb')body.smbVersion='3.1.1';
      const result=await api(`/api/disk-agents/${encodeURIComponent(id)}/disks`,{method:'POST',body});
      await acceptDisk(result,id);
    });
    $('#disk-kind').addEventListener('change',event=>{const kind=event.target.value;$('#smb-fields').classList.toggle('hidden',kind!=='smb');$$('input',$('#smb-fields')).forEach(input=>input.disabled=kind!=='smb');$('#feature-source').placeholder={folder:'/srv/storage/data',device:'/dev/disk/by-id/…-part1',smb:'//server/share',nfs:'server:/export'}[kind];$('#disk-source-help').textContent={folder:'Папка должна находиться в разрешённом корне дискового агента.',device:'Только существующий раздел ext4, XFS или Btrfs. Данные не форматируются.',smb:'Используется SMB 3.1.1. Учётные данные сохраняются агентом защищённо.',nfs:'Экспорт NFS должен разрешать доступ серверу дискового агента.'}[kind];});
  }
  async function acceptDisk(result,agentId) {
    if(result.disk?.state!=='ready'){toast('Ресурс сохранён, но пока недоступен. Проверьте путь, доступ и состояние сервера.',true);await agentDisks(agentId);return;}
    if(!result.node)throw new Error('Ресурс подключён, но настройки узла не получены. Повторите проверку ресурса.');
    const existing=$$('#nodes-form .node-form').some(row=>$('[name=nodeId]',row)?.value===result.node.id);
    if(existing){toast('Этот диск уже есть в форме узлов. Проверьте и сохраните топологию.');$('#dialog').close();return;}
    context.addNode(result.node);$('#dialog').close();toast('Диск добавлен в форму узлов. Проверьте и сохраните топологию.');$('#topology-form')?.scrollIntoView({block:'start'});
  }
  async function planTopology(body) {
    const plan=await api('/api/cluster/plan',{method:'POST',body:{mode:body.mode,nodes:body.nodes}});
    return new Promise((resolve,reject)=>{
      let settled=false;const dialog=$('#dialog');
      const close=()=>{dialog.removeEventListener('close',close);if(!settled){settled=true;reject(new Error('Изменение топологии отменено.'));}};
      formDialog('Проверьте план изменения кластера',`<div class="metrics-grid compact">${metric('Узлов',number(plan.nodeCount))}${metric('Полезная ёмкость',plan.usefulBytes==null?'Неизвестно':bytes(plan.usefulBytes))}${metric('Объём переноса',plan.moveBytes==null?'Неизвестно':bytes(plan.moveBytes))}</div><p class="small-summary">Режим ${esc(String(plan.mode).toUpperCase())}. Общая физическая ёмкость: ${plan.rawBytes==null?'неизвестна':bytes(plan.rawBytes)}. Расчёт не включает место для служебных файлов и резерв восстановления.</p>${plan.warnings?.length?`<div class="notice warn"><ul>${plan.warnings.map(warning=>`<li>${esc(warning)}</li>`).join('')}</ul></div>`:''}${checked('confirmed','yes','Подтверждаю план и достаточный запас места')}`,'Применить топологию',async fd=>{
        if(fd.get('confirmed')!=='yes')throw new Error('Подтвердите проверенный план.');
        const result=await api('/api/topology',{method:'PUT',body});settled=true;dialog.close();resolve(result);
      });dialog.addEventListener('close',close);
    });
  }

  async function afterRender(page) {
    if(page==='settings'&&admin()) { const host=$('.settings-layout .stack');if(host){const [mfa,network]=await Promise.all([mfaPanel(),networkPanel()]);if(host.isConnected)host.insertAdjacentHTML('beforeend',mfa+network);} }
    if(page==='cluster'){const main=$('#main'),content=await clusterPanels();if(main.isConnected&&state.page===page)main.insertAdjacentHTML('beforeend',content);}
    if(page==='objects'){
      const toolbar=$('#prefix-form');toolbar?.insertAdjacentHTML('beforeend',button('Корзина','object-trash','','trash')+(admin()?button('Квота бакета','bucket-quota','','settings'):''));
      for(const row of $$('tbody tr')){const item=$('[data-action="share-object"]',row);if(item)item.insertAdjacentHTML('beforebegin',button('История','object-history','small','clock',`data-key="${esc(item.dataset.key)}"`));}
    }
    if(page==='keys') { for(const row of $$('tbody tr')){const key=state.data.find(value=>row.textContent.includes(value.accessKey));if(key)$('td:nth-child(2)',row).insertAdjacentHTML('beforeend',`<div class="tiny muted">${esc(key.permissions?.map(p=>permissionNames[p]).join(', ')||'')}</div><div class="tiny muted">Владелец: ${esc(key.owner||'—')}</div>${key.prefixes?.length?`<div class="tiny muted">Префиксы: ${esc(key.prefixes.join(', '))}</div>`:''}<div class="tiny muted">${key.expiresAt?'До '+date(key.expiresAt):'Без срока'}</div>`);} }
    if(!writable()){for(const element of $$('[data-action="new-bucket"],[data-action="delete-bucket"],[data-action="delete-object"],[data-action="choose-files"],[data-action="share-object"],#dropzone'))element.hidden=true;}
    if(!admin()){for(const element of $$('#topology-form,[data-action="scrub"],#settings-form'))element.hidden=true;}
  }
  async function click(action,target) {
    if(action==='user-new')editUser();else if(action==='user-edit')editUser(target.dataset.user);else if(action==='mfa-enroll')enrollMfa();else if(action==='mfa-disable')disableMfa();else if(action==='new-key')await newKey();
    else if(action==='cancel-uploads'){pauseAll();toast('Загрузки приостановлены. Сохранённые части остаются на сервере.');}
    else if(action==='uploads-clear'){state.uploads=state.uploads.filter(item=>!['done','cancelled'].includes(item.status));persistUploads();renderQueue();}
    else if(action==='upload-pause'){const item=findUpload(target.dataset.upload);if(item){item.stopRequested=true;item.status='paused';item.xhr?.abort();persistUploads();renderQueue();pumpUploads();}}
    else if(action==='upload-resume'){const item=findUpload(target.dataset.upload);if(item)resumeUpload(item);}
    else if(action==='upload-abort'){const item=findUpload(target.dataset.upload);if(item)confirmAction('Отменить незавершённую загрузку?',`Сохранённые части «${item.key}» будут удалены. Готовый объект с таким именем останется.`, 'Отменить загрузку',async()=>{item.stopRequested=true;item.status='paused';item.xhr?.abort();await item.runPromise;if(item.id)await api(uploadUrl(item),{method:'DELETE'});state.uploads=state.uploads.filter(value=>value!==item);persistUploads();renderQueue();});}
    else if(action==='object-history')await showVersions(target.dataset.key);
    else if(action==='object-trash')await showTrash();
    else if(action==='bucket-quota')await bucketQuota();
    else if(action==='delete-object'){const bucket=state.bucket,key=target.dataset.key;confirmAction('Переместить файл в корзину?',`Файл «${key}» исчезнет из текущих объектов. Сохранённую версию можно восстановить из истории или корзины.`, 'В корзину',async()=>{await api('/api/object?'+query({bucket,key}),{method:'DELETE'});toast('Файл перемещён в корзину');loadPage();});}
    else if(action==='version-restore'){const {bucket,key,version}=target.dataset;confirmAction('Восстановить версию?',`Выбранная версия «${key}» станет текущей. Сохраняются до пяти версий содержимого.`, 'Восстановить',async()=>{await api('/api/versions/restore',{method:'POST',body:{bucket,key,versionId:version}});toast('Версия восстановлена');loadPage();});}
    else if(action==='version-delete')permanentDelete(target);
    else if(action==='trash-purge')permanentDelete(target,true);
    else if(action==='monitor-ack'){await api('/api/monitor/ack',{method:'POST',body:{id:target.dataset.id}});loadPage();}
    else if(action==='agent-add')addAgent();
    else if(action==='agent-disks')await agentDisks(target.dataset.agent);
    else if(action==='agent-remove'){const id=target.dataset.agent;confirmAction('Отключить связь с агентом?', 'Настройки связи будут удалены. Диски, данные и узлы топологии это действие не удаляет.', 'Отключить связь',async()=>{await api('/api/disk-agents/'+encodeURIComponent(id),{method:'DELETE'});loadPage();});}
    else if(action==='disk-add')addDisk(target);
    else if(action==='disk-retry'){const result=await api(`/api/disk-agents/${encodeURIComponent(target.dataset.agent)}/disks/${encodeURIComponent(target.dataset.disk)}/retry`,{method:'POST',body:{}});await acceptDisk(result,target.dataset.agent);}
    else if(action==='ha-role'){const role=target.dataset.role;confirmAction('Изменить роль координатора?',`Назначить этому экземпляру роль ${role}. Активные соединения могут прерваться при переключении.`, 'Назначить роль',async()=>{await api('/api/ha/role',{method:'PUT',body:{role}});toast('Роль изменена');loadPage();});}
    else return false;return true;
  }
  document.addEventListener('submit',async event=>{
    const form=event.target;if(!['network-settings','monitor-settings'].includes(form.id))return;event.preventDefault();
    await submit(form,$('.form-error',form),async()=>{
      const fd=new FormData(form);
      if(form.id==='network-settings'){
        const body={publicOrigin:String(fd.get('publicOrigin')).trim().replace(/\/$/,''),corsOrigins:String(fd.get('corsOrigins')).split('\n').map(value=>value.trim()).filter(Boolean)};
        const changed=body.publicOrigin!==form.dataset.originalOrigin;
        const save=async()=>{await api('/api/settings',{method:'PUT',body});form.dataset.originalOrigin=body.publicOrigin;toast('Адреса сохранены.');if(changed){const destination=body.publicOrigin||location.origin;form.insertAdjacentHTML('afterend',`<div class="notice warn section-gap"><div>Адрес изменён. Для следующих действий откройте панель по сохранённому адресу. DNS и HTTPS настраиваются на сервере.<div class="form-actions"><a class="button primary" href="${esc(destination+'/console/')}">Открыть панель по новому адресу</a></div></div></div>`);}};
        if(changed){formDialog('Изменить адрес панели?',`<p>Новый адрес: <strong>${esc(body.publicOrigin||location.origin)}</strong>.</p><p>После сохранения запросы управления с прежнего адреса могут отклоняться. Убедитесь, что DNS, HTTPS и прокси уже направляют этот адрес на хранилище.</p>${checked('ready','yes','Адрес настроен; я смогу открыть панель по нему')}`,'Сохранить адрес',async confirmation=>{if(confirmation.get('ready')!=='yes')throw new Error('Подтвердите готовность адреса.');await save();$('#dialog').close();});}
        else await save();
      }
      else {await api('/api/monitor/settings',{method:'PUT',body:Object.fromEntries(['diskPercent','queuePercent','latencyMs'].map(key=>[key,Number(fd.get(key))]))});toast('Пороги предупреждений сохранены');}
    });
  });
  function hasPage(page) { return ['users','uploads','monitoring'].includes(page)||page==='settings'&&!admin(); }
  async function page(name) { if(name==='users')return usersPage();if(name==='uploads')return uploadsPage();if(name==='settings')return accountPage();return monitoringPage(); }
  return { hasPage,page,afterRender,click,decorateLogin,restoreUploads,renderQueue,enqueueFiles,pauseAll,planTopology };
}
