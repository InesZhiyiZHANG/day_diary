(() => {
  const STORE_KEY = 'meihao-daily-v1';
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
  const emptyData = () => ({ tasks: {}, moods: {}, journals: {}, rollovers: {} });
  const loadData = () => {
    try {
      const stored = JSON.parse(localStorage.getItem(STORE_KEY));
      if (!stored || typeof stored !== 'object') return emptyData();
      return {
        tasks: stored.tasks && typeof stored.tasks === 'object' ? stored.tasks : {},
        moods: stored.moods && typeof stored.moods === 'object' ? stored.moods : {},
        journals: stored.journals && typeof stored.journals === 'object' ? stored.journals : {},
        rollovers: stored.rollovers && typeof stored.rollovers === 'object' ? stored.rollovers : {},
      };
    } catch {
      return emptyData();
    }
  };

  const data = loadData();
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
  const tasksFor = (key = planDate) => Array.isArray(data.tasks[key]) ? data.tasks[key] : [];
  const rootsFor = (key = planDate) => tasksFor(key).filter((task) => !task.parentId);
  const childrenFor = (id, key = planDate) => tasksFor(key).filter((task) => task.parentId === id);
  function updateParent(parentId, key = planDate) {
    const parent = tasksFor(key).find((task) => task.id === parentId);
    if (parent) { const children = childrenFor(parentId, key); if (children.length) parent.done = children.every((child) => child.done); }
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
      return true;
    } catch {
      showToast('保存失败，请检查浏览器存储空间');
      return false;
    }
  };

  function carryOverYesterday() {
    if (data.rollovers[todayKey]) return 0;
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
      const newId = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
      destination.push({ id: newId, text: source.text, done: false, category: source.category || 'life', carrySourceDate: yesterdayKey, carrySourceId: source.id });
      pendingChildren.forEach((child) => destination.push({
        id: globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`,
        text: child.text, done: false, parentId: newId,
      }));
      count += 1;
    });
    data.rollovers[todayKey] = true;
    saveData();
    return count;
  }
  const carriedTaskCount = carryOverYesterday();

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
          <span class="category-icon" title="${category[1]}">${category[0]}</span><span class="task-text">${escapeHtml(task.text)}</span>${task.carrySourceDate === planDate ? '<span class="carry-badge">↪ 昨日未完成</span>' : ''}${children.length ? `<span class="subtask-count">${children.filter((child) => child.done).length}/${children.length}</span>` : ''}
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
    (data.tasks[planDate] ||= []).push({ id, text, done: false, category: selectedCategory });
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
    if (!task.parentId) childrenFor(task.id).forEach((child) => { child.done = task.done; });
    else updateParent(task.parentId);
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
      data.tasks[planDate] = tasksFor().filter((task) => task.id !== deleteId && !(removed && !removed.parentId && task.parentId === deleteId));
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
    const parentId = form.dataset.subtaskForm; (data.tasks[planDate] ||= []).push({ id: globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`, text, done: false, parentId });
    const parent = tasksFor().find((task) => task.id === parentId); if (parent) parent.done = false;
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
    data.moods[todayKey] = { mood: selectedMood, note, updatedAt: new Date().toISOString() };
    if (saveData()) {
      $('#mood-saved').textContent = '刚刚保存 · 只在这台设备';
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
      html += `<div class="record-section"><h3>今日计划 · ${done}/${units.length} 完成</h3>${tasks.map((task) => { const category = categories[task.category] || categories.life; const children = childrenFor(task.id, selectedDate); return `<div class="record-task ${task.done ? 'done' : ''}"><strong>${category[0]} ${escapeHtml(task.text)}</strong></div>${children.map((child) => `<div class="record-task record-child ${child.done ? 'done' : ''}">${child.done ? '✓' : '○'} ${escapeHtml(child.text)}</div>`).join('')}`; }).join('')}</div>`;
    }
    if (mood) {
      const moodInfo = moods.find((item) => item.id === mood.mood);
      html += `<div class="record-section"><h3>今天的心情</h3><div class="record-mood"><span>${moodInfo?.emoji || '♡'}</span>${moodInfo?.label || '写下了感受'}</div>${mood.note ? `<p class="record-note">${escapeHtml(mood.note)}</p>` : ''}</div>`;
    }
    if (journal?.body) html += `<div class="record-section"><h3>心情随笔</h3><div class="record-journal"><strong>${escapeHtml(journal.title || '无题')}</strong><p>${escapeHtml(journal.body)}</p></div></div>`;
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
    $('#journal-saved').textContent = data.journals[date]?.body ? '已保存 · 只在这台设备' : '只保存在这台设备';
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
    data.journals[currentJournalDate] = { title, body, updatedAt: new Date().toISOString() };
    if (saveData()) {
      $('#journal-saved').textContent = '刚刚保存 · 只在这台设备';
      renderJournals();
      renderCalendar();
      showToast('这篇小日记保存好啦 ♡');
    }
  });
  function renderJournals() {
    const entries = Object.entries(data.journals).filter(([, entry]) => entry?.body).sort(([a], [b]) => b.localeCompare(a));
    $('#entry-count').textContent = `${entries.length} 篇`;
    $('#empty-entries').classList.toggle('hidden', entries.length > 0);
    $('#journal-entries').innerHTML = entries.map(([key, entry]) => `<article class="entry-item"><div class="entry-top"><strong>${escapeHtml(entry.title || '无题')}</strong><time>${escapeHtml(key)}</time></div><p class="entry-excerpt">${escapeHtml(entry.body.length > 135 ? `${entry.body.slice(0, 135)}…` : entry.body)}</p><div class="entry-actions"><button type="button" data-edit-entry="${key}">继续编辑</button><button type="button" class="delete-entry" data-remove-entry="${key}">删除</button></div></article>`).join('');
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
      delete data.journals[remove];
      if (saveData()) {
        if (currentJournalDate === remove) loadJournal(remove);
        renderJournals();
        renderCalendar();
        showToast('随笔已删除');
      }
    }
  });

  renderTasks();
  if (carriedTaskCount) showToast(`昨天有 ${carriedTaskCount} 项未完成，已带到今天继续做`);
  renderCalendar();
  renderJournals();
  const requestedPage = new URLSearchParams(location.search).get('page');
  if (['today', 'calendar', 'journal'].includes(requestedPage)) switchPage(requestedPage);
  if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('./service-worker.js').catch(() => {});
})();
