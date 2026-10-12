import { t, getLanguage } from './i18n.js';
import { serverText } from './i18n-server.js';
import './i18n-features.js';

export function settingsHaveDrafts(forms) {
  return forms.filter(form => form.id !== 'language-settings').some(form => form.dataset.pending === 'true' || [...form.elements].some(input => {
    if (!['INPUT', 'TEXTAREA', 'SELECT'].includes(input.tagName) || ['submit', 'reset', 'button', 'file'].includes(input.type)) return false;
    if (input.tagName === 'SELECT') return [...input.options].some(option => option.selected !== option.defaultSelected);
    if (['checkbox', 'radio'].includes(input.type)) return input.checked !== input.defaultChecked;
    return input.value !== input.defaultValue;
  }));
}

export function createFeatures(context) {
  const { $, $$, esc, icon, button, bytes, number, date, duration, state, api, toast, heading, openDialog, confirmAction, submit, loadPage, init, wiki } = context;
  const names = () => ({ admin: t("Администратор"), operator: t("Оператор"), viewer: t("Наблюдатель") });
  const permissionNames = () => ({ read: t("Чтение файлов"), list: t("Просмотр списка"), write: t("Загрузка файлов"), delete: t("Удаление файлов"), createBucket: t("Создание бакетов"), deleteBucket: t("Удаление бакетов") });
  const partSize = 8 * 1024 * 1024;
  const username = () => typeof state.user === 'string' ? state.user : state.user?.username;
  const admin = () => state.role === 'admin';
  const writable = () => state.role !== 'viewer';
  const query = value => new URLSearchParams(value).toString();
  const field = (label, name, type = 'text', value = '', extra = '') => `<div class="field"><label for="feature-${esc(name)}">${esc(label)}</label><input id="feature-${esc(name)}" name="${esc(name)}" type="${type}" value="${esc(value)}" ${extra}></div>`;
  const actions = label => `<div class="form-error" role="alert"></div><div class="form-actions">${button(t("Отмена"),'close-dialog')}<button class="button primary" type="submit">${esc(label)}</button></div>`;
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
    $('#auth-error').insertAdjacentHTML('beforebegin', `<div class="field"><label for="login-mfa">${esc(t("Код MFA или код восстановления"))}</label><input id="login-mfa" name="code" autocomplete="one-time-code" maxlength="32" placeholder="${esc(t("Если включена двухфакторная защита"))}"><small>${esc(t("Шесть цифр из приложения-аутентификатора. Код восстановления используется один раз."))}</small></div>`);
    const setup = $('[name=setupToken]', form); if (setup) setup.required = false;
  }
  async function usersPage() {
    const result = await api('/api/users'); users = result.users || [];
    return heading(t("Пользователи и права"), t("Отдельные учётные записи, роли и лимиты хранения."), button(t("Добавить пользователя"),'user-new','primary','plus')) +
      `<div class="notice">${icon('shield')}<div>${esc(t("Наблюдатель читает данные. Оператор работает с объектами и своими ключами. Администратор управляет доступом, системой и кластером. Последнего активного администратора отключить нельзя."))}</div></div>` +
      `<section class="panel section-gap"><div class="table-wrap"><table><thead><tr><th>${esc(t("Пользователь"))}</th><th>${esc(t("Роль"))}</th><th>${esc(t("Состояние"))}</th><th>${esc(t("Хранение"))}</th><th>MFA</th><th>${esc(t("Действия"))}</th></tr></thead><tbody>${users.map(user => `<tr><td><strong>${esc(user.username)}</strong>${user.username === username() ? `<div class="tiny muted">${esc(t("Ваш аккаунт"))}</div>` : ''}</td><td>${esc(names()[user.role] || user.role)}</td><td><span class="badge ${user.enabled ? 'success' : 'warn'}">${user.enabled ? t("Активен") : t("Отключён")}</span></td><td><div>${bytes(user.usage?.bytes ?? 0)} / ${user.quotaBytes === null ? t("без лимита") : bytes(user.quotaBytes)}</div><div class="tiny muted">${number(user.usage?.objects ?? 0)} / ${user.quotaObjects === null ? t("без лимита") : number(user.quotaObjects)} ${esc(t("объектов"))}</div></td><td>${user.mfaEnabled ? t("Включена") : t("Не включена")}</td><td class="table-actions">${button(t("Изменить"),'user-edit','small','settings',`data-user="${esc(user.username)}"`)}</td></tr>`).join('')}</tbody></table></div></section>`;
  }
  function editUser(name) {
    const user = name ? users.find(value => value.username === name) : null;
    if (name && !user) throw new Error(t("Обновите список пользователей."));
    const content = `<div class="form-grid">${field(t("Имя пользователя"),'username','text',user?.username || '',`${user ? 'readonly' : 'required'} minlength="3" maxlength="80" autocomplete="off"`)}<div class="field"><label for="user-role">${esc(t("Роль"))}</label><select id="user-role" name="role">${Object.entries(names()).map(([value,label])=>`<option value="${value}" ${(user?.role || 'viewer') === value ? 'selected' : ''}>${label}</option>`).join('')}</select></div>${field(user ? t("Новый пароль (необязательно)") : t("Пароль"),'password','password','',`${user ? '' : 'required'} minlength="12" autocomplete="new-password"`)}${field(t("Квота хранения, МиБ"),'quotaMB','number',user?.quotaBytes === null || !user ? '' : user.quotaBytes / 1048576,t("min=\"0\" step=\"any\" placeholder=\"Без лимита\""))}${field(t("Квота объектов и версий"),'quotaObjects','number',user?.quotaObjects ?? '', t("min=\"0\" step=\"1\" placeholder=\"Без лимита\""))}</div><p class="small-summary">${esc(t("Квота учитывает сохранённые версии и незавершённые загрузки. Пустое поле означает отсутствие лимита, 0 запрещает новые данные."))}</p>${user ? checked('enabled','yes',t("Учётная запись активна"),user.enabled) : ''}`;
    formDialog(user ? t("Пользователь {p0}", {p0: name}) : t("Добавить пользователя"), content, user ? t("Сохранить") : t("Создать"), async fd => {
      const body = { username: String(fd.get('username')), role: fd.get('role'), quotaBytes: fd.get('quotaMB') === '' ? null : Math.round(Number(fd.get('quotaMB')) * 1048576), quotaObjects: fd.get('quotaObjects') === '' ? null : Number(fd.get('quotaObjects')) };
      if (fd.get('password')) body.password = fd.get('password');
      if (user) body.enabled = fd.get('enabled') === 'yes';
      await api(user ? '/api/users/' + encodeURIComponent(name) : '/api/users', { method: user ? 'PUT' : 'POST', body });
      $('#dialog').close(); toast(user ? t("Пользователь обновлён") : t("Пользователь создан"));
      if (name === username()) await init(); else loadPage();
    });
  }
  async function mfaPanel() {
    const mfa = await api('/api/mfa');
    return panel(t("Двухфакторная защита"), `<div class="settings-item"><span>${esc(t("Приложение-аутентификатор"))}</span><span class="badge ${mfa.enabled ? 'success' : ''}">${mfa.enabled ? t("Включено") : t("Не настроено")}</span></div>${mfa.enabled ? `<p class="small-summary">${esc(t("Одноразовых кодов восстановления осталось:"))} ${number(mfa.recoveryCodesRemaining)}${esc(t(". Сохранённый код можно использовать вместо кода приложения."))}</p>${button(t("Отключить MFA"),'mfa-disable','','shield')}` : `<p class="small-summary">${esc(t("Подключите приложение с TOTP. Секрет добавляется вручную; после подтверждения вы получите одноразовые коды восстановления."))}</p>${button(t("Настроить MFA"),'mfa-enroll','primary','shield')}`}`);
  }
  function enrollMfa() {
    formDialog(t("Настроить MFA"),field(t("Текущий пароль"),'currentPassword','password','','required autocomplete="current-password"'),t("Продолжить"),async fd=>{
      const result=await api('/api/mfa/enroll',{method:'POST',body:{currentPassword:fd.get('currentPassword')}});
      $('#dialog').close();
      formDialog(t("Добавьте аккаунт в аутентификатор"),`<p>${esc(t("В приложении выберите ручное добавление: TOTP, 6 цифр, SHA-1, интервал 30 секунд. Введите этот секрет:"))}</p><div class="secret-value">${esc(result.secret)}</div>${button(t("Скопировать секрет"),'copy','small','copy',`data-copy="${esc(result.secret)}"`)}<p class="tiny muted">${esc(t("Настройка действует до"))} ${date(result.expiresAt)}${esc(t(". После подтверждения секрет повторно не показывается."))}</p>${field(t("Код из приложения"),'code','text','','required inputmode="numeric" pattern="[0-9]{6}" maxlength="6" autocomplete="one-time-code"')}`,t("Включить MFA"),async codeForm=>{
        const confirmed=await api('/api/mfa/confirm',{method:'POST',body:{code:codeForm.get('code')}});acceptSession(confirmed);$('#dialog').close();
        openDialog(t("Сохраните коды восстановления"),`<div class="notice warn">${icon('shield')}<div>${esc(t("Коды показаны один раз. Каждый заменяет код MFA при входе и работает только один раз. Сохраните их отдельно от устройства с аутентификатором."))}</div></div><pre class="recovery-codes">${esc((confirmed.recoveryCodes || []).join('\n'))}</pre>${button(t("Скопировать коды"),'copy','','copy',`data-copy="${esc((confirmed.recoveryCodes || []).join('\n'))}"`)}<div class="form-actions">${button(t("Я сохранил коды"),'close-dialog','primary','check')}</div>`);
        toast(t("Двухфакторная защита включена"));loadPage();
      });
    });
  }
  function disableMfa() {
    formDialog(t("Отключить MFA"),`<p>${esc(t("Подтвердите текущим паролем и неиспользованным кодом приложения или восстановления."))}</p>${field(t("Текущий пароль"),'currentPassword','password','','required autocomplete="current-password"')}${field(t("Код MFA или восстановления"),'code','text','','required maxlength="32" autocomplete="one-time-code"')}`,t("Отключить MFA"),async fd=>{ const result=await api('/api/mfa/disable',{method:'POST',body:{currentPassword:fd.get('currentPassword'),code:fd.get('code')}});acceptSession(result);$('#dialog').close();toast(t("MFA отключена"));loadPage(); });
  }
  async function newKey() {
    const [buckets, accountList] = await Promise.all([api('/api/buckets'),admin()?api('/api/users'):Promise.resolve({users:[]})]);
    const choices=accountList.users || [];
    const content=`<div class="stack">${field(t("Название приложения"),'label','text','','required maxlength="100"')}${admin()?`<div class="field"><label for="key-owner">${esc(t("Владелец"))}</label><select id="key-owner" name="owner">${choices.filter(user=>user.enabled).map(user=>`<option value="${esc(user.username)}" ${user.username===username()?'selected':''}>${esc(user.username)} · ${esc(names()[user.role])}</option>`).join('')}</select></div>`:''}<fieldset><legend>${esc(t("Разрешённые операции"))}</legend><div class="permission-grid">${Object.entries(permissionNames()).filter(([key])=>writable()||['read','list'].includes(key)).map(([key,label])=>checked('permissions',key,label,['read','list'].includes(key))).join('')}</div></fieldset><fieldset><legend>${esc(t("Бакеты"))}</legend>${checked('allBuckets','yes',t("Все существующие и будущие бакеты"),true)}<div class="permission-grid section-gap">${(buckets.buckets || []).map(bucket=>checked('buckets',bucket.name,bucket.name)).join('')}</div></fieldset><div class="field"><label for="key-prefixes">${esc(t("Разрешённые префиксы, по одному в строке"))}</label><textarea id="key-prefixes" name="prefixes" rows="3" placeholder="photos/\nbackups/"></textarea><small>${esc(t("Пусто — все объекты. С префиксами нельзя разрешить создание и удаление бакетов."))}</small></div>${field(t("Срок действия (необязательно)"),'expiresAt','datetime-local')}</div>`;
    formDialog(t("Создать ключ доступа"),content,t("Создать ключ"),async fd=>{
      const permissions=fd.getAll('permissions'), all=fd.get('allBuckets')==='yes', selected=fd.getAll('buckets');
      if(!all&&!selected.length)throw new Error(t("Выберите хотя бы один бакет."));
      const body={label:String(fd.get('label')).trim(),role:permissions.some(p=>!['read','list'].includes(p))?'readwrite':'readonly',permissions,buckets:all?[]:selected,prefixes:String(fd.get('prefixes')).split('\n').map(s=>s.trim()).filter(Boolean),expiresAt:fd.get('expiresAt')?new Date(fd.get('expiresAt')).toISOString():null};
      if(admin())body.owner=fd.get('owner');
      const result=await api('/api/keys',{method:'POST',body});$('#dialog').close();
      openDialog(t("Ключ доступа создан"),`<div class="notice warn">${icon('key')}<div>${esc(t("Сохраните секрет сейчас. Он не будет показан повторно."))}</div></div><div class="stack section-gap">${field('Access key','accessKey','text',result.accessKey,'readonly')}${field('Secret key','secretKey','text',result.secretKey,'readonly')}${button(t("Скопировать секрет"),'copy','','copy',`data-copy="${esc(result.secretKey)}"`)}</div><div class="form-actions">${button(t("Я сохранил ключ"),'close-dialog','primary','check')}</div>`);if(state.page==='keys')loadPage();
    });
  }

  // Multipart descriptors contain file identity and upload IDs, never credentials.
  const descriptorsKey = () => `27g:multipart:${username()}`;
  const descriptor = item => ({ id:item.id,bucket:item.bucket,key:item.key,name:item.name,size:item.size,lastModified:item.lastModified,partSize:item.partSize,fingerprint:item.fingerprint,partHashes:item.partHashes });
  function persistUploads() {
    if (!username()) return;
    try { localStorage.setItem(descriptorsKey(),JSON.stringify(state.uploads.filter(item=>item.id&&!['done','cancelled'].includes(item.status)).map(descriptor))); }
    catch { toast(t("Браузер не смог сохранить сведения для продолжения загрузки после закрытия вкладки."),true); }
  }
  async function fileIdentity(file,stopped=()=>false) {
    const hashes=[];
    for(let offset=0;offset<file.size || offset===0;offset+=partSize){if(stopped())throw new Error(t("Проверка файла приостановлена."));const chunk=await file.slice(offset,Math.min(offset+partSize,file.size)).arrayBuffer();const digest=await crypto.subtle.digest('SHA-256',chunk);hashes.push([...new Uint8Array(digest)].map(n=>n.toString(16).padStart(2,'0')).join(''));if(!file.size)break;}
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
  const statusNames=()=>({queued:t("В очереди"),checking:t("Проверяем файл"),uploading:t("Загружается"),paused:t("Приостановлено"),error:t("Ошибка"),done:t("Готово"),cancelled:t("Отменено")});
  function uploadButtons(item) {
    const ref=esc(item.clientId||item.id);
    if(['uploading','checking','queued'].includes(item.status))return button(t("Пауза"),'upload-pause','small','clock',`data-upload="${ref}"`);
    if(['paused','error'].includes(item.status))return button(item.file?t("Продолжить"):t("Выбрать исходный файл"),'upload-resume','small','upload',`data-upload="${ref}"`)+button(t("Отменить загрузку"),'upload-abort','small danger','x',`data-upload="${ref}"`);
    return '';
  }
  function uploadRow(item,compact=false) {
    return `<div class="upload-row"><div class="row between wrap"><div class="upload-name"><strong title="${esc(item.key)}">${esc(item.key)}</strong><small>${esc(item.bucket)}${Number.isFinite(item.size)?' · '+bytes(item.size):''}</small></div><span class="badge ${item.status==='done'?'success':item.status==='error'?'warn':''}">${esc(statusNames()[item.status]||item.status)}${item.status==='uploading'?' · '+item.progress+'%':''}</span></div>${item.status==='uploading'?`<progress max="100" value="${item.progress}" aria-label="${esc(t("Загрузка"))} ${esc(item.key)}"></progress>`:''}${item.error?`<p class="form-error" role="status">${esc(item.error)}</p>`:''}<div class="row wrap ${compact?'':'section-gap'}">${uploadButtons(item)}</div></div>`;
  }
  function renderQueue() {
    const host=$('#upload-container');if(!host)return;
    if(!state.uploads.length||state.page==='uploads'){host.innerHTML='';if(state.page==='uploads'&&$('#upload-list'))$('#upload-list').innerHTML=state.uploads.length?state.uploads.map(item=>uploadRow(item)).join(''):`<div class="empty"><h3>${esc(t("Нет незавершённых загрузок"))}</h3><p>${esc(t("Откройте бакет и выберите файлы."))}</p></div>`;return;}
    const active=state.uploads.filter(item=>['queued','checking','uploading'].includes(item.status)).length;
    host.innerHTML=`<section class="queue-drawer" aria-label="${esc(t("Очередь загрузки"))}"><div class="queue-head"><a href="#uploads"><strong>${active?t("Загружаем файлов: ")+active:t("Загрузки: ")+state.uploads.length}</strong></a>${active?button(t("Пауза всем"),'cancel-uploads','small ghost','clock'):button(t("Скрыть завершённые"),'uploads-clear','small ghost','check')}</div><div class="queue-list">${state.uploads.slice(-5).map(item=>uploadRow(item,true)).join('')}</div></section>`;
  }
  function pauseAll() { for(const item of state.uploads){if(['queued','uploading','checking'].includes(item.status)){item.stopRequested=true;item.status='paused';item.xhr?.abort();}}persistUploads();renderQueue(); }
  async function enqueueFiles(files) {
    if(!writable())throw new Error(t("Наблюдателю недоступна загрузка файлов."));
    if(!crypto.subtle)throw new Error(t("Для безопасного продолжения загрузок откройте панель через HTTPS или localhost."));
    const selected=[...files].slice(0,Math.max(0,100-state.uploads.filter(item=>item.status!=='done').length));
    if(selected.length<files.length)toast(t("Одновременно можно хранить до 100 заданий в браузере."),true);
    for(const file of selected){state.uploads.push({clientId:crypto.randomUUID(),file,name:file.name,size:file.size,lastModified:file.lastModified,bucket:state.bucket,key:state.prefix+file.name,partSize,status:'queued',progress:0,error:''});}
    renderQueue();pumpUploads();
  }
  function pumpUploads(){if(!state.user)return;const active=state.uploads.filter(item=>item.running).length;state.uploads.filter(item=>item.status==='queued'&&item.file&&!item.running).slice(0,Math.max(0,state.uploadConcurrency-active)).forEach(item=>{item.runPromise=startUpload(item);});}
  async function allParts(item){let marker,parts=[];do{const result=await api(uploadUrl(item)+(marker?'&partNumberMarker='+marker:''));parts.push(...(result.parts||[]));marker=result.isTruncated?result.nextPartNumberMarker:null;if(result.isTruncated&&!marker)throw new Error(t("Сервер не вернул продолжение списка частей."));}while(marker);return parts;}
  function sendPart(item,n,blob,completedBytes){return new Promise((resolve,reject)=>{
    const xhr=new XMLHttpRequest();item.xhr=xhr;xhr.open('PUT',uploadUrl(item,`/parts/${n}`));xhr.setRequestHeader('Content-Type','application/octet-stream');xhr.setRequestHeader('X-CSRF-Token',state.csrf||'');
    xhr.upload.onprogress=event=>{if(event.lengthComputable){item.progress=Math.min(99,Math.round((completedBytes+event.loaded)/Math.max(1,item.file.size)*100));renderQueue();}};
    xhr.onload=()=>{item.xhr=null;let value;try{value=JSON.parse(xhr.responseText);}catch{}if(xhr.status>=200&&xhr.status<300)resolve(value);else reject(new Error(serverText(value?.error?.message||value?.error)||t("Ошибка части {p0}: {p1}", {p0: n, p1: xhr.status})));};
    xhr.onerror=()=>{item.xhr=null;reject(new Error(t("Соединение прервано. Сохранённые части можно продолжить позже.")));};xhr.onabort=()=>{item.xhr=null;reject(new Error(t("Загрузка приостановлена.")));};xhr.send(blob);
  });}
  async function startUpload(item){
    const actor=username(), stopped=()=>item.stopRequested||username()!==actor;
    item.running=true;item.stopRequested=false;item.status='checking';item.error='';renderQueue();
    try{
      const identity=await fileIdentity(item.file,stopped);if(stopped())return;
      if(item.fingerprint&&identity.fingerprint!==item.fingerprint)throw new Error(t("Выбран другой файл: контрольная сумма не совпадает с исходной загрузкой."));
      Object.assign(item,identity,{name:item.file.name,size:item.file.size,lastModified:item.file.lastModified});
      if(!item.id){const created=await api('/api/uploads',{method:'POST',body:{bucket:item.bucket,key:item.key,contentType:item.file.type||'application/octet-stream'}});item.id=created.uploadId;item.initiated=created.initiated;persistUploads();}
      if(stopped())return;
      const remote=await allParts(item),uploaded=new Map(remote.map(p=>[p.partNumber,p]));if(stopped())return;
      for(const part of remote){if(part.partNumber>identity.partHashes.length||part.sha256!==identity.partHashes[part.partNumber-1])throw new Error(t("Исходный файл не совпадает с уже сохранёнными частями. Выберите правильный файл или отмените это задание."));}
      item.status='uploading';const parts=[];let completedBytes=0;
      for(let n=1;n<=identity.partHashes.length;n++){
        if(stopped())return;
        const from=(n-1)*partSize,to=Math.min(n*partSize,item.file.size);let result=uploaded.get(n);
        if(!result)result=await sendPart(item,n,item.file.slice(from,to),completedBytes);
        if(stopped())return;
        parts.push({partNumber:n,etag:result.etag});completedBytes+=to-from;item.progress=Math.round(completedBytes/Math.max(1,item.file.size)*100);persistUploads();renderQueue();
      }
      await api(uploadUrl(item,'/complete'),{method:'POST',body:{parts}});item.status='done';item.progress=100;item.file=null;persistUploads();if(username()!==actor)return;toast(t("Файл «{p0}» сохранён", {p0: item.key}));
      if(state.page==='objects'&&state.bucket===item.bucket)loadPage();
    }catch(error){if(!stopped()){item.status='error';item.error=serverText(error.message);}persistUploads();}
    finally{item.xhr=null;item.running=false;renderQueue();pumpUploads();}
  }
  function findUpload(id){return state.uploads.find(item=>item.id===id||item.clientId===id);}
  function resumeUpload(item){
    if(item.file){item.status='queued';pumpUploads();return;}
    openDialog(t("Продолжить загрузку"),`<p>${esc(t("Выберите исходный файл для"))} <strong>${esc(item.key)}</strong>${esc(t(". Система сверит контрольные суммы и отправит только отсутствующие части."))}</p>${item.size!==undefined?`<p class="small-summary">${esc(t("Размер исходного файла:"))} ${bytes(item.size)}.</p>`:''}<div class="field"><label for="resume-file">${esc(t("Исходный файл"))}</label><input id="resume-file" type="file" required></div><div class="form-error" role="alert"></div>`);
    $('#resume-file').addEventListener('change',event=>{const file=event.target.files[0];if(!file)return;if(item.size!==undefined&&item.size!==file.size){$('.form-error',$('#dialog')).textContent=t("Размер не совпадает с исходным файлом.");return;}item.file=file;item.status='queued';$('#dialog').close();pumpUploads();});
  }
  async function uploadsPage() {await restoreUploads();return heading(t("Загрузки"),t("Части хранятся на сервере. После обрыва выберите тот же файл и продолжите."),button(t("Обновить"),'refresh','','refresh'))+`<div class="notice">${icon('info')}<div>${esc(t("Файлы передаются частями по 8 МиБ. Пауза сохраняет уже принятые части; отмена удаляет задание. После перезагрузки страницы браузеру нужно повторно указать исходный файл."))}</div></div><section class="panel section-gap"><div id="upload-list">${state.uploads.length?state.uploads.map(item=>uploadRow(item)).join(''):`<div class="empty"><h3>${esc(t("Нет незавершённых загрузок"))}</h3><p>${esc(t("Откройте бакет и выберите файлы."))}</p></div>`}</div></section>`; }
  async function previewObject(key,versionId) {
    const bucket=state.bucket,params={bucket,key,...(versionId?{versionId}:{})},controller=new AbortController();
    openDialog(t("Предпросмотр файла"),`<h3 class="preview-name">${esc(key)}</h3><div id="preview-content" class="loading" role="status">${esc(t("Загружаем предпросмотр…"))}</div><div class="form-actions"><a class="button" href="/api/object?${query(params)}" download>${icon('download')}${esc(t("Скачать"))}</a>${button(t("Закрыть"),'close-dialog')}</div>`);
    const dialog=$('#dialog'),host=$('#preview-content');dialog.classList.add('preview-dialog');
    const cleanup=()=>{controller.abort();dialog.removeEventListener('dialog-replace',cleanup);dialog.removeEventListener('close',cleanup);};
    dialog.addEventListener('dialog-replace',cleanup);dialog.addEventListener('close',cleanup);
    try {
      const result=await api('/api/preview?'+query(params),{signal:controller.signal});
      if(controller.signal.aborted||!host.isConnected)return;
      host.className='';host.removeAttribute('role');host.replaceChildren();
      const meta=document.createElement('div');meta.className='preview-meta';
      for(const value of [bytes(result.size),result.contentType||t("Тип не указан"),versionId?t("Сохранённая версия"):t("Текущая версия")]){const item=document.createElement('span');item.textContent=value;meta.append(item);}host.append(meta);
      if(result.kind==='image'&&result.url){
        const url=new URL(result.url,location.origin);if(url.origin!==location.origin||url.pathname!=='/api/preview')throw new Error(t("Сервер вернул недопустимый адрес предпросмотра."));
        const canvas=document.createElement('div');canvas.className='preview-canvas';const img=document.createElement('img');img.alt=key;img.decoding='async';img.src=url.href;
        img.addEventListener('error',()=>{canvas.textContent=t("Не удалось показать изображение. Можно скачать файл.");},{once:true});canvas.append(img);host.append(canvas);
      }else if(result.kind==='text'){
        const pre=document.createElement('pre');pre.className='preview-text';pre.tabIndex=0;pre.setAttribute('aria-label',t("Содержимое файла"));pre.textContent=result.text||'';host.append(pre);
        if(result.truncated){const note=document.createElement('p');note.className='preview-note';note.textContent=t("Показано начало файла. Для просмотра целиком скачайте его.");host.append(note);}
      }else{
        const empty=document.createElement('div');empty.className='empty';const title=document.createElement('h3');title.textContent=t("Предпросмотр недоступен");const note=document.createElement('p');note.textContent=serverText(result.reason)||t("Этот тип файла можно скачать и открыть в подходящем приложении.");empty.append(title,note);host.append(empty);
      }
    }catch(error){if(!controller.signal.aborted&&host.isConnected){host.className='notice error';host.textContent=serverText(error.message);}}
  }
  async function bucketAccess() {
    const bucket=state.bucket,policy=await api('/api/bucket-access?'+query({bucket}));
    formDialog(t("Доступ к бакету {p0}", {p0: bucket}),`<p class="small-summary">${esc(t("Закрытый бакет требует входа или разрешённого S3-ключа. Открытый разрешает чтение файла по точному пути. Анонимный список файлов и запись запрещены в обоих режимах."))}</p><div class="access-options"><label class="access-option"><input type="radio" name="mode" value="private" ${policy.mode!=='public-read'?'checked':''}><span><strong>${esc(t("Закрытый"))}</strong><small>${esc(t("Авторизация или временная ссылка на файл"))}</small></span></label><label class="access-option"><input type="radio" name="mode" value="public-read" ${policy.mode==='public-read'?'checked':''}><span><strong>${esc(t("Открытый по прямой ссылке"))}</strong><small>${esc(t("Без входа, только чтение по полному пути"))}</small></span></label></div><div id="public-access-options" class="stack section-gap"><div class="field"><label for="bucket-read-prefixes">${esc(t("Открытые префиксы, по одному в строке"))}</label><textarea id="bucket-read-prefixes" name="readPrefixes" rows="3" placeholder="photos/
public/"></textarea><small>${esc(t("Пусто — все файлы бакета. photos/ открывает только пути, начинающиеся с photos/. Учитывается регистр."))}</small></div><div class="notice warn">${icon('info')}<div>${esc(t("Любой, кто получит или угадает полный путь, сможет читать эти файлы. Для личных данных оставьте бакет закрытым и используйте временные ссылки."))}</div></div></div>`,t("Сохранить доступ"),async fd=>{
      const mode=fd.get('mode'),readPrefixes=String(fd.get('readPrefixes')||'').split('\n').filter(value=>value!=='');
      await api('/api/bucket-access?'+query({bucket}),{method:'PUT',body:{mode,readPrefixes:mode==='public-read'?readPrefixes:[]}});$('#dialog').close();toast(mode==='public-read'?t("Чтение по прямым ссылкам включено"):t("Бакет закрыт"));loadPage();
    });
    $('#bucket-read-prefixes').value=(policy.readPrefixes||[]).join('\n');
    const update=()=>{const enabled=$('[name="mode"]:checked',$('#dialog')).value==='public-read';$('#public-access-options').hidden=!enabled;$('#bucket-read-prefixes').disabled=!enabled;};
    $$('[name="mode"]',$('#dialog')).forEach(input=>input.addEventListener('change',update));update();
  }
  async function permanentLink(key) {
    const bucket=state.bucket,[policy,status]=await Promise.all([api('/api/bucket-access?'+query({bucket})),api('/api/status')]);
    if(policy.mode!=='public-read'||(policy.readPrefixes?.length&&!policy.readPrefixes.some(prefix=>key.startsWith(prefix)))){
      openDialog(t("Файл закрыт для прямого доступа"),`<p>${esc(t("Этот файл доступен авторизованным пользователям. Создайте временную ссылку или измените политику бакета."))}</p><div class="form-actions">${button(t("Доступ бакета"),'bucket-access','','shield')}${button(t("Временная ссылка"),'share-object','primary','link',`data-key="${esc(key)}"`)}</div>`);return;
    }
    if(key.split('/').some(segment=>segment==='.'||segment==='..')){openDialog(t("Используйте временную ссылку"),`<p>${esc(t("В этом имени есть сегмент . или .., который браузер изменяет в обычном URL. Временная ссылка сохранит точный путь к файлу."))}</p><div class="form-actions">${button(t("Создать временную ссылку"),'share-object','primary','link',`data-key="${esc(key)}"`)}</div>`);return;}
    const url=(status.endpoint||location.origin).replace(/\/$/,'')+'/'+encodeURIComponent(bucket)+'/'+key.split('/').map(encodeURIComponent).join('/');
    openDialog(t("Постоянная ссылка на файл"),`<p class="small-summary">${esc(t("Ссылка действует, пока бакет разрешает чтение этого пути. Она показывает текущую версию файла; авторизация не требуется."))}</p>${field(t("Полный адрес файла"),'publicFileUrl','text',url,'readonly')}<div class="form-actions">${button(t("Скопировать ссылку"),'copy','primary','copy',`data-copy="${esc(url)}"`)}</div>`);
  }
  function objectMenu(key) {
    const bucket=state.bucket;
    openDialog(t("Действия с файлом"),`<strong class="preview-name">${esc(key)}</strong><p class="object-path">${esc(bucket)} / ${esc(key)}</p><div class="object-action-list">${button(t("Предпросмотр"),'object-preview','','eye',`data-key="${esc(key)}"`)}${button(t("История версий"),'object-history','','clock',`data-key="${esc(key)}"`)}${admin()?button(t("Постоянная ссылка"),'object-permanent-link','','link',`data-key="${esc(key)}"`):''}${writable()?button(t("Поделиться временной ссылкой"),'share-object','','link',`data-key="${esc(key)}"`):''}<a class="button" href="/api/object?${query({bucket,key})}" download>${icon('download')}${esc(t("Скачать файл"))}</a>${writable()?button(t("Переместить в корзину"),'delete-object','danger','trash',`data-key="${esc(key)}"`):''}</div>`);
  }
  async function showVersions(key) {
    const bucket=state.bucket,result=await api('/api/versions?'+query({bucket,key})),versions=(result.versions||[]).filter(version=>version.key===key);
    openDialog(t("История файла"),`<div class="share-object-name">${icon('file')}<strong>${esc(key)}</strong></div><p class="small-summary">${esc(t("Хранятся до пяти версий содержимого. Удаление создаёт отметку в корзине. Восстановление публикует выбранную версию как текущую."))}</p>${versions.length?`<div class="version-list">${versions.map(version=>`<article class="version-row"><div><strong>${version.isDeleteMarker?t("Удалён в корзину"):date(version.modifiedAt)}</strong><p class="tiny muted">${version.isDeleteMarker?date(version.modifiedAt):bytes(version.size)+' · '+esc(version.owner||'—')}</p><code class="tiny">${esc(version.versionId)}</code></div><div class="stack">${version.isLatest?`<span class="badge accent">${esc(t("Текущее состояние"))}</span>`:''}<div class="row wrap">${!version.isDeleteMarker?`${button(t("Просмотр"),'object-preview','small','eye',`data-key="${esc(key)}" data-version="${esc(version.versionId)}"`)}<a class="button small" href="/api/object?${query({bucket,key,versionId:version.versionId})}" download>${icon('download')}${esc(t("Скачать"))}</a>${writable()?button(t("Восстановить"),'version-restore','small','refresh',`data-bucket="${esc(bucket)}" data-key="${esc(key)}" data-version="${esc(version.versionId)}"`):''}`:''}${admin()?button(t("Удалить навсегда"),'version-delete','small danger','trash',`data-bucket="${esc(bucket)}" data-key="${esc(key)}" data-version="${esc(version.versionId)}"`):''}</div></div></article>`).join('')}</div>`:`<p>${esc(t("Сохранённых версий нет."))}</p>`}`);
  }
  async function showTrash() {
    const bucket=state.bucket,result=await api('/api/trash?'+query({bucket})),objects=result.objects||[];
    openDialog(t("Корзина: {p0}", {p0: bucket}),`<p class="small-summary">${esc(t("Удалённые файлы сохраняют историю. Полная очистка удаляет все версии выбранного объекта и не может быть отменена."))}</p>${objects.length?`<div class="version-list">${objects.map(object=>`<article class="version-row"><div><strong>${esc(object.key)}</strong><p class="tiny muted">${date(object.modifiedAt)}</p></div><div class="row wrap">${writable()&&object.restoreVersionId?button(t("Восстановить"),'version-restore','small','refresh',`data-bucket="${esc(bucket)}" data-key="${esc(object.key)}" data-version="${esc(object.restoreVersionId)}"`):`<span class="tiny muted">${esc(t("Нет версии для восстановления"))}</span>`}${admin()?button(t("Удалить навсегда"),'trash-purge','small danger','trash',`data-bucket="${esc(bucket)}" data-key="${esc(object.key)}"`):''}</div></article>`).join('')}</div>`:`<div class="empty"><h3>${esc(t("Корзина пуста"))}</h3><p>${esc(t("Здесь появятся удалённые объекты."))}</p></div>`}`);
  }
  function permanentDelete(target,all=false) {
    const {bucket,key,version}=target.dataset;
    formDialog(all?t("Удалить все версии навсегда?"):t("Удалить эту версию навсегда?"),`<div class="notice warn">${icon('trash')}<div>${all?t("Будут удалены все сохранённые версии объекта"):t("Будет безвозвратно удалена выбранная версия")} <strong>${esc(key)}</strong>${esc(t(". Это действие нельзя отменить."))}</div></div>${field(t("Введите УДАЛИТЬ для подтверждения"),'confirmation','text','','required autocomplete="off"')}`,t("Удалить навсегда"),async fd=>{
      if(fd.get('confirmation')!==t("УДАЛИТЬ"))throw new Error(t("Для подтверждения введите УДАЛИТЬ."));
      await api(all?'/api/trash/purge':'/api/version?'+query({bucket,key,versionId:version}),all?{method:'POST',body:{bucket,key}}:{method:'DELETE'});$('#dialog').close();toast(t("Данные удалены окончательно"));loadPage();
    });
  }
  async function bucketQuota() {
    const bucket=state.bucket,data=await api('/api/bucket-quota?'+query({bucket})),limits=data.quota||data;
    formDialog(t("Квота бакета {p0}", {p0: bucket}),`<p class="small-summary">${esc(t("Учитываются текущие объекты, сохранённые версии и незавершённые части. Пусто — без лимита, 0 — запрет новых данных."))}</p><div class="form-grid">${field(t("Максимальный объём, МиБ"),'maxMB','number',limits.maxBytes==null?'':limits.maxBytes/1048576,t("min=\"0\" step=\"any\" placeholder=\"Без лимита\""))}${field(t("Максимум объектов и версий"),'maxObjects','number',limits.maxObjects??'',t("min=\"0\" step=\"1\" placeholder=\"Без лимита\""))}</div>`,t("Сохранить квоту"),async fd=>{await api('/api/bucket-quota?'+query({bucket}),{method:'PUT',body:{maxBytes:fd.get('maxMB')===''?null:Math.round(Number(fd.get('maxMB'))*1048576),maxObjects:fd.get('maxObjects')===''?null:Number(fd.get('maxObjects'))}});$('#dialog').close();toast(t("Квота сохранена"));});
  }
  function metric(label,value,note='') { return `<article class="metric-card"><span>${esc(label)}</span><strong>${esc(value)}</strong>${note?`<small>${esc(note)}</small>`:''}</article>`; }
  function historyChart(series) {
    const values=series.map(point=>({at:point.at,p95:Number(point.p95??point.metrics?.p95??0)})).filter(point=>Number.isFinite(point.p95));
    if(values.length<2)return `<p class="small-summary">${esc(t("Для графика нужно несколько замеров. Обновите экран после работы с файлами."))}</p>`;
    const max=Math.max(1,...values.map(point=>point.p95)),points=values.map((point,i)=>`${Math.round(i/(values.length-1)*600)},${Math.round(110-point.p95/max*100)}`).join(' ');
    return `<figure class="latency-chart"><figcaption>${esc(t("Задержка p95 · от 0 до"))} ${Math.ceil(max)} ${esc(t("мс"))}</figcaption><svg role="img" aria-label="${esc(t("Задержка запросов p95 по времени"))}" viewBox="0 0 600 120" preserveAspectRatio="none"><path d="M0 110H600" class="chart-grid"/><polyline points="${points}" class="chart-line"/></svg><div class="row between tiny muted"><span>${date(values[0].at)}</span><span>${date(values.at(-1).at)}</span></div></figure>`;
  }
  async function monitoringPage() {
    monitoring=await api('/api/monitor');const m=monitoring.metrics||{},thresholds=monitoring.settings||{},alerts=monitoring.alerts||[],ha=monitoring.ha||{};
    return heading(t("Диагностика"),t("Запросы, нагрузка, предупреждения и состояние копий."),button(t("Обновить"),'refresh','','refresh'))+`<div class="metrics-grid">${metric(t("Запросов"),number(m.requests))}${metric(t("Ошибок"),number(m.errors))}${metric(t("Задержка p95"),number(m.p95)+t(" мс"),'p50 '+number(m.p50)+' · p99 '+number(m.p99)+t(" мс"))}${metric(t("Память процесса"),bytes(m.rssBytes))}${metric(t("Загрузки"),number(m.activeUploads),t("В очереди ")+number(m.queuedUploads))}${metric(t("Попадания в кэш"),Number.isFinite(m.cacheHitRatio)?Math.round(m.cacheHitRatio*100)+'%':'—')}</div><div class="overview-grid section-gap">${panel(t("Задержки запросов"),historyChart(monitoring.series||[]))}${panel(t("Предупреждения"),alerts.length?`<div class="stack">${alerts.map(alert=>`<div class="alert-item ${esc(alert.severity)}"><strong>${esc(serverText(alert.message))}</strong><div class="row between"><small>${alert.acknowledgedAt?t("Прочитано ")+date(alert.acknowledgedAt):t("Требует внимания")}</small>${admin()&&!alert.acknowledgedAt?button(t("Прочитано"),'monitor-ack','small','check',`data-id="${esc(alert.id)}"`):''}</div></div>`).join('')}</div>`:`<p class="small-summary">${esc(t("Активных предупреждений нет."))}</p>`)}</div><div class="overview-grid section-gap">${panel(t("Сохранность и доступность"),`<div class="settings-item"><span>${esc(t("Режим координатора"))}</span><strong>${esc(ha.role||t("Одиночный"))}</strong></div><div class="settings-item"><span>${esc(t("Узлы онлайн"))}</span><strong>${(monitoring.nodes||[]).filter(node=>node.online).length} / ${(monitoring.nodes||[]).length}</strong></div><p class="small-summary">${esc(serverText(monitoring.note)||t("Онлайн-статус узлов не заменяет проверку целостности и независимости копий."))}</p>${monitoring.scrub?`<p class="small-summary">${esc(t("Последняя проверка:"))} ${monitoring.scrub.at||monitoring.scrub.finishedAt?date(monitoring.scrub.at||monitoring.scrub.finishedAt):t("время не сохранено")}${esc(t(". Проверено:"))} ${number(monitoring.scrub.checked??monitoring.scrub.result?.checked)}${esc(t(", восстановлено:"))} ${number(monitoring.scrub.repaired??monitoring.scrub.result?.repaired)}.</p>`:''}<a href="#cluster">${esc(t("Перейти к кластеру →"))}</a>`)}${admin()?panel(t("Пороги предупреждений"),`<form id="monitor-settings"><div class="form-grid">${field(t("Заполнение диска, %"),'diskPercent','number',thresholds.diskPercent??85,'required min="1" max="100"')}${field(t("Заполнение очереди, %"),'queuePercent','number',thresholds.queuePercent??80,'required min="1" max="100"')}${field(t("Задержка p95, мс"),'latencyMs','number',thresholds.latencyMs??1000,'required min="10" max="300000"')}</div>${actions(t("Сохранить пороги"))}</form>`):''}</div>`;
  }
  function languagePanel() {
    return panel(t("Язык интерфейса"), `<form id="language-settings"><div class="field"><label for="interface-language">${esc(t("Язык"))}</label><select id="interface-language" name="language"><option value="en" ${getLanguage()==='en'?'selected':''}>English</option><option value="ru" ${getLanguage()==='ru'?'selected':''} lang="ru">Русский</option></select><small>${esc(t("Язык сохраняется в вашем аккаунте и применяется при входе с другого устройства."))}</small></div><div class="form-error" role="alert"></div><div class="form-actions"><button class="button primary" type="submit">${esc(t("Сохранить язык"))}</button></div></form>`);
  }
  async function accountPage() {
    return heading(t("Настройки аккаунта"),`${username()} · ${names()[state.role]||state.role}`)+`<div class="settings-layout"><div class="stack">${panel(t("Изменить пароль"),`<form id="password-form"><div class="stack">${field(t("Текущий пароль"),'currentPassword','password','','required autocomplete="current-password"')}${field(t("Новый пароль"),'password','password','','required minlength="12" autocomplete="new-password"')}${field(t("Повторите пароль"),'repeatPassword','password','','required minlength="12" autocomplete="new-password"')}</div><div class="form-error" id="password-error" role="alert"></div><div class="form-actions"><button type="submit" class="button primary">${esc(t("Обновить пароль"))}</button></div></form>`)}</div><div class="stack">${languagePanel()}${await mfaPanel()}</div></div>`;
  }
  async function networkPanel() {
    const settings=await api('/api/settings');
    return panel(t("Публичный адрес и CORS"),`<form id="network-settings" data-original-origin="${esc(settings.publicOrigin||'')}">${field(t("Публичный адрес хранилища"),'publicOrigin','url',settings.publicOrigin||'','placeholder="https://s3.example.com"')}<p class="small-summary">${esc(t("Этот адрес используется в новых ссылках и для управления панелью. Сначала настройте DNS, HTTPS и прокси на сервере. После смены адреса новые действия в панели потребуется выполнять с выбранного домена. Пустое поле возвращает локальный адрес."))}</p><div class="field"><label for="cors-origins">${esc(t("Разрешённые сайты для S3-запросов, по одному в строке"))}</label><textarea id="cors-origins" name="corsOrigins" rows="3" placeholder="https://app.example.com">${esc((settings.corsOrigins||[]).join('\n'))}</textarea><small>${esc(t("Только точные адреса с http:// или https://, без пути. Это не открывает доступ к панели или приватным файлам."))}</small></div>${actions(t("Сохранить адреса"))}</form>`);
  }
  async function clusterPanels() {
    const [ha,connections,joins]=await Promise.all([admin()?api('/api/ha'):Promise.resolve(state.status?.ha||{enabled:false}),admin()?api('/api/disk-agents'):Promise.resolve({agents:[]}),admin()?api('/api/agent-enrollments'):Promise.resolve({enrollments:[]})]);
    const agents=connections.agents||[],pending=(joins.enrollments||[]).filter(item=>item.status==='pending');
    const currentRole=ha.activeRole||ha.role||'single',enabled=Boolean(ha.enabled);
    return `<div class="overview-grid section-gap">${panel(t("Координаторы и доступность"),`<div class="settings-item"><span>${esc(t("Режим"))}</span><strong>${enabled?'HA · '+esc(currentRole):t("Одиночный координатор")}</strong></div><div class="settings-item"><span>${esc(t("Готовность"))}</span><span class="badge ${ha.ready?'success':'warn'}">${ha.ready?t("Готов к работе"):enabled?t("Проверьте состояние"):t("Один экземпляр")}</span></div>${ha.leaderId?`<div class="settings-item"><span>${esc(t("Активный координатор"))}</span><strong>${esc(ha.leaderId)}</strong></div>`:''}${ha.error?`<p class="form-error">${esc(serverText(ha.error))}</p>`:''}<p class="small-summary">${esc(serverText(ha.message)||serverText(ha.note)||(enabled?t("Роль задаёт участие координатора. Право записи определяется актуальным лидерством и доступностью quorum."):t("Для HA сначала разверните профиль с независимыми координаторами и сервисом quorum по инструкции.")))}</p>${admin()&&enabled?`<div class="row wrap">${button(t("Роль master"),'ha-role','','server','data-role="master"')}${button(t("Роль slave"),'ha-role','','server','data-role="slave"')}</div>`:''}<a class="small-summary" href="#wiki-cluster">${esc(t("Инструкция по кластеру →"))}</a>`)}${panel(t("Серверы и подключённые диски"),`<p class="small-summary">${esc(t("Дисковый агент на сервере подключает существующие диски, папки, SMB и NFS. Новый диск появится в форме узлов; затем проверьте план и сохраните топологию."))}</p>${agents.length?`<div class="stack">${agents.map(agent=>`<div class="agent-row"><div><strong>${esc(agent.label||agent.id)}</strong><small>${esc(agent.url)}</small></div><div class="row wrap">${button(t("Диски"),'agent-disks','small','server',`data-agent="${esc(agent.id)}"`)}${button(t("Отключить связь"),'agent-remove','small danger','x',`data-agent="${esc(agent.id)}"`)}</div></div>`).join('')}</div>`:`<p class="small-summary">${esc(t("Подключённых серверов пока нет. Создайте одну команду и выполните её на нужном сервере."))}</p>`}${pending.length?`<details class="agent-advanced"><summary>${esc(t("Ожидают подключения:"))} ${pending.length}</summary><div class="stack section-gap">${pending.map(item=>`<div class="agent-row"><div><strong>${esc(item.label)}</strong><small>${esc(t("Команда действует до"))} ${date(item.expiresAt)}</small></div>${button(t("Отозвать"),'agent-enrollment-revoke','small danger','x',`data-id="${esc(item.id)}"`)}</div>`).join('')}</div></details>`:''}${admin()?`<div class="form-actions">${button(t("Подключить сервер"),'agent-add','primary','plus')}</div>`:''}`)}</div>`;
  }
  function addAgent() {
    formDialog(t("Подключить сервер одной командой"),`<p class="small-summary">${esc(t("Создайте команду и выполните её в терминале Linux-сервера с установленным Docker. Агент появится здесь автоматически."))}</p>${field(t("Название сервера"),'label','text','',t("required maxlength=\"80\" placeholder=\"Сервер хранения 2\""))}<details class="agent-advanced"><summary>${esc(t("Адрес и параметры установки"))}</summary><div class="stack section-gap">${field(t("Адрес агента (необязательно)"),'agentUrl','url','','placeholder="http://192.168.1.20:9200"')}<p class="tiny muted">${esc(t("Если оставить пустым, используется IP, с которого сервер подключится к панели. При NAT укажите адрес, доступный координатору."))}</p><div class="form-grid">${field(t("Порт агента"),'port','number',9200,'required min="1" max="65535"')}${field(t("Папка для хранения"),'directory','text','/srv/27g-storeges3/disks','required')}</div>${checked('mounts','yes',t("Разрешить подключение готовых /dev-дисков, SMB и NFS"))}<p class="tiny muted">${esc(t("По умолчанию доступны папки. Режим дисков и сетевых ресурсов запускает агент с правами монтирования на сервере. Установка ничего не форматирует."))}</p></div></details><div class="notice section-gap">${icon('info')}<div>${esc(t("Используйте закрытую сеть, VPN или HTTPS. Сервер должен видеть панель, а координатор — адрес агента."))}</div></div>`,t("Создать команду"),async fd=>{
      const result=await api('/api/agent-enrollments',{method:'POST',body:{label:fd.get('label'),agentUrl:String(fd.get('agentUrl')||'').trim(),port:Number(fd.get('port')),directory:fd.get('directory'),mode:fd.get('mounts')==='yes'?'mounts':'folders'}});
      showAgentCommand(result);
    });
    $('.dialog-body form').insertAdjacentHTML('beforeend',`<div class="agent-manual">${button(t("Подключить уже установленный агент"),'agent-manual','ghost small','settings')}</div>`);
  }
  function showAgentCommand(result) {
    openDialog(t("Команда подключения готова"),`<ol class="join-steps"><li>${esc(t("Откройте терминал нужного Linux-сервера."))}</li><li>${esc(t("Скопируйте и выполните команду. Docker должен быть установлен."))}</li><li>${esc(t("Дождитесь установки и проверьте подключение здесь."))}</li></ol><div class="field"><label for="agent-command">${esc(t("Одноразовая команда · до"))} ${date(result.expiresAt)}</label><textarea id="agent-command" class="install-command" readonly rows="5" spellcheck="false"></textarea><small>${esc(t("Команда содержит временный секрет. Не публикуйте её. После закрытия повторно показать её нельзя."))}</small></div><div class="row wrap section-gap">${button(t("Скопировать команду"),'copy','primary','copy',`data-copy="${esc(result.command)}"`)}</div>${result.warnings?.length?`<ul class="small-summary">${result.warnings.map(message=>`<li>${esc(serverText(message))}</li>`).join('')}</ul>`:''}<div id="agent-join-status" class="notice section-gap" role="status">${esc(t("Ожидаем подключения сервера…"))}</div><div class="form-actions">${button(t("Отозвать команду"),'agent-enrollment-revoke','danger','x',`data-id="${esc(result.id)}"`)}${button(t("Проверить подключение"),'agent-enrollment-check','','refresh',`data-id="${esc(result.id)}"`)}</div>`);
    $('#agent-command').value=result.command;
    const dialog=$('#dialog');dialog.dataset.enrollment=result.id;
    let busy=false,stopped=false;
    const stop=()=>{stopped=true;clearInterval(timer);dialog.removeEventListener('dialog-replace',stop);dialog.removeEventListener('close',stop);delete dialog.dataset.enrollment;};
    const timer=setInterval(async()=>{if(stopped||busy)return;busy=true;try{const status=await checkEnrollment(result.id);if(status&&status!=='pending')clearInterval(timer);}catch{}finally{busy=false;}},4000);
    dialog.addEventListener('dialog-replace',stop);dialog.addEventListener('close',stop);
  }
  async function checkEnrollment(id) {
    const result=await api('/api/agent-enrollments'),row=(result.enrollments||[]).find(item=>item.id===id),host=$('#agent-join-status');
    if(!host||$('#dialog').dataset.enrollment!==id)return;
    const status=row?.status||'expired';
    if(status==='connected'){
      host.className='notice section-gap';host.replaceChildren();
      const text=document.createElement('div');text.textContent=t("Сервер {p0} подключён. Теперь можно добавить папку или диск.", {p0: row.label||''});
      host.append(text);host.insertAdjacentHTML('beforeend',button(t("Открыть диски"),'agent-enrollment-done','primary small','server',`data-agent="${esc(row.agentId)}"`));
      $('[data-action="agent-enrollment-revoke"]')?.remove();
    }else if(status==='expired'||status==='revoked'){
      host.className='notice warn section-gap';host.textContent=status==='revoked'?t("Команда отозвана. Для подключения создайте новую."):t("Срок команды истёк. Создайте новую команду подключения.");
      $('[data-action="agent-enrollment-revoke"]')?.remove();
    }else host.textContent=t("Ожидаем подключения сервера… Выполните команду на нужном сервере.");
    return status;
  }
  function addAgentManual() {
    formDialog(t("Подключить сервер дисков"),`<p class="small-summary">${esc(t("Агент должен быть запущен на сервере с нужными дисками. Используйте внутреннюю сеть или HTTPS. Его токен не показывается повторно."))}</p><div class="form-grid">${field(t("ID сервера"),'id','text','','required pattern="[a-zA-Z0-9_-]+" maxlength="64"')}${field(t("Название"),'label','text','','required maxlength="80"')}${field(t("Адрес агента"),'url','url','','required placeholder="http://disk-agent:9200"')}${field(t("Токен агента"),'token','password','','required autocomplete="new-password"')}</div>`,t("Подключить сервер"),async fd=>{await api('/api/disk-agents',{method:'POST',body:Object.fromEntries(fd)});$('#dialog').close();toast(t("Сервер подключён"));loadPage();});
  }
  async function agentDisks(id) {
    const result=await api(`/api/disk-agents/${encodeURIComponent(id)}/disks`),disks=result.disks||[];
    const devices=Array.isArray(result.devices)?result.devices:(result.devices?.blockdevices||[]);
    openDialog(t("Диски сервера"),`<p class="small-summary">${esc(t("Форматирование не выполняется. Подключайте существующую файловую систему или сетевой ресурс. Несколько папок одного физического диска не дают независимых копий."))}</p>${disks.length?`<div class="version-list">${disks.map(disk=>`<article class="version-row"><div><strong>${esc(disk.label||disk.id)}</strong><p class="tiny muted">${esc(({folder:t("Каталог"),device:t("Диск"),smb:'SMB',nfs:'NFS'})[disk.kind]||disk.kind)} · ${esc(disk.source)}</p><span class="badge">${esc(({ready:t("Готов"),pending:t("Ожидание"),unavailable:t("Недоступен")})[disk.state]||disk.state||'—')}</span></div>${button(t("Проверить / подключить"),'disk-retry','small','refresh',`data-agent="${esc(id)}" data-disk="${esc(disk.id)}"`)}</article>`).join('')}</div>`:`<p>${esc(t("Ресурсы ещё не подключены."))}</p>`}${devices.length?`<details class="section-gap"><summary>${esc(t("Обнаруженные устройства"))}</summary><ul class="disk-inventory">${devices.map(device=>`<li><code>${esc(device.path||device.name)}</code> · ${esc(device.fstype||t("без файловой системы"))} · ${esc(device.size||'')}${device.children?.length?`<ul>${device.children.map(child=>`<li><code>${esc(child.path||child.name)}</code> · ${esc(child.fstype||'—')} · ${esc(child.size||'')}</li>`).join('')}</ul>`:''}</li>`).join('')}</ul></details>`:''}<div class="form-actions">${button(t("Подключить диск или ресурс"),'disk-add','primary','plus',`data-agent="${esc(id)}" data-devices="${result.allowDevices?'yes':'no'}"`)}</div>`);
  }
  function addDisk(target) {
    const id=target.dataset.agent,devices=target.dataset.devices==='yes';
    formDialog(t("Подключить диск или сетевой ресурс"),`<div class="form-grid"><div class="field"><label for="disk-kind">${esc(t("Тип ресурса"))}</label><select name="kind" id="disk-kind"><option value="folder">${esc(t("Папка сервера"))}</option>${devices?`<option value="device">${esc(t("Существующий физический раздел"))}</option>`:''}<option value="smb">SMB / Windows share</option><option value="nfs">NFS</option></select></div>${field(t("Название"),'label','text','','required maxlength="80"')}${field(t("Путь или адрес ресурса"),'source','text','','required placeholder="/srv/storage/data"')}</div><p id="disk-source-help" class="small-summary">${esc(t("Папка должна находиться в разрешённом корне дискового агента."))}</p><div id="smb-fields" class="form-grid hidden">${field(t("Пользователь SMB"),'username','text','','autocomplete="off" disabled')}${field(t("Пароль SMB"),'password','password','','autocomplete="new-password" disabled')}${field(t("Домен SMB (необязательно)"),'domain','text','','disabled')}</div>`,t("Подключить и добавить узел"),async fd=>{
      const body=Object.fromEntries(fd);if(body.kind==='smb')body.smbVersion='3.1.1';
      const result=await api(`/api/disk-agents/${encodeURIComponent(id)}/disks`,{method:'POST',body});
      await acceptDisk(result,id);
    });
    $('#disk-kind').addEventListener('change',event=>{const kind=event.target.value;$('#smb-fields').classList.toggle('hidden',kind!=='smb');$$('input',$('#smb-fields')).forEach(input=>input.disabled=kind!=='smb');$('#feature-source').placeholder={folder:'/srv/storage/data',device:'/dev/disk/by-id/…-part1',smb:'//server/share',nfs:'server:/export'}[kind];$('#disk-source-help').textContent={folder:t("Папка должна находиться в разрешённом корне дискового агента."),device:t("Только существующий раздел ext4, XFS или Btrfs. Данные не форматируются."),smb:t("Используется SMB 3.1.1. Учётные данные сохраняются агентом защищённо."),nfs:t("Экспорт NFS должен разрешать доступ серверу дискового агента.")}[kind];});
  }
  async function acceptDisk(result,agentId) {
    if(result.disk?.state!=='ready'){toast(t("Ресурс сохранён, но пока недоступен. Проверьте путь, доступ и состояние сервера."),true);await agentDisks(agentId);return;}
    if(!result.node)throw new Error(t("Ресурс подключён, но настройки узла не получены. Повторите проверку ресурса."));
    const existing=$$('#nodes-form .node-form').some(row=>$('[name=nodeId]',row)?.value===result.node.id);
    if(existing){toast(t("Этот диск уже есть в форме узлов. Проверьте и сохраните топологию."));$('#dialog').close();return;}
    context.addNode(result.node);$('#dialog').close();toast(t("Диск добавлен в форму узлов. Проверьте и сохраните топологию."));$('#topology-form')?.scrollIntoView({block:'start'});
  }
  async function planTopology(body) {
    const plan=await api('/api/cluster/plan',{method:'POST',body:{mode:body.mode,nodes:body.nodes}});
    return new Promise((resolve,reject)=>{
      let settled=false;const dialog=$('#dialog');
      const close=()=>{dialog.removeEventListener('close',close);if(!settled){settled=true;reject(new Error(t("Изменение топологии отменено.")));}};
      formDialog(t("Проверьте план изменения кластера"),`<div class="metrics-grid compact">${metric(t("Узлов"),number(plan.nodeCount))}${metric(t("Полезная ёмкость"),plan.usefulBytes==null?t("Неизвестно"):bytes(plan.usefulBytes))}${metric(t("Объём переноса"),plan.moveBytes==null?t("Неизвестно"):bytes(plan.moveBytes))}</div><p class="small-summary">${esc(t("Режим"))} ${esc(String(plan.mode).toUpperCase())}${esc(t(". Общая физическая ёмкость:"))} ${plan.rawBytes==null?t("неизвестна"):bytes(plan.rawBytes)}${esc(t(". Расчёт не включает место для служебных файлов и резерв восстановления."))}</p>${plan.warnings?.length?`<div class="notice warn"><ul>${plan.warnings.map(warning=>`<li>${esc(serverText(warning))}</li>`).join('')}</ul></div>`:''}${checked('confirmed','yes',t("Подтверждаю план и достаточный запас места"))}`,t("Применить топологию"),async fd=>{
        if(fd.get('confirmed')!=='yes')throw new Error(t("Подтвердите проверенный план."));
        const result=await api('/api/topology',{method:'PUT',body});settled=true;dialog.close();resolve(result);
      });dialog.addEventListener('close',close);
    });
  }

  async function afterRender(page) {
    if(page==='settings'&&admin()) { const host=$('.settings-layout .stack');if(host){const [mfa,network]=await Promise.all([mfaPanel(),networkPanel()]);if(host.isConnected)host.insertAdjacentHTML('beforeend',languagePanel()+mfa+network);} }
    if(page==='cluster'){const main=$('#main'),content=await clusterPanels();if(main.isConnected&&state.page===page)main.insertAdjacentHTML('beforeend',content);}
    if(page==='objects'){
      const toolbar=$('#prefix-form');toolbar?.insertAdjacentHTML('beforeend',button(t("Корзина"),'object-trash','','trash')+(admin()?button(t("Доступ"),'bucket-access','','shield')+button(t("Квота"),'bucket-quota','','settings'):''));
    }
    if(page==='keys') { for(const row of $$('tbody tr')){const key=state.data.find(value=>row.textContent.includes(value.accessKey));if(key)$('td:nth-child(2)',row).insertAdjacentHTML('beforeend',`<div class="tiny muted">${esc(key.permissions?.map(p=>permissionNames()[p]).join(', ')||'')}</div><div class="tiny muted">${esc(t("Владелец:"))} ${esc(key.owner||'—')}</div>${key.prefixes?.length?`<div class="tiny muted">${esc(t("Префиксы:"))} ${esc(key.prefixes.join(', '))}</div>`:''}<div class="tiny muted">${key.expiresAt?t("До ")+date(key.expiresAt):t("Без срока")}</div>`);} }
    if(!writable()){for(const element of $$('[data-action="new-bucket"],[data-action="delete-bucket"],[data-action="delete-object"],[data-action="choose-files"],[data-action="share-object"],#dropzone'))element.hidden=true;}
    if(!admin()){for(const element of $$('#topology-form,[data-action="scrub"],#settings-form'))element.hidden=true;}
  }
  async function click(action,target) {
    if(action==='user-new')editUser();else if(action==='user-edit')editUser(target.dataset.user);else if(action==='mfa-enroll')enrollMfa();else if(action==='mfa-disable')disableMfa();else if(action==='new-key')await newKey();
    else if(action==='cancel-uploads'){pauseAll();toast(t("Загрузки приостановлены. Сохранённые части остаются на сервере."));}
    else if(action==='uploads-clear'){state.uploads=state.uploads.filter(item=>!['done','cancelled'].includes(item.status));persistUploads();renderQueue();}
    else if(action==='upload-pause'){const item=findUpload(target.dataset.upload);if(item){item.stopRequested=true;item.status='paused';item.xhr?.abort();persistUploads();renderQueue();pumpUploads();}}
    else if(action==='upload-resume'){const item=findUpload(target.dataset.upload);if(item)resumeUpload(item);}
    else if(action==='upload-abort'){const item=findUpload(target.dataset.upload);if(item)confirmAction(t("Отменить незавершённую загрузку?"),t("Сохранённые части «{p0}» будут удалены. Готовый объект с таким именем останется.", {p0: item.key}), t("Отменить загрузку"),async()=>{item.stopRequested=true;item.status='paused';item.xhr?.abort();await item.runPromise;if(item.id)await api(uploadUrl(item),{method:'DELETE'});state.uploads=state.uploads.filter(value=>value!==item);persistUploads();renderQueue();});}
    else if(action==='object-menu')objectMenu(target.dataset.key);
    else if(action==='object-preview')await previewObject(target.dataset.key,target.dataset.version);
    else if(action==='object-permanent-link')await permanentLink(target.dataset.key);
    else if(action==='bucket-access')await bucketAccess();
    else if(action==='object-history')await showVersions(target.dataset.key);
    else if(action==='object-trash')await showTrash();
    else if(action==='bucket-quota')await bucketQuota();
    else if(action==='delete-object'){const bucket=state.bucket,key=target.dataset.key;confirmAction(t("Переместить файл в корзину?"),t("Файл «{p0}» исчезнет из текущих объектов. Сохранённую версию можно восстановить из истории или корзины.", {p0: key}), t("В корзину"),async()=>{await api('/api/object?'+query({bucket,key}),{method:'DELETE'});toast(t("Файл перемещён в корзину"));loadPage();});}
    else if(action==='version-restore'){const {bucket,key,version}=target.dataset;confirmAction(t("Восстановить версию?"),t("Выбранная версия «{p0}» станет текущей. Сохраняются до пяти версий содержимого.", {p0: key}), t("Восстановить"),async()=>{await api('/api/versions/restore',{method:'POST',body:{bucket,key,versionId:version}});toast(t("Версия восстановлена"));loadPage();});}
    else if(action==='version-delete')permanentDelete(target);
    else if(action==='trash-purge')permanentDelete(target,true);
    else if(action==='monitor-ack'){await api('/api/monitor/ack',{method:'POST',body:{id:target.dataset.id}});loadPage();}
    else if(action==='agent-add')addAgent();
    else if(action==='agent-manual')addAgentManual();
    else if(action==='agent-enrollment-check')await checkEnrollment(target.dataset.id);
    else if(action==='agent-enrollment-revoke'){await api('/api/agent-enrollments/'+encodeURIComponent(target.dataset.id),{method:'DELETE'});await checkEnrollment(target.dataset.id);toast(t("Команда подключения отозвана"));if(!$('#dialog').open)loadPage();}
    else if(action==='agent-enrollment-done'){await loadPage();await agentDisks(target.dataset.agent);}
    else if(action==='agent-disks')await agentDisks(target.dataset.agent);
    else if(action==='agent-remove'){const id=target.dataset.agent;confirmAction(t("Отключить связь с агентом?"), t("Настройки связи будут удалены. Диски, данные и узлы топологии это действие не удаляет."), t("Отключить связь"),async()=>{await api('/api/disk-agents/'+encodeURIComponent(id),{method:'DELETE'});loadPage();});}
    else if(action==='disk-add')addDisk(target);
    else if(action==='disk-retry'){const result=await api(`/api/disk-agents/${encodeURIComponent(target.dataset.agent)}/disks/${encodeURIComponent(target.dataset.disk)}/retry`,{method:'POST',body:{}});await acceptDisk(result,target.dataset.agent);}
    else if(action==='ha-role'){const role=target.dataset.role;confirmAction(t("Изменить роль координатора?"),t("Назначить этому экземпляру роль {p0}. Активные соединения могут прерваться при переключении.", {p0: role}), t("Назначить роль"),async()=>{await api('/api/ha/role',{method:'PUT',body:{role}});toast(t("Роль изменена"));loadPage();});}
    else return false;return true;
  }
  document.addEventListener('submit',async event=>{
    const form=event.target;if(!['network-settings','monitor-settings','language-settings'].includes(form.id))return;event.preventDefault();
    await submit(form,$('.form-error',form),async()=>{
      const fd=new FormData(form);
      if(form.id==='language-settings'){if(settingsHaveDrafts($$('.settings-layout form')))throw new Error(t('Сначала сохраните или отмените изменения в остальных настройках. Они останутся в форме.'));await context.setLanguagePreference(fd.get('language'));toast(t("Язык сохранён"));return;}
      if(form.id==='network-settings'){
        const body={publicOrigin:String(fd.get('publicOrigin')).trim().replace(/\/$/,''),corsOrigins:String(fd.get('corsOrigins')).split('\n').map(value=>value.trim()).filter(Boolean)};
        const changed=body.publicOrigin!==form.dataset.originalOrigin;
        const save=async()=>{await api('/api/settings',{method:'PUT',body});form.dataset.originalOrigin=body.publicOrigin;for(const input of $$('input, textarea',form))input.defaultValue=input.value;toast(t("Адреса сохранены."));if(changed){const destination=body.publicOrigin||location.origin;form.insertAdjacentHTML('afterend',`<div class="notice warn section-gap"><div>${esc(t("Адрес изменён. Для следующих действий откройте панель по сохранённому адресу. DNS и HTTPS настраиваются на сервере."))}<div class="form-actions"><a class="button primary" href="${esc(destination+'/console/')}">${esc(t("Открыть панель по новому адресу"))}</a></div></div></div>`);}};
        if(changed){formDialog(t("Изменить адрес панели?"),`<p>${esc(t("Новый адрес:"))} <strong>${esc(body.publicOrigin||location.origin)}</strong>.</p><p>${esc(t("После сохранения запросы управления с прежнего адреса могут отклоняться. Убедитесь, что DNS, HTTPS и прокси уже направляют этот адрес на хранилище."))}</p>${checked('ready','yes',t("Адрес настроен; я смогу открыть панель по нему"))}`,t("Сохранить адрес"),async confirmation=>{if(confirmation.get('ready')!=='yes')throw new Error(t("Подтвердите готовность адреса."));await save();$('#dialog').close();});}
        else await save();
      }
      else {await api('/api/monitor/settings',{method:'PUT',body:Object.fromEntries(['diskPercent','queuePercent','latencyMs'].map(key=>[key,Number(fd.get(key))]))});toast(t("Пороги предупреждений сохранены"));}
    });
  });
  function hasPage(page) { return ['users','uploads','monitoring'].includes(page)||page==='settings'&&!admin(); }
  async function page(name) { if(name==='users')return usersPage();if(name==='uploads')return uploadsPage();if(name==='settings')return accountPage();return monitoringPage(); }
  return { hasPage,page,afterRender,click,decorateLogin,restoreUploads,renderQueue,enqueueFiles,pauseAll,planTopology };
}
