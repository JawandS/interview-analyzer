import { ThinkParser } from './think-parser.js';

// ── Rendering (markdown + LaTeX) ─────────────────────────────
const marked = window.marked;
const katex  = window.katex;

marked.use({ breaks: true });

function renderContent(text) {
  const blocks = [];
  const save = (math, display) => {
    const id = blocks.length;
    blocks.push({ math, display });
    return `MATHPLACEHOLDER_${id}_END`;
  };

  const preprocessed = text
    .replace(/\$\$([\s\S]*?)\$\$/g,  (_, m) => save(m, true))
    .replace(/\$([^\n$`]+?)\$/g,     (_, m) => save(m, false));

  let html = marked.parse(preprocessed);

  blocks.forEach(({ math, display }, id) => {
    const rendered = katex.renderToString(math.trim(), {
      throwOnError: false,
      displayMode: display,
    });
    html = html.split(`MATHPLACEHOLDER_${id}_END`).join(rendered);
  });

  return html;
}

// ── Textarea resize ──────────────────────────────────────────
export function resize(el) {
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 180) + 'px';
}
window.resize = resize;

// ── Theme toggle ─────────────────────────────────────────────
const root     = document.documentElement;
const themeBtn = document.getElementById('themeBtn');

function setTheme(t) {
  root.dataset.theme = t;
  localStorage.setItem('theme', t);
}

themeBtn.addEventListener('click', () =>
  setTheme(root.dataset.theme === 'dark' ? 'light' : 'dark')
);
setTheme(localStorage.getItem('theme') || 'dark');

// ── Sidebar toggle ───────────────────────────────────────────
const sidebar    = document.getElementById('sidebar');
const sidebarBtn = document.getElementById('sidebarBtn');

if (localStorage.getItem('sidebarCollapsed') === '1') sidebar.classList.add('collapsed');

sidebarBtn.addEventListener('click', () => {
  sidebar.classList.toggle('collapsed');
  localStorage.setItem('sidebarCollapsed', sidebar.classList.contains('collapsed') ? '1' : '0');
});

// ── Model state ──────────────────────────────────────────────
let activeModel           = null;
let pendingSwitchModel    = null;
let sessionPreferredModel = null;

async function doModelSwitch(newModel) {
  const oldModel = activeModel;
  activeModel    = newModel;

  const sel = document.getElementById('model-select');
  if (sel) sel.value = newModel;

  const picker = document.getElementById('model-picker');
  if (picker) {
    picker.querySelector('.model-pill-text').textContent = newModel;
    picker.querySelectorAll('.model-option').forEach(b => {
      if (b.textContent === newModel) b.dataset.selected = '';
      else delete b.dataset.selected;
    });
  }

  const fd = new FormData();
  fd.append('new_model', newModel);
  if (oldModel) fd.append('old_model', oldModel);
  await fetch('/models/switch', { method: 'POST', body: fd });
}

// ── Custom model picker (replaces native <select>) ───────────
function upgradeModelSelect() {
  const sel = document.getElementById('model-select');
  if (!sel || document.getElementById('model-picker')) return;

  const options = Array.from(sel.options);
  const initial = (activeModel && options.find(o => o.value === activeModel))
    ? activeModel
    : sel.value || options[0]?.value || '';
  sel.value = initial;

  const picker = document.createElement('details');
  picker.id        = 'model-picker';
  picker.className = 'model-picker';

  const summary = document.createElement('summary');
  summary.className = 'model-pill';

  const pillText = document.createElement('span');
  pillText.className   = 'model-pill-text';
  pillText.textContent = initial;

  const chevronSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  chevronSvg.setAttribute('viewBox', '0 0 24 24');
  chevronSvg.classList.add('model-pill-chevron');
  const chevronPath = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
  chevronPath.setAttribute('points', '6 9 12 15 18 9');
  chevronSvg.appendChild(chevronPath);

  summary.appendChild(pillText);
  summary.appendChild(chevronSvg);

  const panel = document.createElement('div');
  panel.className = 'model-dropdown';

  const warning = document.createElement('div');
  warning.className   = 'model-switch-warning';
  warning.textContent = '⚠ Switching models unloads the current model — this takes time.';
  panel.appendChild(warning);

  options.forEach(opt => {
    const btn = document.createElement('button');
    btn.type        = 'button';
    btn.className   = 'model-option';
    btn.textContent = opt.value;
    if (opt.value === initial) btn.dataset.selected = '';

    btn.addEventListener('click', () => {
      if (opt.value === activeModel) {
        picker.open = false;
        return;
      }
      if (document.body.dataset.streaming) {
        pendingSwitchModel = opt.value;
        picker.open = false;
        document.getElementById('streamInterruptModal').classList.add('open');
        return;
      }
      doModelSwitch(opt.value);
      picker.open = false;
    });
    panel.appendChild(btn);
  });

  picker.appendChild(summary);
  picker.appendChild(panel);
  sel.parentNode.insertBefore(picker, sel);

  document.addEventListener('click', e => {
    if (!picker.contains(e.target)) picker.open = false;
  }, { capture: true });
}

// ── htmx: status dot + picker upgrade after model list loads ─
document.body.addEventListener('htmx:afterSwap', () => {
  if (!document.getElementById('model-loader')) {
    const connected = !!document.getElementById('model-select');
    document.querySelector('.status-dot').dataset.connected = connected;
    if (connected) upgradeModelSelect();
  }
});

// ── DOM helpers ──────────────────────────────────────────────
const msgs    = document.getElementById('messages');
const jumpBtn = document.getElementById('jumpBtn');

function isNearBottom() {
  return msgs.scrollHeight - msgs.scrollTop - msgs.clientHeight < 80;
}

function notifyNewToken() {
  if (!isNearBottom()) jumpBtn.classList.add('visible', 'lit');
}

msgs.addEventListener('scroll', () => {
  if (isNearBottom()) {
    jumpBtn.classList.remove('visible', 'lit');
  } else {
    jumpBtn.classList.add('visible');
  }
});

jumpBtn.addEventListener('click', () => {
  msgs.scrollTop = msgs.scrollHeight;
  jumpBtn.classList.remove('visible', 'lit');
});

const GREETING = `<div class="message assistant">
  <span class="label">Analyst</span>
  <div class="bubble">Hello. I'm ready to help you analyze your interview corpus. What would you like to explore?</div>
</div>`;

function makeUserMsg(text) {
  const wrap = document.createElement('div');
  wrap.className = 'message user';
  const lbl = document.createElement('span');
  lbl.className = 'label';
  lbl.textContent = 'You';
  const bbl = document.createElement('div');
  bbl.className = 'bubble';
  bbl.textContent = text;
  wrap.appendChild(lbl);
  wrap.appendChild(bbl);
  return wrap;
}

function makeAssistantShell() {
  const wrap = document.createElement('div');
  wrap.className = 'message assistant';
  const lbl = document.createElement('span');
  lbl.className = 'label';
  lbl.textContent = 'Analyst';
  const bbl = document.createElement('div');
  bbl.className = 'bubble streaming';
  wrap.appendChild(lbl);
  wrap.appendChild(bbl);
  return { wrap, bubble: bbl };
}

function makeThinkBlock(wrap, bubble) {
  const details = document.createElement('details');
  details.className = 'think-block';
  details.open = true;

  const summary = document.createElement('summary');
  summary.className = 'think-summary';

  const chevron = document.createElement('span');
  chevron.className = 'think-chevron';
  chevron.textContent = '▶';

  const icon = document.createElement('span');
  icon.className = 'think-icon';
  icon.textContent = '◈';

  const lbl = document.createElement('span');
  lbl.className = 'think-label active';
  lbl.textContent = 'Thinking…';

  summary.appendChild(chevron);
  summary.appendChild(icon);
  summary.appendChild(lbl);

  const body = document.createElement('div');
  body.className = 'think-body';

  details.appendChild(summary);
  details.appendChild(body);
  wrap.insertBefore(details, bubble);

  return { details, body, label: lbl };
}

// ── Session management ───────────────────────────────────────
let currentSessionId = null;

function formatDate(iso) {
  const d    = new Date(iso);
  const now  = new Date();
  const days = Math.floor((now - d) / 86400000);
  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days < 7)  return d.toLocaleDateString('en', { weekday: 'short' });
  return d.toLocaleDateString('en', { month: 'short', day: 'numeric' });
}

async function loadSessions() {
  const resp     = await fetch('/sessions');
  const sessions = await resp.json();
  renderSessionList(sessions);
}

function renderSessionList(sessions) {
  const list = document.getElementById('sessionList');
  list.innerHTML = '';
  sessions.forEach(s => {
    const item = document.createElement('div');
    item.className = 'session-item' + (s.id === currentSessionId ? ' active' : '');
    item.dataset.id = s.id;

    const info  = document.createElement('div');
    info.className = 'session-info';

    const title = document.createElement('div');
    title.className   = 'session-title';
    title.textContent = s.title;

    const date = document.createElement('div');
    date.className   = 'session-date';
    date.textContent = formatDate(s.updated_at);

    info.appendChild(title);
    info.appendChild(date);

    const ren = document.createElement('button');
    ren.className = 'session-rename';
    ren.title     = 'Rename';
    ren.innerHTML = '&#9998;';
    ren.addEventListener('click', e => {
      e.stopPropagation();
      startRename(item, title, s.id);
    });

    const del = document.createElement('button');
    del.className   = 'session-delete';
    del.title       = 'Delete';
    del.textContent = '×';
    del.addEventListener('click', async e => {
      e.stopPropagation();
      await fetch(`/sessions/${s.id}`, { method: 'DELETE' });
      if (currentSessionId === s.id) startNewChat();
      await loadSessions();
    });

    item.appendChild(info);
    item.appendChild(ren);
    item.appendChild(del);
    item.addEventListener('click', () => loadSession(s.id));
    list.appendChild(item);
  });
}

function startRename(item, titleEl, sessionId) {
  const current = titleEl.textContent;
  const input = document.createElement('input');
  input.className = 'session-rename-input';
  input.value = current;
  titleEl.replaceWith(input);
  input.focus();
  input.select();

  async function commit() {
    const newTitle = input.value.trim() || current;
    if (newTitle !== current) {
      const fd = new FormData();
      fd.append('title', newTitle);
      await fetch(`/sessions/${sessionId}/title`, { method: 'PATCH', body: fd });
    }
    await loadSessions();
  }

  input.addEventListener('keydown', e => {
    if (e.key === 'Enter')  { e.preventDefault(); commit(); }
    if (e.key === 'Escape') { input.replaceWith(titleEl); }
  });
  input.addEventListener('blur', commit);
}

async function loadSession(id) {
  const resp = await fetch(`/sessions/${id}`);
  const data = await resp.json();
  currentSessionId      = id;
  sessionPreferredModel = data.session.model ?? null;

  msgs.innerHTML = '';
  data.messages.forEach(m => {
    if (m.role === 'user') {
      msgs.appendChild(makeUserMsg(m.content));
    } else {
      const { wrap, bubble } = makeAssistantShell();
      if (m.thinking) {
        const t = makeThinkBlock(wrap, bubble);
        t.body.innerHTML = renderContent(m.thinking);
        t.body.classList.add('rendered');
        t.label.textContent = 'Reasoning';
        t.label.classList.remove('active');
        t.details.open      = false;
      }
      bubble.innerHTML = renderContent(m.content);
      bubble.classList.remove('streaming');
      msgs.appendChild(wrap);
    }
  });
  msgs.scrollTop = msgs.scrollHeight;

  document.querySelectorAll('.session-item').forEach(el => {
    el.classList.toggle('active', parseInt(el.dataset.id) === id);
  });
}

function startNewChat() {
  currentSessionId      = null;
  sessionPreferredModel = null;
  msgs.innerHTML        = GREETING;
  document.querySelectorAll('.session-item').forEach(el => el.classList.remove('active'));
  document.getElementById('msg-input').focus();
}

document.getElementById('newChatBtn').addEventListener('click', startNewChat);

async function createSession(model) {
  const fd = new FormData();
  if (model) fd.append('model', model);
  const resp = await fetch('/sessions', { method: 'POST', body: fd });
  return resp.json();
}

async function setSessionTitle(sessionId, firstMessage) {
  const title = firstMessage.slice(0, 48).trim() + (firstMessage.length > 48 ? '…' : '');
  const fd    = new FormData();
  fd.append('title', title);
  await fetch(`/sessions/${sessionId}/title`, { method: 'PATCH', body: fd });
}

// ── Session model mismatch prompt ────────────────────────────
function promptSessionModelChoice() {
  return new Promise(resolve => {
    document.getElementById('sessionModelBody').innerHTML =
      `This conversation was started with <strong>${sessionPreferredModel}</strong>. ` +
      `The active model is <strong>${activeModel}</strong>.`;
    document.getElementById('sessionModelKeepBtn').textContent   = `Keep ${activeModel}`;
    document.getElementById('sessionModelSwitchBtn').textContent = `Switch to ${sessionPreferredModel}`;
    document.getElementById('sessionModelModal').classList.add('open');

    function cleanup(val) {
      document.getElementById('sessionModelModal').classList.remove('open');
      document.getElementById('sessionModelKeepBtn').onclick   = null;
      document.getElementById('sessionModelSwitchBtn').onclick = null;
      resolve(val);
    }

    document.getElementById('sessionModelKeepBtn').onclick   = () => cleanup(false);
    document.getElementById('sessionModelSwitchBtn').onclick = () => cleanup(true);
  });
}

// ── Streaming chat handler ───────────────────────────────────
const form = document.getElementById('chat-form');
let modelReady   = false;
let activeReader = null;

form.addEventListener('submit', async e => {
  e.preventDefault();
  if (document.body.dataset.streaming) return;

  const textarea = document.getElementById('msg-input');
  const text     = textarea.value.trim();
  if (!text) return;

  if (currentSessionId && sessionPreferredModel && sessionPreferredModel !== activeModel) {
    const doSwitch = await promptSessionModelChoice();
    if (doSwitch) await doModelSwitch(sessionPreferredModel);
    sessionPreferredModel = null;
  }

  textarea.value = '';
  resize(textarea);
  document.body.dataset.streaming = '1';

  const isNew = !currentSessionId;
  if (isNew) {
    const s = await createSession(activeModel || '');
    currentSessionId = s.id;
    setSessionTitle(currentSessionId, text);
    loadSessions();
  }

  msgs.appendChild(makeUserMsg(text));

  const { wrap, bubble } = makeAssistantShell();
  msgs.appendChild(wrap);
  msgs.scrollTop = msgs.scrollHeight;

  let firstToken   = false;
  let responseText = '';
  let thinkText    = '';
  const loadingHint = setTimeout(() => {
    if (!firstToken && !modelReady) bubble.textContent = 'Loading model…';
  }, 1500);

  let think      = null;
  let isThinking = false;

  const parser = new ThinkParser(
    chunk => {
      if (!think) {
        think      = makeThinkBlock(wrap, bubble);
        isThinking = true;
      }
      thinkText += chunk;
      think.body.textContent += chunk;
      think.body.scrollTop    = think.body.scrollHeight;
      notifyNewToken();
    },
    chunk => {
      if (isThinking) {
        isThinking              = false;
        think.label.textContent = 'Reasoning';
        think.label.classList.remove('active');
        think.details.open      = false;
      }
      responseText    += chunk;
      bubble.innerHTML = marked.parse(responseText);
      notifyNewToken();
    }
  );

  try {
    const fd = new FormData();
    fd.append('message', text);
    fd.append('session_id', currentSessionId);
    if (activeModel) fd.append('model', activeModel);

    const resp = await fetch('/chat', { method: 'POST', body: fd });
    if (!resp.ok) {
      bubble.textContent = `Error ${resp.status}: ${resp.statusText}`;
      return;
    }

    activeReader     = resp.body.getReader();
    const decoder    = new TextDecoder();
    let lineBuf      = '';

    while (true) {
      const { done, value } = await activeReader.read();
      if (done) break;

      lineBuf += decoder.decode(value, { stream: true });
      const lines = lineBuf.split('\n');
      lineBuf     = lines.pop();

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const chunk = JSON.parse(line);
          if (chunk.error) {
            parser.flush();
            bubble.textContent += chunk.error;
            break;
          }
          if (chunk.thinking) {
            if (!think) { think = makeThinkBlock(wrap, bubble); isThinking = true; }
            thinkText += chunk.thinking;
            think.body.textContent += chunk.thinking;
            think.body.scrollTop    = think.body.scrollHeight;
          }
          if (chunk.response) {
            if (!firstToken) {
              firstToken         = true;
              modelReady         = true;
              clearTimeout(loadingHint);
              bubble.textContent = '';
            }
            parser.push(chunk.response);
          }
        } catch { /* partial JSON — wait for next chunk */ }
      }
    }

    parser.flush();

  } catch (err) {
    if (err.name !== 'AbortError') bubble.textContent = `Connection error: ${err.message}`;
  } finally {
    activeReader = null;
    clearTimeout(loadingHint);

    if (responseText) bubble.innerHTML = renderContent(responseText);
    if (think && thinkText) {
      think.body.innerHTML = renderContent(thinkText);
      think.body.classList.add('rendered');
    }

    bubble.classList.remove('streaming');
    if (isThinking && think) {
      think.label.textContent = 'Reasoning';
      think.label.classList.remove('active');
      think.details.open = false;
    }
    delete document.body.dataset.streaming;
    jumpBtn.classList.remove('lit');
    loadSessions();
  }
});

// ── Stream interrupt modal ───────────────────────────────────
document.getElementById('streamInterruptCancel').addEventListener('click', () => {
  document.getElementById('streamInterruptModal').classList.remove('open');
  pendingSwitchModel = null;
});

document.getElementById('streamInterruptConfirm').addEventListener('click', () => {
  document.getElementById('streamInterruptModal').classList.remove('open');
  const target = pendingSwitchModel;
  pendingSwitchModel = null;
  doModelSwitch(target);
  activeReader?.cancel();
});

// ── Documents (RAG context) ──────────────────────────────────
const docList = document.getElementById('docList');
const ingestingSet = new Set();
let docPollTimer = null;

async function loadDocuments() {
  let docs;
  try {
    const resp = await fetch('/documents');
    docs = await resp.json();
  } catch {
    return;
  }
  renderDocList(docs);

  const stillIngesting = docs.some(d => d.ingesting || ingestingSet.has(d.name) && !d.ingested);
  if (stillIngesting) {
    clearTimeout(docPollTimer);
    docPollTimer = setTimeout(loadDocuments, 2500);
  }
  docs.filter(d => d.ingested).forEach(d => ingestingSet.delete(d.name));
}

function renderDocList(docs) {
  if (!docs.length) {
    docList.innerHTML = '<span class="doc-empty">No PDFs in data/</span>';
    return;
  }

  const prev = {};
  docList.querySelectorAll('.doc-item[data-name]').forEach(el => {
    prev[el.dataset.name] = el.classList.contains('ingested');
  });

  docList.innerHTML = '';
  docs.forEach(doc => {
    const isIngesting  = doc.ingesting || ingestingSet.has(doc.name);
    const justFinished = !isIngesting && doc.ingested && prev[doc.name] === false;

    const item = document.createElement('div');
    item.className = 'doc-item' +
      (isIngesting ? ' ingesting' : '') +
      (doc.ingested ? ' ingested' + (justFinished ? ' flash' : '') : '');
    item.dataset.name = doc.name;

    const name = document.createElement('span');
    name.className = 'doc-name';
    name.title = doc.name;
    name.textContent = doc.name.replace(/\.pdf$/i, '');
    item.appendChild(name);

    if (doc.ingested && !isIngesting) {
      const check = document.createElement('span');
      check.className = 'doc-check';
      check.textContent = '✓';
      item.appendChild(check);

      const sumBtn = document.createElement('button');
      sumBtn.className = 'doc-summary-btn';
      sumBtn.textContent = 'Summary';
      sumBtn.title = 'Generate or view summary';
      sumBtn.addEventListener('click', () => summarizeDocument(doc.name, sumBtn));
      item.appendChild(sumBtn);
    } else {
      const btn = document.createElement('button');
      btn.className = 'doc-ingest-btn';
      btn.textContent = isIngesting ? '···' : 'Ingest';
      btn.disabled = isIngesting;
      if (!isIngesting) btn.addEventListener('click', () => ingestDocument(doc.name));
      item.appendChild(btn);
    }

    docList.appendChild(item);
  });
}

async function ingestDocument(filename) {
  ingestingSet.add(filename);
  renderDocList(await fetch('/documents').then(r => r.json()));

  const fd = new FormData();
  fd.append('filename', filename);
  fetch('/ingest', { method: 'POST', body: fd });

  clearTimeout(docPollTimer);
  docPollTimer = setTimeout(loadDocuments, 2500);
}

async function summarizeDocument(filename, btn) {
  btn.disabled = true;
  btn.textContent = '···';

  const title = filename.replace(/\.pdf$/i, '');
  openModal(title, null);

  try {
    const fd = new FormData();
    if (activeModel) fd.append('model', activeModel);

    const resp = await fetch(`/documents/${encodeURIComponent(filename)}/summary`, {
      method: 'POST',
      body: fd,
    });
    if (!resp.ok) throw new Error(`Server error ${resp.status}`);
    const data = await resp.json();
    showModalContent(data.summary);
  } catch (err) {
    showModalContent(`**Error generating summary:** ${err.message}`);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Summary';
  }
}

// ── Summary modal ────────────────────────────────────────────
const modalOverlay = document.getElementById('summaryModal');
const modalTitle   = document.getElementById('modalTitle');
const modalBody    = document.getElementById('modalBody');
const modalClose   = document.getElementById('modalClose');

function openModal(title, content) {
  modalTitle.textContent = title;
  modalBody.innerHTML = content === null
    ? '<span class="modal-loading">Generating summary…</span>'
    : renderContent(content);
  modalOverlay.classList.add('open');
}

function showModalContent(content) {
  modalBody.innerHTML = renderContent(content);
}

function closeModal() {
  modalOverlay.classList.remove('open');
}

modalClose.addEventListener('click', closeModal);
modalOverlay.addEventListener('click', e => {
  if (e.target === modalOverlay) closeModal();
});
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') closeModal();
});

// ── Init ─────────────────────────────────────────────────────
fetch('/models/active').then(r => r.json()).then(d => { activeModel = d.model ?? null; });
loadSessions();
loadDocuments();
