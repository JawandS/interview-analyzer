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

function linkifyCitations(html) {
  return html.replace(
    /\(Source:\s*([\w.\- ]+?),\s*excerpt\s*(\d+)\)/g,
    (_, file, chunk) =>
      `<a class="citation-link" data-file="${file.trim()}" data-chunk="${chunk}" href="#">(Source: ${file.trim()}, excerpt ${chunk})</a>`
  );
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
setTheme(localStorage.getItem('theme') || 'light');

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
      bubble.innerHTML = linkifyCitations(renderContent(m.content));
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

    if (responseText) bubble.innerHTML = linkifyCitations(renderContent(responseText));
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

// ── Citation click handler ───────────────────────────────────
document.getElementById('messages').addEventListener('click', async (e) => {
  const a = e.target.closest('.citation-link');
  if (!a) return;
  e.preventDefault();
  const file  = a.dataset.file;
  const chunk = a.dataset.chunk;
  try {
    const res  = await fetch(`/pdf/${encodeURIComponent(file)}/page?chunk=${chunk}`);
    const data = await res.json();
    const pdfUrl = `/static/data/${encodeURIComponent(file)}#page=${data.page}`;
    const title  = file.replace(/\.pdf$/i, '');
    const body   = data.text
      ? `<blockquote style="white-space:pre-wrap;margin:0 0 1rem">${data.text}</blockquote><a href="${pdfUrl}" target="_blank" style="font-size:.85rem">Open PDF (page ${data.page}) ↗</a>`
      : `<a href="${pdfUrl}" target="_blank">Open PDF (page ${data.page}) ↗</a>`;
    modalTitle.textContent = title;
    modalBody.innerHTML = body;
    modalOverlay.classList.add('open');
  } catch {
    window.open(`/static/data/${encodeURIComponent(file)}`, '_blank');
  }
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
  docs.filter(d => d.ingested).forEach(d => ingestingSet.delete(d.name));
  renderDocList(docs);

  const stillIngesting = docs.some(d => d.ingesting || ingestingSet.has(d.name) && !d.ingested);
  if (stillIngesting) {
    clearTimeout(docPollTimer);
    docPollTimer = setTimeout(loadDocuments, 2500);
  }
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

      const menuWrap = document.createElement('div');
      menuWrap.className = 'doc-menu';

      const menuBtn = document.createElement('button');
      menuBtn.className = 'doc-menu-btn';
      menuBtn.title = 'Actions';
      menuBtn.textContent = '⋯';
      menuWrap.appendChild(menuBtn);

      const dropdown = document.createElement('div');
      dropdown.className = 'doc-dropdown';

      const actions = [
        { label: 'Summary',  fn: () => summarizeDocument(doc.name, dropdown.querySelector('[data-action="Summary"]')) },
        { label: 'Extract',  fn: () => extractDocument(doc.name,   dropdown.querySelector('[data-action="Extract"]')) },
        { label: 'Themes',   fn: () => themeDocument(doc.name,     dropdown.querySelector('[data-action="Themes"]')) },
        { label: 'Tensions', fn: () => tensionDocument(doc.name,   dropdown.querySelector('[data-action="Tensions"]')) },
      ];

      actions.forEach(({ label, fn }) => {
        const opt = document.createElement('button');
        opt.className = 'doc-dropdown-item';
        opt.dataset.action = label;
        opt.textContent = label;
        opt.addEventListener('click', e => {
          e.stopPropagation();
          dropdown.classList.remove('open');
          fn();
        });
        dropdown.appendChild(opt);
      });

      menuWrap.appendChild(dropdown);
      item.appendChild(menuWrap);

      menuBtn.addEventListener('click', e => {
        e.stopPropagation();
        const isOpen = dropdown.classList.contains('open');
        document.querySelectorAll('.doc-dropdown.open').forEach(d => d.classList.remove('open'));
        if (!isOpen) dropdown.classList.add('open');
      });
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

document.addEventListener('click', () => {
  document.querySelectorAll('.doc-dropdown.open').forEach(d => d.classList.remove('open'));
});

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

    const reader  = resp.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.error) {
            showModalContent(`**Error:** ${msg.error}`);
          } else if (msg.stage === 'cached' || msg.stage === 'done') {
            showModalContent(msg.summary);
          } else if (msg.stage === 'map_cached') {
            updateSummaryProgress('Using cached passages…', 1);
          } else if (msg.stage === 'map') {
            updateSummaryProgress(`Reading passage ${msg.batch} of ${msg.total}…`, msg.batch / msg.total);
          } else if (msg.stage === 'reduce') {
            switchToStreamingView();
          } else if (msg.stage === 'streaming') {
            appendStreamingToken(msg.token);
          }
        } catch { /* partial line — wait for next chunk */ }
      }
    }
  } catch (err) {
    showModalContent(`**Error generating summary:** ${err.message}`);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Summary';
  }
}

async function extractDocument(filename, btn) {
  btn.disabled = true;
  btn.textContent = '···';

  const title = filename.replace(/\.pdf$/i, '');
  openModal('Extract — ' + title, null);

  try {
    const fd = new FormData();
    if (activeModel) fd.append('model', activeModel);

    const resp = await fetch(`/documents/${encodeURIComponent(filename)}/extract`, {
      method: 'POST',
      body: fd,
    });
    if (!resp.ok) throw new Error(`Server error ${resp.status}`);

    const reader  = resp.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.error) {
            showModalContent(`**Error:** ${msg.error}`);
          } else if (msg.stage === 'cached' || msg.stage === 'done') {
            showExtractionCard(msg.data);
          } else if (msg.stage === 'map_cached') {
            updateSummaryProgress('Using cached passages…', 1);
          } else if (msg.stage === 'map') {
            updateSummaryProgress(`Scanning passage ${msg.batch} of ${msg.total}…`, msg.batch / msg.total);
          } else if (msg.stage === 'reduce') {
            updateSummaryProgress('Synthesizing fields…', 1);
          }
        } catch { }
      }
    }
  } catch (err) {
    showModalContent(`**Error extracting data:** ${err.message}`);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Extract';
  }
}

function showExtractionCard(data) {
  const fields = [
    { key: 'acreage',             label: 'Acreage' },
    { key: 'grant_status',        label: 'Grant Status' },
    { key: 'generational_status', label: 'Generation' },
    { key: 'farm_type',           label: 'Farm Type' },
  ];

  const table = document.createElement('table');
  table.className = 'extraction-table';

  fields.forEach(({ key, label }) => {
    const row = table.insertRow();
    const th = document.createElement('th');
    th.textContent = label;
    const td = document.createElement('td');
    const val = data[key];
    td.textContent = val ?? '—';
    if (!val) td.classList.add('extraction-null');
    row.appendChild(th);
    row.appendChild(td);
  });

  if (data.notes) {
    const nr = table.insertRow();
    nr.className = 'extraction-notes-row';
    const nth = document.createElement('th');
    nth.textContent = 'Notes';
    const ntd = document.createElement('td');
    ntd.textContent = data.notes;
    nr.appendChild(nth);
    nr.appendChild(ntd);
  }

  modalBody.innerHTML = '';
  modalBody.appendChild(table);
}

async function themeDocument(filename, btn) {
  btn.disabled = true;
  btn.textContent = '···';

  const title = filename.replace(/\.pdf$/i, '');

  try {
    const cached = await fetch(`/documents/${encodeURIComponent(filename)}/themes`);
    if (cached.ok) {
      const data = await cached.json();
      modalTitle.textContent = 'Themes — ' + title;
      modalBody.innerHTML = '';
      modalOverlay.classList.add('open');
      showThemesList(data.themes);
      btn.disabled = false;
      btn.textContent = 'Themes';
      return;
    }
  } catch { }

  openModal('Themes — ' + title, null);

  try {
    const fd = new FormData();
    if (activeModel) fd.append('model', activeModel);

    const resp = await fetch(`/documents/${encodeURIComponent(filename)}/themes`, {
      method: 'POST',
      body: fd,
    });
    if (!resp.ok) throw new Error(`Server error ${resp.status}`);

    const reader  = resp.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.error) {
            showModalContent(`**Error:** ${msg.error}`);
          } else if (msg.stage === 'cached' || msg.stage === 'done') {
            showThemesList(msg.themes);
            loadCorpusPanel();
          } else if (msg.stage === 'map_cached') {
            updateSummaryProgress('Using cached passages…', 1);
          } else if (msg.stage === 'map') {
            updateSummaryProgress(`Scanning passage ${msg.batch} of ${msg.total}…`, msg.batch / msg.total);
          } else if (msg.stage === 'reduce') {
            updateSummaryProgress('Consolidating themes…', 1);
          }
        } catch { }
      }
    }
  } catch (err) {
    showModalContent(`**Error extracting themes:** ${err.message}`);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Themes';
  }
}

function showThemesList(themes) {
  if (!themes || !themes.length) {
    modalBody.innerHTML = '<p style="color:var(--text-muted);padding:1rem">No themes identified.</p>';
    return;
  }

  const table = document.createElement('table');
  table.className = 'extraction-table';

  const hdr = table.createTHead().insertRow();
  ['Theme', 'Mentions', 'Quote'].forEach(h => {
    const th = document.createElement('th');
    th.textContent = h;
    hdr.appendChild(th);
  });

  themes.forEach(t => {
    const row = table.insertRow();
    const tdName = row.insertCell();
    tdName.textContent = t.name || '—';
    const tdMentions = row.insertCell();
    tdMentions.textContent = t.mentions ?? '—';
    tdMentions.style.textAlign = 'center';
    const tdQuote = row.insertCell();
    tdQuote.textContent = t.quote ? `"${t.quote}"` : '—';
    tdQuote.style.fontStyle = 'italic';
  });

  modalBody.innerHTML = '';
  modalBody.appendChild(table);
}

async function tensionDocument(filename, btn) {
  btn.disabled = true;
  btn.textContent = '···';

  const title = filename.replace(/\.pdf$/i, '');

  try {
    const cached = await fetch(`/documents/${encodeURIComponent(filename)}/contradictions`);
    if (cached.ok) {
      const data = await cached.json();
      modalTitle.textContent = 'Internal Tensions — ' + title;
      modalBody.innerHTML = '';
      modalOverlay.classList.add('open');
      renderContradictions(data.contradictions, filename);
      btn.disabled = false;
      btn.textContent = 'Tensions';
      return;
    }
  } catch { }

  openModal('Internal Tensions — ' + title, null);

  try {
    const fd = new FormData();
    if (activeModel) fd.append('model', activeModel);

    const resp = await fetch(`/documents/${encodeURIComponent(filename)}/contradictions`, {
      method: 'POST',
      body: fd,
    });
    if (!resp.ok) throw new Error(`Server error ${resp.status}`);

    const reader  = resp.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.error) {
            showModalContent(`**Error:** ${msg.error}`);
          } else if (msg.stage === 'cached' || msg.stage === 'done') {
            renderContradictions(msg.contradictions, filename);
          } else if (msg.stage === 'map_cached') {
            updateSummaryProgress('Using cached passages…', 1);
          } else if (msg.stage === 'map') {
            updateSummaryProgress(`Scanning passage ${msg.batch} of ${msg.total}…`, msg.batch / msg.total);
          } else if (msg.stage === 'reduce') {
            updateSummaryProgress('Detecting contradictions…', 1);
          }
        } catch { }
      }
    }
  } catch (err) {
    showModalContent(`**Error detecting tensions:** ${err.message}`);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Tensions';
  }
}

const TYPE_LABELS = {
  belief_vs_practice: 'Belief vs. Practice',
  self_contradiction:  'Self-Contradiction',
  hedging:             'Hedging',
};

const SEVERITY_STYLES = {
  strong:   { color: '#c05050', bg: 'rgba(192, 80, 80, 0.1)',  border: 'rgba(192, 80, 80, 0.3)'  },
  moderate: { color: '#b48246', bg: 'rgba(180, 130, 70, 0.1)', border: 'rgba(180, 130, 70, 0.3)' },
  mild:     { color: '#888',    bg: 'rgba(136, 136, 136, 0.08)', border: 'rgba(136, 136, 136, 0.25)' },
};

function renderContradictions(findings, filename) {
  if (!findings || !findings.length) {
    modalBody.innerHTML = '<p style="color:var(--text-muted);padding:1rem">No internal tensions or contradictions detected.</p>';
    return;
  }

  modalBody.innerHTML = '';

  findings.forEach(f => {
    const sev   = SEVERITY_STYLES[f.severity] || SEVERITY_STYLES.mild;
    const label = TYPE_LABELS[f.type] || f.type;

    const card = document.createElement('div');
    card.style.cssText = `border:1px solid ${sev.border};border-radius:5px;padding:0.85rem 1rem;margin-bottom:0.85rem;background:${sev.bg}`;

    const header = document.createElement('div');
    header.style.cssText = 'display:flex;align-items:center;gap:0.5rem;margin-bottom:0.5rem';

    const badge = document.createElement('span');
    badge.textContent = f.severity;
    badge.style.cssText = `font-family:"Consolas","Menlo","Courier New",monospace;font-size:0.62rem;letter-spacing:0.1em;text-transform:uppercase;color:${sev.color};background:${sev.bg};border:1px solid ${sev.border};border-radius:3px;padding:0.1rem 0.35rem;flex-shrink:0`;

    const typeEl = document.createElement('span');
    typeEl.textContent = label;
    typeEl.style.cssText = 'font-family:"Consolas","Menlo","Courier New",monospace;font-size:0.72rem;letter-spacing:0.06em;text-transform:uppercase;color:var(--text-secondary)';

    header.appendChild(badge);
    header.appendChild(typeEl);

    const desc = document.createElement('p');
    desc.textContent = f.description;
    desc.style.cssText = 'margin:0 0 0.75rem;font-size:0.88rem;color:var(--text);line-height:1.6';

    const qa = document.createElement('blockquote');
    qa.textContent = `"${f.quote_a}"`;
    qa.style.cssText = 'margin:0 0 0.35rem;font-style:italic;font-size:0.84rem;color:var(--text-secondary);border-left:2px solid var(--border-hard);padding-left:0.75rem';

    const divider = document.createElement('div');
    divider.textContent = '↕';
    divider.style.cssText = 'text-align:center;color:var(--muted);font-size:0.8rem;margin:0.2rem 0';

    const qb = document.createElement('blockquote');
    qb.textContent = `"${f.quote_b}"`;
    qb.style.cssText = 'margin:0;font-style:italic;font-size:0.84rem;color:var(--text-secondary);border-left:2px solid var(--border-hard);padding-left:0.75rem';

    card.appendChild(header);
    card.appendChild(desc);
    card.appendChild(qa);
    card.appendChild(divider);
    card.appendChild(qb);
    modalBody.appendChild(card);
  });
}

// ── Corpus Analysis panel ─────────────────────────────────────
function _renderCorpusThemes(data, body) {
  const maxDocs = data.documents_analyzed || data.documents_with_themes || 1;

  const meta = document.createElement('p');
  meta.className = 'corpus-meta';
  const tag = data.llm_extracted ? ' · LLM synthesized' : ' · label-matched';
  meta.textContent = `${data.documents_with_themes} of ${data.documents_analyzed ?? data.documents_with_themes} docs analyzed${tag}`;

  const list = document.createElement('div');
  list.className = 'corpus-theme-list';

  (data.themes || []).forEach(t => {
    const row = document.createElement('div');
    row.className = 'corpus-theme-row';

    const nameEl = document.createElement('span');
    nameEl.className = 'corpus-theme-name';
    nameEl.textContent = t.name;

    const badge = document.createElement('span');
    badge.className = 'corpus-theme-badge';
    badge.textContent = `${t.doc_count} doc${t.doc_count !== 1 ? 's' : ''}`;

    const bar = document.createElement('div');
    bar.className = 'corpus-theme-bar';
    const fill = document.createElement('div');
    fill.className = 'corpus-theme-bar-fill';
    fill.style.width = `${Math.round((t.doc_count / maxDocs) * 100)}%`;
    bar.appendChild(fill);

    row.appendChild(nameEl);
    row.appendChild(badge);
    row.appendChild(bar);

    if (t.quote) {
      const quote = document.createElement('div');
      quote.className = 'corpus-theme-quote';
      quote.textContent = `"${t.quote}"`;
      row.appendChild(quote);
    }

    list.appendChild(row);
  });

  const actions = document.createElement('div');
  actions.className = 'corpus-actions';

  const extractBtn = document.createElement('button');
  extractBtn.className = 'corpus-extract-btn';
  extractBtn.textContent = data.llm_extracted ? 'Re-extract' : 'Extract corpus themes';
  extractBtn.title = 'Run LLM cross-document map-reduce to find recurring patterns';
  extractBtn.addEventListener('click', () => runCorpusExtraction(extractBtn));
  actions.appendChild(extractBtn);

  const refreshBtn = document.createElement('button');
  refreshBtn.className = 'corpus-refresh-btn';
  refreshBtn.textContent = 'Refresh';
  refreshBtn.addEventListener('click', loadCorpusPanel);
  actions.appendChild(refreshBtn);

  body.innerHTML = '';
  body.appendChild(meta);
  if (data.themes && data.themes.length) body.appendChild(list);
  body.appendChild(actions);
}

async function loadCorpusPanel() {
  try {
    const resp = await fetch('/corpus/themes');
    if (!resp.ok) return;
    const data = await resp.json();

    const section = document.getElementById('corpusSection');
    const body    = document.getElementById('corpusBody');

    if (data.documents_with_themes === 0) {
      section.style.display = 'none';
      return;
    }

    section.style.display = '';
    _renderCorpusThemes(data, body);
  } catch { }
}

async function runCorpusExtraction(btn) {
  btn.disabled = true;
  btn.textContent = '···';

  const body = document.getElementById('corpusBody');

  const progressEl = document.createElement('p');
  progressEl.className = 'corpus-meta';
  progressEl.textContent = 'Starting…';
  body.appendChild(progressEl);

  try {
    const fd = new FormData();
    if (activeModel) fd.append('model', activeModel);

    const resp = await fetch('/corpus/themes/extract', { method: 'POST', body: fd });
    if (!resp.ok) throw new Error(`Server error ${resp.status}`);

    const reader  = resp.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.error) {
            progressEl.textContent = `Error: ${msg.error}`;
          } else if (msg.stage === 'cached' || msg.stage === 'done') {
            _renderCorpusThemes({ ...msg, llm_extracted: true }, body);
            return;
          } else if (msg.stage === 'map') {
            progressEl.textContent = `Cross-document pass: document batch ${msg.batch} of ${msg.total}…`;
          } else if (msg.stage === 'reduce') {
            progressEl.textContent = 'Synthesizing corpus themes…';
          }
        } catch { }
      }
    }
  } catch (err) {
    const body2 = document.getElementById('corpusBody');
    const p = document.createElement('p');
    p.className = 'corpus-meta';
    p.textContent = `Error: ${err.message}`;
    body2.appendChild(p);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Re-extract';
  }
}

document.getElementById('corpusDetails')?.addEventListener('toggle', function() {
  if (this.open) loadCorpusPanel();
});

// ── Corpus Tensions ───────────────────────────────────────────
function _renderCorpusTensions(data, container) {
  container.innerHTML = '';

  const meta = document.createElement('p');
  meta.className = 'corpus-meta';
  meta.textContent = `${data.documents_analyzed} doc${data.documents_analyzed !== 1 ? 's' : ''} analyzed${data.llm_extracted ? ' · LLM synthesized' : ''}`;
  container.appendChild(meta);

  if (!data.contradictions || !data.contradictions.length) {
    const empty = document.createElement('p');
    empty.className = 'corpus-meta';
    empty.textContent = 'No cross-document tensions found.';
    container.appendChild(empty);
    return;
  }

  data.contradictions.forEach(c => {
    const block = document.createElement('div');
    block.style.cssText = 'margin-bottom:0.85rem;padding-bottom:0.85rem;border-bottom:1px solid var(--border)';

    const topic = document.createElement('div');
    topic.style.cssText = 'font-size:0.78rem;color:var(--text-primary);margin-bottom:0.3rem';
    topic.textContent = `Topic: ${c.topic}`;

    const summary = document.createElement('div');
    summary.style.cssText = 'font-size:0.72rem;color:var(--text-muted);margin-bottom:0.4rem;line-height:1.5';
    summary.textContent = c.tension_summary;

    block.appendChild(topic);
    block.appendChild(summary);

    (c.positions || []).forEach(pos => {
      const posEl = document.createElement('div');
      posEl.style.cssText = 'margin-bottom:0.25rem';

      const stance = document.createElement('div');
      stance.style.cssText = 'font-size:0.7rem;color:var(--text-secondary)';
      stance.textContent = pos.stance + (pos.documents && pos.documents.length ? ` (${pos.documents.join(', ')})` : '');

      const q = document.createElement('div');
      q.style.cssText = 'font-size:0.7rem;font-style:italic;color:var(--text-muted);padding-left:0.6rem;border-left:1px solid var(--border-hard);margin-top:0.15rem';
      q.textContent = pos.quote ? `"${pos.quote}"` : '';

      posEl.appendChild(stance);
      if (pos.quote) posEl.appendChild(q);
      block.appendChild(posEl);
    });

    container.appendChild(block);
  });
}

async function runCorpusTensions(btn) {
  btn.disabled = true;
  btn.textContent = '···';

  const container = document.getElementById('corpusTensionsBody');

  const progressEl = document.createElement('p');
  progressEl.className = 'corpus-meta';
  progressEl.textContent = 'Starting…';
  container.innerHTML = '';
  container.appendChild(progressEl);

  try {
    const cached = await fetch('/corpus/contradictions');
    if (cached.ok) {
      const data = await cached.json();
      if (data.documents_analyzed > 0) {
        _renderCorpusTensions({ ...data, llm_extracted: true }, container);
        return;
      }
    }
  } catch { }

  try {
    const fd = new FormData();
    if (activeModel) fd.append('model', activeModel);

    const resp = await fetch('/corpus/contradictions/extract', { method: 'POST', body: fd });
    if (!resp.ok) throw new Error(`Server error ${resp.status}`);

    const reader  = resp.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.error) {
            progressEl.textContent = `Error: ${msg.error}`;
          } else if (msg.stage === 'cached' || msg.stage === 'done') {
            _renderCorpusTensions({ ...msg, llm_extracted: true }, container);
            return;
          } else if (msg.stage === 'map') {
            progressEl.textContent = `Scanning document batch ${msg.batch} of ${msg.total}…`;
          } else if (msg.stage === 'reduce') {
            progressEl.textContent = 'Synthesizing cross-document tensions…';
          }
        } catch { }
      }
    }
  } catch (err) {
    container.innerHTML = '';
    const p = document.createElement('p');
    p.className = 'corpus-meta';
    p.textContent = `Error: ${err.message}`;
    container.appendChild(p);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Run';
  }
}

document.getElementById('corpusTensionsRunBtn')?.addEventListener('click', function() {
  runCorpusTensions(this);
});

// ── Document upload ──────────────────────────────────────────
const docUploadBtn   = document.getElementById('docUploadBtn');
const docFileInput   = document.getElementById('docFileInput');

docUploadBtn.addEventListener('click', () => docFileInput.click());

docFileInput.addEventListener('change', async () => {
  const file = docFileInput.files[0];
  if (!file) return;
  docFileInput.value = '';
  docUploadBtn.disabled = true;
  docUploadBtn.textContent = '···';
  try {
    const fd = new FormData();
    fd.append('file', file);
    const resp = await fetch('/documents/upload', { method: 'POST', body: fd });
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      alert(err.detail || 'Upload failed');
    } else {
      await loadDocuments();
    }
  } finally {
    docUploadBtn.disabled = false;
    docUploadBtn.textContent = '+';
  }
});

// ── Summary modal ────────────────────────────────────────────
const modalOverlay = document.getElementById('summaryModal');
const modalTitle   = document.getElementById('modalTitle');
const modalBody    = document.getElementById('modalBody');
const modalClose   = document.getElementById('modalClose');

function openModal(title, content) {
  modalTitle.textContent = title;
  modalBody.innerHTML = content === null
    ? `<div class="summary-progress">
         <span class="summary-progress-label" id="summaryProgressLabel">Starting…</span>
         <div class="summary-progress-track">
           <div class="summary-progress-fill" id="summaryProgressFill"></div>
         </div>
       </div>`
    : renderContent(content);
  modalOverlay.classList.add('open');
}

function updateSummaryProgress(label, fraction) {
  const lbl  = document.getElementById('summaryProgressLabel');
  const fill = document.getElementById('summaryProgressFill');
  if (lbl)  lbl.textContent     = label;
  if (fill) fill.style.width    = `${Math.round(fraction * 100)}%`;
}

function showModalContent(content) {
  modalBody.innerHTML = renderContent(content);
}

function switchToStreamingView() {
  modalBody.innerHTML = '<div class="summary-stream"></div>';
}

function appendStreamingToken(token) {
  const el = modalBody.querySelector('.summary-stream');
  if (el) el.textContent += token;
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
loadCorpusPanel();
