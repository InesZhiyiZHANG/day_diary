(() => {
  const STORE_KEY = 'meihao-daily-v1';
  const PROFILE_KEY = 'meihao-shared-profile-v1';
  const PENDING_KEY = 'meihao-shared-pending-v1';
  const moods = [
    { id: 'happy', emoji: '😊', label: '开心' },
    { id: 'calm', emoji: '😌', label: '平静' },
    { id: 'tired', emoji: '🥱', label: '疲惫' },
    { id: 'sad', emoji: '🥺', label: '低落' },
    { id: 'excited', emoji: '🤩', label: '期待' },
  ];
  const today = new Date();
  const dateKey = (date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  const todayKey = dateKey(today);
  let planDate = todayKey;
  const dateFromKey = (key) => {
    const [year, month, day] = key.split('-').map(Number);
    return new Date(year, month - 1, day);
  };
  const prettyDate = (date, options = { month: 'long', day: 'numeric', weekday: 'long' }) =>
    new Intl.DateTimeFormat('zh-CN', options).format(date);
  const emptyData = () => ({ tasks: {}, moods: {}, journals: {}, rollovers: {}, carryChecks: {} });
  const loadData = () => {
    try {
      const stored = JSON.parse(localStorage.getItem(STORE_KEY));
      if (!stored || typeof stored !== 'object') return emptyData();
      return {
        tasks: stored.tasks && typeof stored.tasks === 'object' ? stored.tasks : {},
        moods: stored.moods && typeof stored.moods === 'object' ? stored.moods : {},
        journals: stored.journals && typeof stored.journals === 'object' ? stored.journals : {},
        rollovers: stored.rollovers && typeof stored.rollovers === 'object' ? stored.rollovers : {},
        carryChecks: stored.carryChecks && typeof stored.carryChecks === 'object' ? stored.carryChecks : {},
      };
    } catch {
      return emptyData();
    }
  };

  const data = loadData();
  let currentUser = (() => { try { return JSON.parse(localStorage.getItem(PROFILE_KEY) || 'null'); } catch { return null; } })();
  let sharedMembers = [];
  let syncRevision = 0;
  let syncTimer;
  let syncBusy = false;
  let pendingSync = localStorage.getItem(PENDING_KEY) === '1';
  let syncReady = false;
  let applyingRemote = false;
  let pendingConflict = null;
  let waitingForDraftSave = false;
  let authSetupRequired = false;
  let authMemberCount = 0;
  let authMode = 'login';
  let carriedTaskCount = 0;
  let calendarMonth = new Date(today.getFullYear(), today.getMonth(), 1);
  let selectedDate = todayKey;
  let currentJournalDate = todayKey;
  let selectedMood = data.moods[todayKey]?.mood || '';
  let editingTaskId = '';
  let editingCategory = 'life';
  let addingSubtaskId = '';
  let selectedCategory = 'life';
  const categories = { life: ['🌷', '生活'], study: ['📚', '学习'], fitness: ['💪', '健身'], fun: ['🎨', '娱乐'] };
  let toastTimer;
  const $ = (selector) => document.querySelector(selector);
  const escapeHtml = (value = '') => String(value).replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[char]);
  const authorLabel = (record) => record?.updatedBy ? `<small class="record-by">${escapeHtml(record.updatedBy)} 记录</small>` : '';
  const tasksFor = (key = planDate) => Array.isArray(data.tasks[key]) ? data.tasks[key].filter((task) => !task.deletedAt) : [];
  const rootsFor = (key = planDate) => tasksFor(key).filter((task) => !task.parentId);
  const childrenFor = (id, key = planDate) => tasksFor(key).filter((task) => task.parentId === id);
  function updateParent(parentId, key = planDate) {
    const parent = tasksFor(key).find((task) => task.id === parentId);
    if (parent) { const children = childrenFor(parentId, key); if (children.length) { parent.done = children.every((child) => child.done); stampRecord(parent); } }
  }
  const showToast = (message) => {
    const toast = $('#toast');
    toast.textContent = message;
    toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove('show'), 2100);
  };
  const saveData = () => {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(data));
      if (currentUser && syncReady && !applyingRemote) {
        pendingSync = true;
        localStorage.setItem(PENDING_KEY, '1');
        scheduleSync();
      }
      return true;
    } catch {
      showToast('保存失败，请检查浏览器存储空间');
      return false;
    }
  };

  const stampRecord = (record, create = false) => {
    const now = new Date().toISOString();
    if (currentUser) {
      if (create) { record.createdBy = currentUser.displayName; record.createdById = currentUser.id; }
      record.updatedBy = currentUser.displayName;
      record.updatedById = currentUser.id;
    }
    record.updatedAt = now;
    return record;
  };
  function attributeLegacyRecords(state) {
    if (!currentUser) return;
    const mark = (record) => {
      if (!record.createdBy) { record.createdBy = currentUser.displayName; record.createdById = currentUser.id; }
      if (!record.updatedBy) { record.updatedBy = currentUser.displayName; record.updatedById = currentUser.id; }
      if (!record.updatedAt) record.updatedAt = new Date().toISOString();
    };
    Object.values(state.tasks || {}).flat().forEach(mark);
    Object.values(state.moods || {}).forEach(mark);
    Object.values(state.journals || {}).forEach(mark);
  }
  const clone = (value) => JSON.parse(JSON.stringify(value));
  function mergeCollection(local, remote, keyed = false) {
    const output = { ...(remote || {}) };
    for (const [key, localValue] of Object.entries(local || {})) {
      const remoteValue = output[key];
      if (Array.isArray(localValue) || Array.isArray(remoteValue)) {
        const merged = new Map();
        for (const item of (Array.isArray(remoteValue) ? remoteValue : [])) merged.set(item.id, item);
        for (const item of (Array.isArray(localValue) ? localValue : [])) {
          const previous = merged.get(item.id);
          if (!previous || Date.parse(item.updatedAt || '') >= Date.parse(previous.updatedAt || '')) merged.set(item.id, item);
        }
        output[key] = [...merged.values()];
      } else if (!remoteValue || Date.parse(localValue?.updatedAt || '') >= Date.parse(remoteValue?.updatedAt || '')) {
        output[key] = localValue;
      }
    }
    return output;
  }
  function mergeSharedState(local, remote) {
    return {
      tasks: mergeCollection(local.tasks, remote.tasks),
      moods: mergeCollection(local.moods, remote.moods),
      journals: mergeCollection(local.journals, remote.journals),
      rollovers: { ...(remote.rollovers || {}), ...(local.rollovers || {}) },
      carryChecks: { ...(remote.carryChecks || {}), ...(local.carryChecks || {}) },
    };
  }
  function replaceData(next) {
    for (const key of Object.keys(data)) delete data[key];
    Object.assign(data, next && typeof next === 'object' ? next : {});
    data.tasks ||= {}; data.moods ||= {}; data.journals ||= {}; data.rollovers ||= {}; data.carryChecks ||= {};
  }
  function saveLocalOnly() {
    applyingRemote = true;
    try { localStorage.setItem(STORE_KEY, JSON.stringify(data)); } catch { showToast('本地保存失败，请检查浏览器存储空间'); }
    finally { applyingRemote = false; }
  }
  function setSyncStatus(state, label) {
    const button = $('#collab-open');
    button.dataset.state = state;
    $('#sync-label').textContent = label;
  }
  async function apiRequest(path, options = {}) {
    const response = await fetch(path, {
      credentials: 'same-origin', cache: 'no-store',
      ...options,
      headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...(options.headers || {}) },
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) { const error = new Error(result.error || `请求失败（${response.status}）`); error.status = response.status; error.result = result; throw error; }
    return result;
  }
  function scheduleSync(delay = 650) {
    clearTimeout(syncTimer);
    if (!currentUser || !syncReady || pendingConflict) return;
    syncTimer = setTimeout(syncNow, delay);
  }
  async function syncNow() {
    if (!currentUser || !syncReady || syncBusy || !pendingSync || pendingConflict) return;
    syncBusy = true; pendingSync = false; setSyncStatus('pending', '正在同步');
    try {
      const remote = await apiRequest('/api/state', { method: 'PUT', body: JSON.stringify({ baseRevision: syncRevision, state: data }) });
      syncRevision = remote.revision;
      sharedMembers = remote.members || sharedMembers;
      updateCollabUI();
      setSyncStatus('synced', '已同步');
      saveLocalOnly();
      localStorage.removeItem(PENDING_KEY);
    } catch (error) {
      if (error.status === 409) {
        announceConflict(error.result);
      } else if (error.status === 401) {
        promptLoginAgain();
      } else {
        pendingSync = true;
        setSyncStatus('offline', '离线 · 待同步');
      }
    } finally {
      syncBusy = false;
      if (pendingSync && !pendingConflict) scheduleSync(1000);
    }
  }
  function renderSharedState() {
    renderTasks(); renderCalendar(); renderJournals();
    $('#mood-saved').textContent = currentUser ? '两人共享 · 自动同步' : '只保存在这台设备';
    $('#footer-storage').textContent = currentUser ? '两人共享 · 离线时暂存本机' : '数据保存在当前设备';
    if (!$('#mood-note').matches(':focus')) {
      selectedMood = data.moods[todayKey]?.mood || '';
      $('#mood-note').value = data.moods[todayKey]?.note || '';
      renderMoodOptions();
    }
    if (!$('#journal-body').matches(':focus') && !$('#journal-title').matches(':focus')) loadJournal(currentJournalDate);
  }
  function updateCollabUI() {
    $('#collab-open').classList.toggle('hidden', !currentUser);
    $('#invite-section').classList.toggle('hidden', sharedMembers.length >= 2);
    $('#member-avatars').innerHTML = sharedMembers.slice(0, 2).map((member) => `<span class="member-avatar" title="${escapeHtml(member.displayName)}">${escapeHtml(member.avatar || '🌷')}</span>`).join('');
    $('#member-list').innerHTML = sharedMembers.map((member) => `<div class="member-item"><span class="member-avatar">${escapeHtml(member.avatar || '🌷')}</span><div><strong>${escapeHtml(member.displayName)}</strong><small>${member.id === currentUser?.id ? '这是你' : '共享空间成员'}</small></div></div>`).join('');
  }
  function renderAuth(mode = 'login') {
    authMode = mode;
    const descriptions = { setup: '先创建共享空间，再把邀请码发给另一位成员。', join: '输入对方发来的邀请码，加入同一份日记。', login: '登录后继续和另一位成员共享记录。' };
    $('#auth-description').textContent = descriptions[mode];
    const fields = mode === 'setup' || mode === 'join'
      ? `${mode === 'join' ? '<label>邀请码<input name="inviteCode" autocomplete="one-time-code" required maxlength="40" /></label>' : ''}<label>你的昵称<input name="displayName" required minlength="2" maxlength="20" /></label><label>登录账号<input name="accountName" required minlength="3" maxlength="24" pattern="[A-Za-z0-9_-]+" autocomplete="off" /></label><label>密码（至少 8 位）<input name="password" type="password" required minlength="8" autocomplete="new-password" /></label><label>选择一个小头像<select name="avatar"><option>🌷</option><option>🐰</option><option>🐱</option><option>🧸</option><option>🌼</option><option>🍓</option></select></label>`
      : '<label>登录账号<input name="accountName" required autocomplete="off" /></label><label>密码<input name="password" type="password" required autocomplete="current-password" /></label>';
    const button = mode === 'setup' ? '创建共享空间' : mode === 'join' ? '加入共享空间' : '登录共享空间';
    $('#auth-form').innerHTML = `${fields}<button class="add-button" type="submit">${button}</button><p id="auth-error" class="auth-error" role="status"></p>`;
    const usernameInput = $('#auth-form [name="accountName"]');
    if (usernameInput) usernameInput.addEventListener('input', () => {
      const normalized = usernameInput.value.normalize('NFKC').replace(/[\u200B-\u200D\u2060\uFEFF]/g, '');
      if (normalized !== usernameInput.value) {
        const cursor = usernameInput.selectionStart;
        usernameInput.value = normalized;
        usernameInput.setSelectionRange(cursor, cursor);
      }
    });
    const modes = [];
    if (!authSetupRequired && authMemberCount < 2) modes.push('<button type="button" data-auth-mode="join">我有邀请码</button>');
    if (!authSetupRequired) modes.push('<button type="button" data-auth-mode="login">返回登录</button>');
    modes.push('<button type="button" data-offline-mode>暂时只在这台设备使用</button>');
    modes.push('<button type="button" data-export-local>导出这台设备已有记录</button><label class="import-backup-label">导入备份<input type="file" id="import-backup-file" accept="application/json,.json" /></label>');
    $('#auth-switch').innerHTML = modes.join('');
  }
  async function initializeCollaboration() {
    try {
      const status = await apiRequest('/api/status');
      authSetupRequired = status.setupRequired; authMemberCount = status.memberCount;
      try {
        const session = await apiRequest('/api/auth/me');
        currentUser = session.user; sharedMembers = session.members;
        localStorage.setItem(PROFILE_KEY, JSON.stringify(currentUser));
        const remote = await apiRequest('/api/state');
        const merged = mergeSharedState(data, remote.state);
        const differs = JSON.stringify(merged) !== JSON.stringify(remote.state);
        replaceData(merged); attributeLegacyRecords(data); syncRevision = remote.revision; syncReady = true;
        carriedTaskCount += carryOverYesterday(false);
        saveLocalOnly(); updateCollabUI();
        renderSharedState();
        const hasLocalChanges = JSON.stringify(data) !== JSON.stringify(remote.state);
        if (differs || hasLocalChanges || pendingSync) { pendingSync = true; localStorage.setItem(PENDING_KEY, '1'); scheduleSync(250); } else setSyncStatus('synced', '已同步');
        reportCarryOver();
        return;
      } catch (error) {
        if (error.status !== 401) throw error;
      }
      renderAuth(authSetupRequired ? 'setup' : 'login');
      $('#auth-overlay').hidden = false;
    } catch {
      if (currentUser) {
        syncReady = true;
        carriedTaskCount += carryOverYesterday();
        updateCollabUI(); setSyncStatus('offline', '离线 · 待同步');
        renderSharedState();
        reportCarryOver();
      } else {
        carriedTaskCount += carryOverYesterday();
        renderSharedState();
        reportCarryOver();
        authSetupRequired = true; renderAuth('setup'); $('#auth-overlay').hidden = false;
      }
    }
  }
  async function authenticate(mode, formData) {
    const endpoint = { setup: '/api/auth/setup', join: '/api/auth/join', login: '/api/auth/login' }[mode];
    const credentials = Object.fromEntries(formData);
    if ('accountName' in credentials) { credentials.username = credentials.accountName; delete credentials.accountName; }
    const result = await apiRequest(endpoint, { method: 'POST', body: JSON.stringify(credentials) });
    currentUser = result.user;
    localStorage.setItem(PROFILE_KEY, JSON.stringify(currentUser));
    if (result.inviteCode) $('#invite-code').textContent = result.inviteCode;
    const session = await apiRequest('/api/auth/me');
    sharedMembers = session.members;
    const remote = await apiRequest('/api/state');
    const merged = mergeSharedState(data, remote.state);
    replaceData(merged); attributeLegacyRecords(data); syncRevision = remote.revision; syncReady = true;
    carriedTaskCount += carryOverYesterday(false);
    saveLocalOnly(); updateCollabUI(); renderSharedState();
    $('#auth-overlay').hidden = true;
    if (JSON.stringify(data) !== JSON.stringify(remote.state) || pendingSync) { pendingSync = true; localStorage.setItem(PENDING_KEY, '1'); scheduleSync(100); }
    else { localStorage.removeItem(PENDING_KEY); setSyncStatus('synced', '已同步'); }
    if (result.inviteCode) {
      $('#collab-overlay').hidden = false;
      showToast('共享空间创建好啦，把邀请码发给另一位成员');
    } else showToast('已经加入共享日记啦');
    reportCarryOver();
  }

  function downloadJson(name, content) {
    const url = URL.createObjectURL(new Blob([JSON.stringify(content, null, 2)], { type: 'application/json' }));
    const link = document.createElement('a'); link.href = url; link.download = name; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  async function importBackupFile(file) {
    const parsed = JSON.parse(await file.text());
    const imported = parsed.state || parsed;
    if (!imported || !imported.tasks || typeof imported.tasks !== 'object' || !imported.moods || typeof imported.moods !== 'object' || !imported.journals || typeof imported.journals !== 'object') throw new Error('备份文件内容不完整');
    replaceData(mergeSharedState(data, imported));
    saveData(); renderSharedState();
    showToast(currentUser ? '备份记录已合并，并开始同步' : '本机记录已导入；登录后会合并到共享空间');
  }
  function announceConflict(remote) {
    pendingConflict = remote;
    const time = new Date(remote.updatedAt * 1000).toLocaleString('zh-CN');
    $('#conflict-message').textContent = `共享空间在 ${time} 由 ${remote.updatedBy || '另一位成员'} 保存了新版本。合并会保留双方新增记录；同一条记录按最后保存时间处理。`;
    $('#sync-conflict-overlay').hidden = false;
    setSyncStatus('pending', '需要合并');
  }
  function promptLoginAgain() {
    currentUser = null; sharedMembers = []; syncReady = false;
    localStorage.removeItem(PROFILE_KEY); updateCollabUI();
    authSetupRequired = false; renderAuth('login'); $('#auth-overlay').hidden = false;
    $('#auth-error').textContent = '登录已过期，本机尚未同步的记录会保留。请重新登录后继续同步。';
    setSyncStatus('offline', '需要重新登录');
  }
  function hasUnsavedDraft() {
    if ($('#journal-saved').textContent === '有未保存的修改') return true;
    if ($('#mood-note').value !== (data.moods[todayKey]?.note || '')) return true;
    if ($('#task-list [data-task-edit-input]')) return true;
    if ($('#task-input').value.trim()) return true;
    return Boolean($('#task-list [data-subtask-form] input')?.value.trim());
  }
  async function pollSharedState() {
    if (!currentUser || syncBusy || pendingConflict) return;
    try {
      const remote = await apiRequest('/api/state');
      const nextMembers = remote.members || sharedMembers;
      if (JSON.stringify(nextMembers) !== JSON.stringify(sharedMembers)) { sharedMembers = nextMembers; updateCollabUI(); }
      if (remote.revision <= syncRevision) { if (pendingSync) scheduleSync(100); return; }
      if (pendingSync) { announceConflict(remote); return; }
      if (hasUnsavedDraft()) {
        setSyncStatus('pending', '有新记录 · 请先保存');
        if (!waitingForDraftSave) showToast('另一位成员有新记录；先保存或取消当前编辑，再合并更新');
        waitingForDraftSave = true;
        return;
      }
      waitingForDraftSave = false;
      replaceData(remote.state); syncRevision = remote.revision; sharedMembers = nextMembers;
      saveLocalOnly(); updateCollabUI(); renderSharedState(); setSyncStatus('synced', '已同步');
      localStorage.removeItem(PENDING_KEY);
      showToast(`${remote.updatedBy || '另一位成员'} 添加了新记录`);
    } catch (error) {
      if (error.status === 401) promptLoginAgain();
      else setSyncStatus('offline', '离线 · 待同步');
    }
  }

  function carryOverYesterday(persist = true) {
    if (data.carryChecks[todayKey]) return 0;
    const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
    const yesterdayKey = dateKey(yesterday);
    const carriedIds = new Set(tasksFor(todayKey).filter((task) => task.carrySourceDate === yesterdayKey).map((task) => task.carrySourceId));
    let count = 0;
    const destination = (data.tasks[todayKey] ||= []);
    rootsFor(yesterdayKey).forEach((source) => {
      const sourceChildren = childrenFor(source.id, yesterdayKey);
      const pendingChildren = sourceChildren.filter((child) => !child.done);
      const isPending = sourceChildren.length ? pendingChildren.length > 0 : !source.done;
      if (!isPending || carriedIds.has(source.id)) return;
      const newId = `carry-${yesterdayKey}-${source.id}`;
      destination.push(stampRecord({ id: newId, text: source.text, done: false, category: source.category || 'life', carrySourceDate: yesterdayKey, carrySourceId: source.id }, true));
      pendingChildren.forEach((child) => destination.push(stampRecord({
        id: `carry-${yesterdayKey}-${child.id}`,
        text: child.text, done: false, parentId: newId,
      }, true)));
      count += 1;
    });
    data.carryChecks[todayKey] = true;
    if (persist) saveData();
    return count;
  }
  function reportCarryOver() {
    if (!carriedTaskCount) return;
    showToast(`昨天有 ${carriedTaskCount} 项未完成，已带到今天继续做`);
    carriedTaskCount = 0;
  }

  $('#top-date').textContent = prettyDate(today, { year: 'numeric', month: 'long', day: 'numeric' });
  $('#today-long-date').textContent = `${prettyDate(today, { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' })}  ·  今天也有新的小可能`;
  $('#greeting').innerHTML = `${today.getHours() < 11 ? '早上好，今天也要好好照顾自己' : today.getHours() < 18 ? '今天也要好好照顾自己' : '晚上好，今天辛苦啦'} <span>♡</span>`;

  function switchPage(name) {
    document.querySelectorAll('.nav-item').forEach((button) => {
      const active = button.dataset.page === name;
      button.classList.toggle('active', active);
      button.setAttribute('aria-current', active ? 'page' : 'false');
    });
    document.querySelectorAll('.page').forEach((page) => page.classList.toggle('active-page', page.id === `${name}-page`));
    $('#page-name').textContent = { today: '今日计划', calendar: '日历回顾', journal: '心情随笔' }[name];
    if (name === 'calendar') renderCalendar();
    if (name === 'journal') renderJournals();
  }
  document.querySelectorAll('.nav-item').forEach((button) => button.addEventListener('click', () => switchPage(button.dataset.page)));

  function renderTasks() {
    const readOnly = planDate < todayKey;
    const chosenDate = dateFromKey(planDate);
    $('#plan-date').value = planDate;
    $('#plan-date').min = todayKey;
    $('#plan-date-label').textContent = planDate === todayKey ? '今天' : prettyDate(chosenDate, { month: 'long', day: 'numeric', weekday: 'short' });
    $('#plan-heading').textContent = planDate === todayKey ? '今日计划' : `${prettyDate(chosenDate, { month: 'long', day: 'numeric' })} 计划`;
    const roots = rootsFor();
    const units = roots.flatMap((root) => childrenFor(root.id).length ? childrenFor(root.id) : [root]);
    const doneCount = units.filter((task) => task.done).length;
    const percent = units.length ? Math.round((doneCount / units.length) * 100) : 0;
    $('#task-list').innerHTML = roots.map((task) => {
      const isEditing = task.id === editingTaskId;
      const children = childrenFor(task.id);
      const category = categories[task.category] || categories.life;
      return `<div class="task-group"><div class="task-row ${task.done ? 'done' : ''} ${isEditing ? 'editing' : ''}" data-task-row="${escapeHtml(task.id)}">
        ${readOnly ? `<span class="task-check read-only-check" aria-hidden="true">${task.done ? '✓' : '○'}</span><span class="category-icon" title="${category[1]}">${category[0]}</span><span class="task-text">${escapeHtml(task.text)}</span>${children.length ? `<span class="subtask-count">${children.filter((child) => child.done).length}/${children.length}</span>` : ''}` : isEditing ? `<input class="task-edit-input" data-task-edit-input value="${escapeHtml(task.text)}" maxlength="100" aria-label="编辑计划内容" />${!task.parentId ? `<div class="edit-category-picker" aria-label="修改计划类型">${Object.entries(categories).map(([id, info]) => `<button type="button" data-edit-category="${id}" class="${editingCategory === id ? 'selected' : ''}" aria-pressed="${editingCategory === id}" title="${info[1]}">${info[0]}</button>`).join('')}</div>` : ''}
          <button type="button" class="task-action" data-save-task="${escapeHtml(task.id)}">保存</button>
          <button type="button" class="task-action subtle" data-cancel-task aria-label="取消编辑">取消</button>` : `<input class="task-check" type="checkbox" data-task-check="${escapeHtml(task.id)}" ${task.done ? 'checked' : ''} aria-label="标记完成：${escapeHtml(task.text)}" />
          <span class="category-icon" title="${category[1]}">${category[0]}</span><span class="task-text">${escapeHtml(task.text)}</span>${task.carrySourceDate === planDate ? '<span class="carry-badge">↪ 昨日未完成</span>' : ''}${authorLabel(task)}${children.length ? `<span class="subtask-count">${children.filter((child) => child.done).length}/${children.length}</span>` : ''}
          <button type="button" class="task-action subtle" data-add-subtask="${escapeHtml(task.id)}">＋ 小步骤</button>
          <button type="button" class="task-action subtle" data-edit-task="${escapeHtml(task.id)}" aria-label="编辑：${escapeHtml(task.text)}">编辑</button>
          <button type="button" class="delete-task" data-delete-task="${escapeHtml(task.id)}" aria-label="删除：${escapeHtml(task.text)}">×</button>`}
      </div>${children.map((child) => `<div class="task-child ${child.done ? 'done' : ''}" data-task-row="${escapeHtml(child.id)}">${readOnly ? `<span class="task-check read-only-check" aria-hidden="true">${child.done ? '✓' : '○'}</span><span class="task-text">${escapeHtml(child.text)}</span>` : `<input class="task-check" type="checkbox" data-task-check="${escapeHtml(child.id)}" ${child.done ? 'checked' : ''} aria-label="标记完成：${escapeHtml(child.text)}" />${child.id === editingTaskId ? `<input class="task-edit-input" data-task-edit-input value="${escapeHtml(child.text)}" maxlength="100" aria-label="编辑小步骤" /><button type="button" class="task-action" data-save-task="${escapeHtml(child.id)}">保存</button><button type="button" class="task-action subtle" data-cancel-task>取消</button>` : `<span class="task-text">${escapeHtml(child.text)}</span><button type="button" class="task-action subtle" data-edit-task="${escapeHtml(child.id)}">编辑</button><button type="button" class="delete-task" data-delete-task="${escapeHtml(child.id)}" aria-label="删除小步骤">×</button>`}`}</div>`).join('')}${!readOnly && addingSubtaskId === task.id ? `<form class="subtask-form" data-subtask-form="${escapeHtml(task.id)}"><input maxlength="100" placeholder="写一个小步骤…" aria-label="小步骤内容" required /><button class="task-action" type="submit">添加</button><button class="task-action subtle" type="button" data-cancel-subtask>取消</button></form>` : ''}</div>`;
    }).join('');
    $('#empty-tasks').classList.toggle('hidden', roots.length > 0);
    $('#empty-tasks').innerHTML = readOnly ? '<span>🌼</span><p>这一天还没有计划<br /><small>过去的日期只能回顾哦</small></p>' : '<span>🧸</span><p>清单还是空空的<br /><small>加一件小事，开启今天吧</small></p>';
    $('#category-picker').classList.toggle('hidden', readOnly);
    $('#task-form').classList.toggle('hidden', readOnly);
    $('#plan-readonly-note').classList.toggle('hidden', !readOnly);
    $('#task-count').textContent = `${roots.length} 项计划`;
    $('#progress-number').textContent = `${percent}%`;
    $('#progress-bar').style.width = `${percent}%`;
    $('#progress-text').textContent = units.length ? `小步骤完成 ${doneCount} / ${units.length} 项，继续加油` : '开始安排今天的小目标吧';
  }

  function saveTaskEdit(id) {
    if (planDate < todayKey) { showToast('过去的日期不能修改'); return; }
    const input = $('#task-list [data-task-edit-input]');
    const text = input?.value.trim();
    if (!text) {
      showToast('计划内容还没写哦');
      input?.focus();
      return;
    }
    const task = tasksFor().find((item) => item.id === id);
    if (!task) return;
    task.text = text;
    if (!task.parentId) task.category = editingCategory;
    stampRecord(task);
    editingTaskId = '';
    if (saveData()) {
      renderTasks();
      renderCalendar();
      showToast('计划已更新');
    }
  }

  $('#task-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const input = $('#task-input');
    const text = input.value.trim();
    if (!text) {
      input.focus();
      return;
    }
    const id = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    if (planDate < todayKey) { showToast('过去的日期不能修改'); return; }
    (data.tasks[planDate] ||= []).push(stampRecord({ id, text, done: false, category: selectedCategory }, true));
    if (saveData()) {
      input.value = '';
      editingTaskId = '';
      renderTasks();
      renderCalendar();
      showToast('计划添加好啦 ✿');
      input.focus();
    }
  });
  $('#category-picker').addEventListener('click', (event) => {
    const button = event.target.closest('[data-category]'); if (!button) return;
    selectedCategory = button.dataset.category;
    $('#category-picker').querySelectorAll('[data-category]').forEach((item) => { const active = item === button; item.classList.toggle('selected', active); item.setAttribute('aria-pressed', String(active)); });
  });
  $('#category-picker [data-category="life"]').classList.add('selected');
  $('#plan-date').addEventListener('change', (event) => {
    const value = event.target.value;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || value < todayKey) {
      planDate = todayKey;
      renderTasks();
      showToast('只能安排今天或未来日期的计划');
      return;
    }
    planDate = value;
    editingTaskId = '';
    addingSubtaskId = '';
    renderTasks();
    showToast(value === todayKey ? '已切回今天的计划' : '可以开始安排这一天啦');
  });
  $('#task-list').addEventListener('change', (event) => {
    if (planDate < todayKey) return;
    const id = event.target.dataset.taskCheck;
    if (!id) return;
    const task = tasksFor().find((item) => item.id === id);
    if (!task) return;
    task.done = event.target.checked;
    stampRecord(task);
    if (!task.parentId) childrenFor(task.id).forEach((child) => { child.done = task.done; });
    else updateParent(task.parentId);
    if (!task.parentId) childrenFor(task.id).forEach((child) => stampRecord(child));
    if (saveData()) {
      renderTasks();
      renderCalendar();
    }
  });
  $('#task-list').addEventListener('click', (event) => {
    if (planDate < todayKey) return;
    const editId = event.target.closest('[data-edit-task]')?.dataset.editTask;
    const saveId = event.target.closest('[data-save-task]')?.dataset.saveTask;
    const deleteId = event.target.closest('[data-delete-task]')?.dataset.deleteTask;
    const subtaskId = event.target.closest('[data-add-subtask]')?.dataset.addSubtask;
    if (subtaskId) { addingSubtaskId = subtaskId; renderTasks(); $('#task-list [data-subtask-form] input')?.focus(); return; }
    if (event.target.closest('[data-cancel-subtask]')) { addingSubtaskId = ''; renderTasks(); return; }
    if (editId) {
      editingTaskId = editId;
      const task = tasksFor().find((item) => item.id === editId);
      const parent = task?.parentId ? tasksFor().find((item) => item.id === task.parentId) : null;
      const categoryId = parent?.category || task?.category;
      editingCategory = categories[categoryId] ? categoryId : 'life';
      renderTasks();
      $('#task-list [data-task-edit-input]')?.focus();
    } else if (event.target.closest('[data-edit-category]')) {
      editingCategory = event.target.closest('[data-edit-category]').dataset.editCategory;
      const row = event.target.closest('[data-task-row]');
      row.querySelectorAll('[data-edit-category]').forEach((button) => {
        const active = button.dataset.editCategory === editingCategory;
        button.classList.toggle('selected', active);
        button.setAttribute('aria-pressed', String(active));
      });
    } else if (saveId) {
      saveTaskEdit(saveId);
    } else if (event.target.closest('[data-cancel-task]')) {
      editingTaskId = '';
      renderTasks();
    } else if (deleteId) {
      const removed = tasksFor().find((task) => task.id === deleteId);
      const removedIds = new Set([deleteId]);
      if (removed && !removed.parentId) tasksFor().filter((task) => task.parentId === deleteId).forEach((task) => removedIds.add(task.id));
      (data.tasks[planDate] || []).forEach((task) => { if (removedIds.has(task.id)) { task.deletedAt = new Date().toISOString(); stampRecord(task); } });
      if (removed?.parentId) updateParent(removed.parentId);
      if (saveData()) {
        renderTasks();
        renderCalendar();
        showToast('已删除这项计划');
      }
    }
  });
  $('#task-list').addEventListener('submit', (event) => {
    if (planDate < todayKey) return;
    const form = event.target.closest('[data-subtask-form]'); if (!form) return;
    event.preventDefault(); const input = form.querySelector('input'); const text = input.value.trim(); if (!text) return;
    const parentId = form.dataset.subtaskForm; (data.tasks[planDate] ||= []).push(stampRecord({ id: globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`, text, done: false, parentId }, true));
    const parent = tasksFor().find((task) => task.id === parentId); if (parent) { parent.done = false; stampRecord(parent); }
    addingSubtaskId = ''; if (saveData()) { renderTasks(); renderCalendar(); showToast('小步骤添加好啦'); }
  });
  $('#task-list').addEventListener('keydown', (event) => {
    if (!event.target.matches('[data-task-edit-input]')) return;
    const id = event.target.closest('[data-task-row]').dataset.taskRow;
    if (event.key === 'Enter') {
      event.preventDefault();
      saveTaskEdit(id);
    } else if (event.key === 'Escape') {
      editingTaskId = '';
      renderTasks();
    }
  });

  function renderMoodOptions() {
    $('#mood-options').innerHTML = moods.map((mood) => `<button type="button" class="mood-option ${selectedMood === mood.id ? 'selected' : ''}" data-mood="${mood.id}" title="${mood.label}" aria-label="${mood.label}" aria-pressed="${selectedMood === mood.id}">${mood.emoji}</button>`).join('');
  }
  renderMoodOptions();
  $('#mood-note').value = data.moods[todayKey]?.note || '';
  $('#mood-options').addEventListener('click', (event) => {
    const button = event.target.closest('[data-mood]');
    if (!button) return;
    selectedMood = button.dataset.mood;
    renderMoodOptions();
  });
  $('#save-mood').addEventListener('click', () => {
    const note = $('#mood-note').value.trim();
    if (!selectedMood && !note) {
      showToast('先选一个心情，或写点小感受吧');
      return;
    }
    data.moods[todayKey] = stampRecord({ ...(data.moods[todayKey] || {}), mood: selectedMood, note }, !data.moods[todayKey]);
    if (saveData()) {
      $('#mood-saved').textContent = currentUser ? '刚刚保存 · 两人共享中' : '刚刚保存在这台设备';
      renderCalendar();
      showToast('今天的心情收好啦 ♡');
    }
  });

  function renderCalendar() {
    const year = calendarMonth.getFullYear();
    const month = calendarMonth.getMonth();
    $('#calendar-title').innerHTML = `<span class="calendar-year">${year}</span><strong>${month + 1}</strong><span class="calendar-month-unit">月</span>`;
    const monthPrefix = `${year}-${String(month + 1).padStart(2, '0')}-`;
    const monthRecords = new Set([
      ...Object.keys(data.tasks).filter((key) => key.startsWith(monthPrefix) && tasksFor(key).length),
      ...Object.keys(data.moods).filter((key) => key.startsWith(monthPrefix)),
      ...Object.keys(data.journals).filter((key) => key.startsWith(monthPrefix) && data.journals[key]?.body),
    ]);
    $('#month-summary').textContent = `${monthRecords.size} 天有记录`;
    const first = new Date(year, month, 1);
    const offset = (first.getDay() + 6) % 7;
    const start = new Date(year, month, 1 - offset);
    let html = '';
    for (let index = 0; index < 42; index += 1) {
      const date = new Date(start);
      date.setDate(start.getDate() + index);
      const key = dateKey(date);
      const tasks = rootsFor(key);
      const hasMood = !!data.moods[key];
      const hasJournal = !!data.journals[key]?.body;
      const dots = `${tasks.length ? '<i class="plan-dot"></i>' : ''}${hasMood ? '<i class="mood-dot"></i>' : ''}${hasJournal ? '<i class="journal-dot"></i>' : ''}`;
      const hasRecord = tasks.length > 0 || hasMood || hasJournal;
      const recordLabel = [tasks.length ? `${tasks.length}项计划` : '', hasMood ? '心情' : '', hasJournal ? '随笔' : ''].filter(Boolean).join('、');
      html += `<button type="button" class="calendar-cell ${date.getMonth() === month ? '' : 'outside'} ${hasRecord ? 'has-record' : ''} ${key === todayKey ? 'today' : ''} ${key === selectedDate ? 'selected' : ''}" data-date="${key}" aria-label="${prettyDate(date, { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' })}${recordLabel ? `，有${recordLabel}` : ''}" aria-pressed="${key === selectedDate}"><span class="day-number">${date.getDate()}</span>${key === todayKey ? '<span class="today-label">今天</span>' : ''}<span class="calendar-dots">${dots}</span></button>`;
    }
    $('#calendar-grid').innerHTML = html;
    renderDayDetail();
  }
  function renderDayDetail() {
    const date = dateFromKey(selectedDate);
    const tasks = rootsFor(selectedDate);
    const mood = data.moods[selectedDate];
    const journal = data.journals[selectedDate];
    $('#selected-date-title').textContent = String(date.getDate());
    $('#selected-date-month').textContent = `${date.getMonth() + 1}月`;
    $('#selected-date-subtitle').textContent = prettyDate(date, { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' });
    let html = '';
    if (tasks.length) {
      const units = tasks.flatMap((task) => childrenFor(task.id, selectedDate).length ? childrenFor(task.id, selectedDate) : [task]);
      const done = units.filter((task) => task.done).length;
      html += `<div class="record-section"><h3>今日计划 · ${done}/${units.length} 完成</h3>${tasks.map((task) => { const category = categories[task.category] || categories.life; const children = childrenFor(task.id, selectedDate); return `<div class="record-task ${task.done ? 'done' : ''}"><strong>${category[0]} ${escapeHtml(task.text)}</strong>${authorLabel(task)}</div>${children.map((child) => `<div class="record-task record-child ${child.done ? 'done' : ''}">${child.done ? '✓' : '○'} ${escapeHtml(child.text)}${authorLabel(child)}</div>`).join('')}`; }).join('')}</div>`;
    }
    if (mood) {
      const moodInfo = moods.find((item) => item.id === mood.mood);
      html += `<div class="record-section"><h3>今天的心情</h3><div class="record-mood"><span>${moodInfo?.emoji || '♡'}</span>${moodInfo?.label || '写下了感受'}${authorLabel(mood)}</div>${mood.note ? `<p class="record-note">${escapeHtml(mood.note)}</p>` : ''}</div>`;
    }
    if (journal?.body) html += `<div class="record-section"><h3>心情随笔</h3><div class="record-journal"><strong>${escapeHtml(journal.title || '无题')}</strong>${authorLabel(journal)}<p>${escapeHtml(journal.body)}</p></div></div>`;
    if (!html) html = '<div class="empty-state compact"><span>🌼</span><p>这天还没有记录<br /><small>以后也可以来这里回顾</small></p></div>';
    $('#day-records').innerHTML = html;
  }
  $('#calendar-grid').addEventListener('click', (event) => {
    const button = event.target.closest('[data-date]');
    if (!button) return;
    selectedDate = button.dataset.date;
    const date = dateFromKey(selectedDate);
    if (date.getMonth() !== calendarMonth.getMonth() || date.getFullYear() !== calendarMonth.getFullYear()) {
      calendarMonth = new Date(date.getFullYear(), date.getMonth(), 1);
    }
    renderCalendar();
  });
  $('#prev-month').addEventListener('click', () => {
    calendarMonth = new Date(calendarMonth.getFullYear(), calendarMonth.getMonth() - 1, 1);
    renderCalendar();
  });
  $('#next-month').addEventListener('click', () => {
    calendarMonth = new Date(calendarMonth.getFullYear(), calendarMonth.getMonth() + 1, 1);
    renderCalendar();
  });
  $('#today-month').addEventListener('click', () => {
    calendarMonth = new Date(today.getFullYear(), today.getMonth(), 1);
    selectedDate = todayKey;
    renderCalendar();
  });

  function loadJournal(date) {
    currentJournalDate = date;
    const entry = data.journals[date] || { title: '', body: '' };
    $('#journal-date').textContent = prettyDate(dateFromKey(date), { year: 'numeric', month: 'long', day: 'numeric' });
    $('#journal-title').value = entry.title || '';
    $('#journal-body').value = entry.body || '';
    $('#journal-saved').textContent = data.journals[date]?.body ? (currentUser ? `已保存 · ${data.journals[date].updatedBy || '两人共享'}` : '已保存在这台设备') : (currentUser ? '两人共享 · 自动同步' : '只保存在这台设备');
  }
  loadJournal(todayKey);
  $('#journal-title').addEventListener('input', () => { $('#journal-saved').textContent = '有未保存的修改'; });
  $('#journal-body').addEventListener('input', () => { $('#journal-saved').textContent = '有未保存的修改'; });
  $('#today-journal').addEventListener('click', () => {
    const hasChanges = $('#journal-saved').textContent === '有未保存的修改';
    if (hasChanges && !confirm('当前随笔还没保存，确定切换吗？')) return;
    loadJournal(todayKey);
    $('#journal-title').focus();
  });
  $('#save-journal').addEventListener('click', () => {
    const title = $('#journal-title').value.trim();
    const body = $('#journal-body').value.trim();
    if (!body) {
      showToast('写下几句话，再保存这篇随笔吧');
      $('#journal-body').focus();
      return;
    }
    data.journals[currentJournalDate] = stampRecord({ ...(data.journals[currentJournalDate] || {}), title, body, deletedAt: undefined }, !data.journals[currentJournalDate]);
    if (saveData()) {
      $('#journal-saved').textContent = currentUser ? '刚刚保存 · 两人共享中' : '刚刚保存在这台设备';
      renderJournals();
      renderCalendar();
      showToast('这篇小日记保存好啦 ♡');
    }
  });
  function renderJournals() {
    const entries = Object.entries(data.journals).filter(([, entry]) => entry?.body).sort(([a], [b]) => b.localeCompare(a));
    $('#entry-count').textContent = `${entries.length} 篇`;
    $('#empty-entries').classList.toggle('hidden', entries.length > 0);
    $('#journal-entries').innerHTML = entries.map(([key, entry]) => `<article class="entry-item"><div class="entry-top"><strong>${escapeHtml(entry.title || '无题')}</strong><time>${escapeHtml(key)}</time></div>${authorLabel(entry)}<p class="entry-excerpt">${escapeHtml(entry.body.length > 135 ? `${entry.body.slice(0, 135)}…` : entry.body)}</p><div class="entry-actions"><button type="button" data-edit-entry="${escapeHtml(key)}">继续编辑</button><button type="button" class="delete-entry" data-remove-entry="${escapeHtml(key)}">删除</button></div></article>`).join('');
  }
  $('#journal-entries').addEventListener('click', (event) => {
    const edit = event.target.closest('[data-edit-entry]')?.dataset.editEntry;
    const remove = event.target.closest('[data-remove-entry]')?.dataset.removeEntry;
    if (edit) {
      const hasChanges = $('#journal-saved').textContent === '有未保存的修改';
      if (hasChanges && !confirm('当前随笔还没保存，确定切换吗？')) return;
      loadJournal(edit);
      $('#journal-title').focus();
      showToast('已载入这篇随笔');
    } else if (remove && confirm('要删除这篇随笔吗？')) {
      data.journals[remove] = stampRecord({ ...data.journals[remove], body: '', deletedAt: new Date().toISOString() });
      if (saveData()) {
        if (currentJournalDate === remove) loadJournal(remove);
        renderJournals();
        renderCalendar();
        showToast('随笔已删除');
      }
    }
  });

  $('#auth-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = event.currentTarget.querySelector('button[type="submit"]');
    button.disabled = true;
    try { await authenticate(authMode, new FormData(event.currentTarget)); }
    catch (error) { $('#auth-error').textContent = error.message || '暂时无法连接共享服务'; }
    finally { button.disabled = false; }
  });
  $('#auth-switch').addEventListener('click', (event) => {
    const mode = event.target.closest('[data-auth-mode]')?.dataset.authMode;
    if (mode) renderAuth(mode);
    else if (event.target.closest('[data-offline-mode]')) {
      $('#auth-overlay').hidden = true;
      carriedTaskCount += carryOverYesterday();
      renderSharedState(); reportCarryOver();
    }
    else if (event.target.closest('[data-export-local]')) downloadJson(`莓好日常-本机备份-${todayKey}.json`, { exportedAt: new Date().toISOString(), state: data });
  });
  $('#auth-switch').addEventListener('change', async (event) => {
    if (event.target.id !== 'import-backup-file' || !event.target.files?.[0]) return;
    try { await importBackupFile(event.target.files[0]); }
    catch (error) { showToast(error.message || '无法读取这个备份文件'); }
    event.target.value = '';
  });
  $('#collab-overlay').addEventListener('change', async (event) => {
    if (event.target.id !== 'import-shared-backup' || !event.target.files?.[0]) return;
    try { await importBackupFile(event.target.files[0]); }
    catch (error) { showToast(error.message || '无法读取这个备份文件'); }
    event.target.value = '';
  });
  $('#collab-open').addEventListener('click', () => { updateCollabUI(); $('#collab-overlay').hidden = false; });
  document.querySelectorAll('[data-close-modal]').forEach((button) => button.addEventListener('click', () => { $('#collab-overlay').hidden = true; }));
  $('#collab-overlay').addEventListener('click', (event) => { if (event.target === event.currentTarget) event.currentTarget.hidden = true; });
  $('#create-invite').addEventListener('click', async () => {
    try { const result = await apiRequest('/api/invite', { method: 'POST', body: '{}' }); $('#invite-code').textContent = result.inviteCode; showToast('邀请码已生成，7 天内有效'); }
    catch (error) { showToast(error.message || '邀请码生成失败'); }
  });
  $('#copy-invite').addEventListener('click', async () => {
    const code = $('#invite-code').textContent.trim();
    if (!code || code === '还没有邀请码') { showToast('先生成一个邀请码吧'); return; }
    const shareText = `${location.origin}\n邀请码：${code}`;
    try { await navigator.clipboard.writeText(shareText); showToast('地址和邀请码已复制'); }
    catch { showToast(`请复制地址和邀请码：${shareText}`); }
  });
  $('#download-backup').addEventListener('click', () => downloadJson(`莓好日常共享备份-${todayKey}.json`, { exportedAt: new Date().toISOString(), revision: syncRevision, members: sharedMembers, state: data }));
  $('#show-history').addEventListener('click', async () => {
    try {
      const result = await apiRequest('/api/history');
      $('#history-list').innerHTML = result.snapshots.map((item) => `<div class="history-entry"><span>版本 ${item.revision} · ${escapeHtml(new Date(item.updatedAt * 1000).toLocaleString('zh-CN'))} · ${escapeHtml(item.updatedBy)}</span><button type="button" data-restore-revision="${item.revision}">恢复</button></div>`).join('');
      $('#history-list').classList.remove('hidden');
    } catch (error) { showToast(error.message || '读取备份版本失败'); }
  });
  $('#history-list').addEventListener('click', async (event) => {
    const revision = event.target.closest('[data-restore-revision]')?.dataset.restoreRevision;
    if (!revision || !confirm(`确定恢复到云端版本 ${revision} 吗？这会替换两个人当前看到的共享记录。`)) return;
    try {
      const restored = await apiRequest('/api/history', { method: 'POST', body: JSON.stringify({ revision: Number(revision), baseRevision: syncRevision }) });
      replaceData(restored.state); syncRevision = restored.revision; sharedMembers = restored.members; pendingSync = false;
      localStorage.removeItem(PENDING_KEY);
      saveLocalOnly(); updateCollabUI(); renderSharedState(); setSyncStatus('synced', '已恢复'); showToast('共享日记已恢复到选中的版本');
    } catch (error) { if (error.status === 409) announceConflict(error.result); else showToast(error.message || '恢复失败'); }
  });
  $('#logout-button').addEventListener('click', async () => {
    try { await apiRequest('/api/auth/logout', { method: 'POST', body: '{}' }); } catch { /* local app remains available */ }
    currentUser = null; sharedMembers = []; syncReady = false; localStorage.removeItem(PROFILE_KEY); updateCollabUI();
    $('#collab-overlay').hidden = true; renderAuth('login'); $('#auth-overlay').hidden = false;
  });
  $('#merge-and-sync').addEventListener('click', () => {
    if (!pendingConflict) return;
    const remote = pendingConflict;
    const merged = mergeSharedState(data, remote.state);
    replaceData(merged); syncRevision = remote.revision; sharedMembers = remote.members || sharedMembers;
    pendingConflict = null; $('#sync-conflict-overlay').hidden = true; saveLocalOnly(); updateCollabUI(); renderSharedState();
    if (JSON.stringify(merged) !== JSON.stringify(remote.state)) { pendingSync = true; localStorage.setItem(PENDING_KEY, '1'); scheduleSync(100); }
    else { localStorage.removeItem(PENDING_KEY); setSyncStatus('synced', '已同步'); }
    showToast('两边的记录已合并');
  });
  $('#keep-remote').addEventListener('click', () => {
    if (!pendingConflict) return;
    replaceData(pendingConflict.state); syncRevision = pendingConflict.revision; sharedMembers = pendingConflict.members || sharedMembers;
    pendingConflict = null; pendingSync = false; localStorage.removeItem(PENDING_KEY); $('#sync-conflict-overlay').hidden = true;
    saveLocalOnly(); updateCollabUI(); renderSharedState(); setSyncStatus('synced', '已同步');
    showToast('已载入共享版本；本机未同步记录可先下载备份');
  });
  $('#export-local').addEventListener('click', () => downloadJson(`莓好日常-冲突备份-${todayKey}.json`, { exportedAt: new Date().toISOString(), state: data }));
  $('#sync-conflict-overlay').addEventListener('click', (event) => { if (event.target === event.currentTarget) showToast('先选择合并、载入共享版本或下载备份'); });

  renderTasks();
  renderCalendar();
  renderJournals();
  const requestedPage = new URLSearchParams(location.search).get('page');
  if (['today', 'calendar', 'journal'].includes(requestedPage)) switchPage(requestedPage);
  updateCollabUI();
  initializeCollaboration();
  setInterval(pollSharedState, 12000);
  if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('./service-worker.js').catch(() => {});
})();
