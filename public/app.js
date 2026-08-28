const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

const state = {
  csrf: null,
  router: null,
  box: 'inbox',
  page: 1,
  data: null,
  selected: null,
  selectedStacks: new Set(),
  loading: false,
};

let messageLoadVersion = 0;
let pendingMessageLoad = null;

const boxLabels = {
  inbox: { title: 'Inbox', label: 'From' },
  sent: { title: 'Sent', label: 'To' },
  drafts: { title: 'Drafts', label: 'To' },
};

async function api(path, options = {}) {
  const headers = new Headers(options.headers || {});
  if (options.body && typeof options.body !== 'string') {
    headers.set('Content-Type', 'application/json');
    options.body = JSON.stringify(options.body);
  }
  if (state.csrf && (options.method || 'GET') !== 'GET') headers.set('X-CSRF-Token', state.csrf);
  const response = await fetch(path, { ...options, headers });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 401 && path !== '/api/login') showLogin();
    throw new Error(data.error?.message || `Request failed (${response.status})`);
  }
  return data;
}

function setBusy(button, busy, label = 'Working…') {
  if (!button) return;
  if (busy) {
    button.dataset.original = button.textContent;
    button.textContent = label;
    button.disabled = true;
  } else {
    button.textContent = button.dataset.original || button.textContent;
    button.disabled = false;
  }
}

let toastTimer;
function toast(message, error = false) {
  const element = $('#toast');
  const icon = error ? '<i class="fa-solid fa-circle-exclamation"></i>' : '<i class="fa-solid fa-circle-check"></i>';
  element.innerHTML = `${icon} <span>${message}</span>`;
  element.classList.toggle('error', error);
  element.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => element.classList.remove('show'), 3500);
}

function applyTheme(theme) {
  const value = theme === 'dark' ? 'dark' : 'light';
  document.documentElement.dataset.theme = value;
  localStorage.setItem('mr100-theme', value);
  const iconHtml = value === 'dark' ? '<i class="fa-solid fa-sun"></i>' : '<i class="fa-solid fa-moon"></i>';
  for (const button of [$('#themeToggle'), $('#loginThemeToggle')]) {
    if (!button) continue;
    button.innerHTML = iconHtml;
    button.setAttribute('aria-label', `Switch to ${value === 'dark' ? 'light' : 'dark'} theme`);
    button.title = `Switch to ${value === 'dark' ? 'light' : 'dark'} theme`;
  }
}

function toggleTheme() {
  applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');
}

let confirmationResolver = null;
function askConfirmation({ title, message, action = 'Delete', phrase = null }) {
  $('#confirmTitle').textContent = title;
  $('#confirmMessage').textContent = message;
  $('#acceptConfirm').textContent = action;
  $('#confirmPhraseField').hidden = !phrase;
  $('#confirmPhraseLabel').textContent = phrase ? `Type ${phrase} to confirm:` : '';
  $('#confirmPhraseLabel').dataset.phrase = phrase || '';
  $('#confirmPhraseInput').value = '';
  $('#acceptConfirm').disabled = Boolean(phrase);
  $('#confirmDialog').showModal();
  if (phrase) setTimeout(() => $('#confirmPhraseInput').focus(), 50);
  return new Promise((resolve) => { confirmationResolver = resolve; });
}

function finishConfirmation(accepted) {
  if ($('#confirmDialog').open) $('#confirmDialog').close();
  confirmationResolver?.(accepted);
  confirmationResolver = null;
}

function showLogin() {
  messageLoadVersion += 1;
  pendingMessageLoad = null;
  state.data = null;
  state.selected = null;
  state.selectedStacks.clear();
  state.csrf = null;
  state.router = null;
  $('#appView').hidden = true;
  $('#loginView').hidden = false;
  $('#passwordInput').value = '';
}

function showApp(session) {
  state.csrf = session.csrf;
  state.router = session.router;
  $('#loginView').hidden = true;
  $('#appView').hidden = false;
  $('#routerModel').textContent = session.router.info?.modelName || 'TP-Link MR100';
  $('#routerHost').textContent = session.router.host.replace(/^https?:\/\//, '');
  loadMessages();
}

function formatTime(value) {
  if (!value) return '';
  const parsed = new Date(value.replace(' ', 'T'));
  if (Number.isNaN(parsed.getTime())) return value;
  const now = new Date();
  const sameDay = parsed.toDateString() === now.toDateString();
  return sameDay
    ? new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' }).format(parsed)
    : new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(parsed);
}

function avatarText(address) {
  const clean = String(address || '?').replace(/^\+/, '').trim();
  return clean[0]?.toUpperCase() || '?';
}

function updateBatchState() {
  const data = state.data;
  const count = state.selectedStacks.size;
  const toolbar = $('#batchToolbar');
  if (toolbar) toolbar.hidden = count === 0;
  if ($('#selectedCount')) $('#selectedCount').textContent = `${count} selected`;

  const selectPage = $('#selectPage');
  if (selectPage && data?.messages?.length) {
    const allChecked = data.messages.every((m) => state.selectedStacks.has(m.stack));
    const someChecked = data.messages.some((m) => state.selectedStacks.has(m.stack));
    selectPage.checked = allChecked;
    selectPage.indeterminate = someChecked && !allChecked;
  } else if (selectPage) {
    selectPage.checked = false;
    selectPage.indeterminate = false;
  }
}

function renderMessages() {
  const data = state.data;
  if (!data) return;
  const list = $('#messageList');
  list.replaceChildren();
  $('#listSkeleton').hidden = true;
  list.hidden = data.messages.length === 0;
  $('#emptyState').hidden = data.messages.length > 0;
  $('#emptyState h3').textContent = data.total === 0 ? `No messages in ${boxLabels[state.box].title}` : 'No messages returned';
  $('#emptyState p').textContent = data.total === 0
    ? 'This folder is empty. Click refresh or compose a new SMS.'
    : 'The router returned an empty page. Click refresh to try again.';
  $('#selectPage').disabled = data.messages.length === 0;
  $('#messageTotal').textContent = `${data.total.toLocaleString()} ${data.total === 1 ? 'message' : 'messages'}`;
  const shouldPaginate = data.total > 10;
  const paginationFooter = $('#paginationFooter') || $('.pagination');
  if (paginationFooter) {
    paginationFooter.hidden = !shouldPaginate;
  }
  $('#pageLabel').textContent = shouldPaginate ? `Page ${data.page} of ${data.pages}` : '';
  $('#paginationText').textContent = shouldPaginate ? `Page ${data.page} of ${data.pages}` : '';
  $('#prevPage').disabled = data.page <= 1;
  $('#nextPage').disabled = data.page >= data.pages;
  $(`#${state.box}Count`).textContent = data.total;

  if ($('#deleteAllButton')) {
    $('#deleteAllButton').hidden = state.box !== 'inbox';
  }

  for (const message of data.messages) {
    const isChecked = state.selectedStacks.has(message.stack);
    const isSelected = Boolean(
      state.selected &&
      state.selected.stack === message.stack &&
      (state.selected.index == null || message.index == null || state.selected.index === message.index)
    );
    const row = document.createElement('button');
    row.type = 'button';
    row.className = `message-row${message.unread ? ' unread' : ''}${isSelected ? ' selected' : ''}${isChecked ? ' checked' : ''}`;
    row.dataset.stack = message.stack;

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.className = 'row-checkbox';
    checkbox.checked = isChecked;
    checkbox.ariaLabel = `Select message from ${message.address || 'Unknown'}`;
    checkbox.addEventListener('click', (event) => event.stopPropagation());
    checkbox.addEventListener('change', (event) => {
      if (event.target.checked) state.selectedStacks.add(message.stack);
      else state.selectedStacks.delete(message.stack);
      row.classList.toggle('checked', event.target.checked);
      updateBatchState();
    });

    const dot = document.createElement('span');
    dot.className = `unread-dot${message.unread ? '' : ' read'}`;

    const copy = document.createElement('span');
    copy.className = 'message-copy';
    const heading = document.createElement('span');
    heading.className = 'message-heading';
    const address = document.createElement('span');
    address.className = 'message-address';
    address.dir = 'auto';
    address.textContent = message.address || 'Unknown';
    const time = document.createElement('time');
    time.className = 'message-time';
    time.textContent = formatTime(message.time);
    const preview = document.createElement('p');
    preview.className = 'message-preview';
    preview.dir = 'auto';
    preview.textContent = message.content || '(empty message)';
    heading.append(address, time);
    copy.append(heading, preview);

    const arrow = document.createElement('span');
    arrow.className = 'row-arrow';
    arrow.innerHTML = '<i class="fa-solid fa-chevron-right"></i>';

    row.append(checkbox, dot, copy, arrow);
    row.addEventListener('click', () => selectMessage(message));
    list.append(row);
  }

  updateBatchState();
}

async function loadMessages({ preserveSelection = false } = {}) {
  pendingMessageLoad = { version: ++messageLoadVersion, box: state.box, page: state.page, preserveSelection };
  $('#messageTotal').textContent = 'Loading…';
  $('#listSkeleton').hidden = false;
  $('#messageList').hidden = true;
  $('#messageList').replaceChildren();
  $('#emptyState').hidden = true;
  $('#refreshButton').disabled = true;
  $('#selectPage').disabled = true;
  $('#prevPage').disabled = true;
  $('#nextPage').disabled = true;
  $('#paginationFooter').hidden = true;
  $('#pageLabel').textContent = '';
  $('#deleteAllButton').hidden = state.box !== 'inbox';
  updateBatchState();

  // Keep router reads sequential, but never drop the latest folder/page choice.
  if (state.loading) return;
  state.loading = true;
  try {
    while (pendingMessageLoad) {
      const request = pendingMessageLoad;
      pendingMessageLoad = null;
      try {
        const data = await api(`/api/messages?box=${encodeURIComponent(request.box)}&page=${request.page}`);
        if (request.version !== messageLoadVersion) continue;
        state.data = data;
        state.page = data.page;
        if (!request.preserveSelection || !data.messages.some((item) => item.stack === state.selected?.stack)) clearSelection();
        renderMessages();
      } catch (error) {
        if (request.version !== messageLoadVersion) continue;
        state.data = null;
        state.selectedStacks.clear();
        clearSelection();
        updateBatchState();
        $('#listSkeleton').hidden = true;
        $('#messageTotal').textContent = 'Could not load messages';
        $('#emptyState h3').textContent = `Could not load ${boxLabels[request.box].title}`;
        $('#emptyState p').textContent = `${error.message}. Click refresh to try again.`;
        $('#emptyState').hidden = false;
        toast(error.message, true);
      }
    }
  } finally {
    state.loading = false;
    $('#refreshButton').disabled = false;
  }
}

async function selectMessage(message) {
  state.selected = message;
  renderMessages();
  $('#detailPlaceholder').hidden = true;
  $('#detailContent').hidden = false;
  $('#detailAvatar').textContent = avatarText(message.address);
  $('#detailLabel').textContent = boxLabels[state.box].label;
  $('#detailAddress').textContent = message.address || 'Unknown';
  $('#detailTime').textContent = message.time || '';
  $('#detailBody').textContent = message.content || '(empty message)';
  $('#replyButton').hidden = false;
  const actionLabel = state.box === 'drafts' ? 'Use draft' : state.box === 'sent' ? 'Message again' : 'Reply';
  const actionIcon = state.box === 'drafts' ? 'fa-pen-to-square' : state.box === 'sent' ? 'fa-paper-plane' : 'fa-reply';
  $('#replyButton').innerHTML = `<i class="fa-solid ${actionIcon}"></i> <span>${actionLabel}</span>`;
  $('#messageDetail').classList.add('mobile-open');
  if (state.box === 'inbox' && message.unread) {
    message.unread = false;
    renderMessages();
    api('/api/messages/read', { method: 'PATCH', body: { stack: message.stack } }).catch((error) => toast(error.message, true));
  }
}

function clearSelection() {
  state.selected = null;
  $('#detailPlaceholder').hidden = false;
  $('#detailContent').hidden = true;
  $('#messageDetail').classList.remove('mobile-open');
}

function switchFolder(box) {
  if (box === state.box) return;
  state.box = box;
  state.page = 1;
  state.data = null;
  state.selectedStacks.clear();
  clearSelection();
  $$('.folder-button').forEach((button) => button.classList.toggle('active', button.dataset.box === box));
  $('#folderTitle').textContent = boxLabels[box].title;
  $('#folderEyebrow').textContent = box === 'inbox' ? 'Messages' : 'SMS Archive';
  loadMessages();
}

function openComposer({ to = '', content = '' } = {}) {
  $('#recipientInput').value = to;
  $('#messageInput').value = content;
  $('#composeError').hidden = true;
  updateCounter();
  $('#composeDialog').showModal();
  setTimeout(() => (to ? $('#messageInput') : $('#recipientInput')).focus(), 50);
}

const gsmBasic = new Set("@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà".split(''));
const gsmExtended = new Set('^{}\\[~]|€'.split(''));
function smsMetrics(value) {
  let gsm = true;
  let units = 0;
  for (const character of value) {
    if (gsmBasic.has(character)) units += 1;
    else if (gsmExtended.has(character)) units += 2;
    else { gsm = false; break; }
  }
  if (!gsm) units = [...value].length;
  const single = gsm ? 160 : 70;
  const multipart = gsm ? 153 : 67;
  const segments = units <= single ? 1 : Math.ceil(units / multipart);
  return { gsm, units, segments, limit: segments === 1 ? single : multipart * 5, max: multipart * 5 };
}

function updateCounter() {
  const metrics = smsMetrics($('#messageInput').value);
  $('#encodingLabel').textContent = metrics.gsm ? 'GSM-7' : 'Unicode';
  $('#characterCount').textContent = `${metrics.units} / ${metrics.limit} · ${metrics.segments} ${metrics.segments === 1 ? 'part' : 'parts'}`;
  $('#characterCount').classList.toggle('over-limit', metrics.segments > 5);
}

$('#loginForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = $('#loginButton');
  const errorElement = $('#loginError');
  errorElement.hidden = true;
  setBusy(button, true, 'Connecting…');
  try {
    const session = await api('/api/login', {
      method: 'POST',
      body: {
        host: $('#hostInput').value,
        username: $('#usernameInput').value,
        password: $('#passwordInput').value,
      },
    });
    showApp(session);
  } catch (error) {
    errorElement.textContent = error.message;
    errorElement.hidden = false;
  } finally {
    setBusy(button, false);
  }
});

$('#themeToggle')?.addEventListener('click', toggleTheme);
$('#loginThemeToggle')?.addEventListener('click', toggleTheme);

$('#folderNav').addEventListener('click', (event) => {
  const button = event.target.closest('[data-box]');
  if (button) switchFolder(button.dataset.box);
});
$('#refreshButton').addEventListener('click', () => loadMessages({ preserveSelection: true }));
$('#composeButton').addEventListener('click', () => openComposer());
$('#mobileComposeButton').addEventListener('click', () => openComposer());
$('#closeCompose').addEventListener('click', () => $('#composeDialog').close());
$('#messageInput').addEventListener('input', updateCounter);
$('#prevPage').addEventListener('click', () => { state.page -= 1; clearSelection(); loadMessages(); });
$('#nextPage').addEventListener('click', () => { state.page += 1; clearSelection(); loadMessages(); });
$('#backToList').addEventListener('click', clearSelection);

$('#selectPage')?.addEventListener('change', (event) => {
  if (!state.data?.messages) return;
  for (const message of state.data.messages) {
    if (event.target.checked) state.selectedStacks.add(message.stack);
    else state.selectedStacks.delete(message.stack);
  }
  renderMessages();
});

$('#clearSelectionButton')?.addEventListener('click', () => {
  state.selectedStacks.clear();
  renderMessages();
});

$('#batchDeleteButton')?.addEventListener('click', async () => {
  const count = state.selectedStacks.size;
  if (!count) return;
  const ok = await askConfirmation({
    title: `Delete ${count} selected ${count === 1 ? 'message' : 'messages'}?`,
    message: `Are you sure you want to delete these ${count} ${count === 1 ? 'message' : 'messages'} from your router? This action cannot be undone.`,
    action: 'Delete Selected',
  });
  if (!ok) return;
  setBusy($('#batchDeleteButton'), true, 'Deleting…');
  try {
    const stacks = Array.from(state.selectedStacks);
    await api('/api/messages/batch', { method: 'DELETE', body: { box: state.box, stacks } });
    toast(`${count} ${count === 1 ? 'message' : 'messages'} deleted`);
    state.selectedStacks.clear();
    clearSelection();
    await loadMessages();
  } catch (error) {
    toast(error.message, true);
  } finally {
    setBusy($('#batchDeleteButton'), false);
  }
});

$('#deleteAllButton')?.addEventListener('click', async () => {
  const ok = await askConfirmation({
    title: 'Empty Router Inbox?',
    message: 'This will permanently delete ALL messages currently stored in your TP-Link router inbox. This action cannot be undone.',
    action: 'Delete All Messages',
    phrase: 'DELETE ALL',
  });
  if (!ok) return;
  setBusy($('#deleteAllButton'), true, 'Emptying…');
  try {
    await api('/api/messages/all', { method: 'DELETE', body: { box: 'inbox', confirmation: 'DELETE ALL' } });
    toast('Inbox emptied');
    state.selectedStacks.clear();
    clearSelection();
    await loadMessages();
  } catch (error) {
    toast(error.message, true);
  } finally {
    setBusy($('#deleteAllButton'), false);
  }
});

$('#confirmForm')?.addEventListener('submit', (event) => {
  event.preventDefault();
  finishConfirmation(true);
});
$('#cancelConfirm')?.addEventListener('click', () => finishConfirmation(false));
$('#confirmDialog')?.addEventListener('cancel', () => finishConfirmation(false));
$('#confirmPhraseInput')?.addEventListener('input', (event) => {
  const phraseRequired = $('#confirmPhraseLabel').dataset.phrase;
  if (phraseRequired) {
    $('#acceptConfirm').disabled = event.target.value.trim() !== phraseRequired;
  }
});

$('#composeForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const metrics = smsMetrics($('#messageInput').value);
  const errorElement = $('#composeError');
  errorElement.hidden = true;
  if (metrics.segments > 5) {
    errorElement.textContent = 'The router can send at most 5 SMS parts at once.';
    errorElement.hidden = false;
    return;
  }
  setBusy($('#sendButton'), true, 'Sending…');
  try {
    const result = await api('/api/messages/send', {
      method: 'POST',
      body: { to: $('#recipientInput').value, content: $('#messageInput').value },
    });
    $('#composeDialog').close();
    toast(result.confirmed ? 'Message sent successfully' : result.status === 'completed' ? 'Router completed the send attempt' : `Message accepted: ${result.status}`);
    if (state.box === 'sent') loadMessages();
  } catch (error) {
    errorElement.textContent = error.message;
    errorElement.hidden = false;
  } finally {
    setBusy($('#sendButton'), false);
  }
});

$('#saveDraftButton').addEventListener('click', async () => {
  const errorElement = $('#composeError');
  errorElement.hidden = true;
  setBusy($('#saveDraftButton'), true, 'Saving…');
  try {
    await api('/api/messages/draft', {
      method: 'POST',
      body: { to: $('#recipientInput').value, content: $('#messageInput').value },
    });
    $('#composeDialog').close();
    toast('Draft saved');
    if (state.box === 'drafts') loadMessages();
  } catch (error) {
    errorElement.textContent = error.message;
    errorElement.hidden = false;
  } finally {
    setBusy($('#saveDraftButton'), false);
  }
});

$('#deleteButton').addEventListener('click', async () => {
  if (!state.selected) return;
  const ok = await askConfirmation({
    title: 'Delete Message?',
    message: 'Delete this message from your router? This cannot be undone.',
    action: 'Delete',
  });
  if (!ok) return;
  setBusy($('#deleteButton'), true, 'Deleting…');
  try {
    await api('/api/messages', { method: 'DELETE', body: { box: state.box, stack: state.selected.stack } });
    toast('Message deleted');
    clearSelection();
    await loadMessages();
  } catch (error) {
    toast(error.message, true);
  } finally {
    setBusy($('#deleteButton'), false);
  }
});

$('#replyButton').addEventListener('click', () => {
  if (state.selected) openComposer({
    to: state.selected.address,
    content: state.box === 'drafts' ? state.selected.content : '',
  });
});
$('#copyButton').addEventListener('click', async () => {
  if (!state.selected) return;
  await navigator.clipboard.writeText(state.selected.content);
  toast('Message copied');
});
$('#logoutButton').addEventListener('click', async () => {
  try { await api('/api/logout', { method: 'POST' }); } catch {}
  showLogin();
});

applyTheme(document.documentElement.dataset.theme || 'light');

api('/api/session').then((session) => {
  if (session.connected) showApp(session);
  else showLogin();
}).catch(showLogin);
