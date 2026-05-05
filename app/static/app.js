import { ThinkParser } from './think-parser.js';
import { marked } from 'https://esm.sh/marked@15';

marked.use({ breaks: true });

// ── Textarea resize ──────────────────────────────────────────
export function resize(el) {
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 180) + 'px';
}
window.resize = resize; // expose for inline oninput attribute

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

// ── Custom model picker (replaces native <select>) ───────────
function upgradeModelSelect() {
  const sel = document.getElementById('model-select');
  if (!sel || document.getElementById('model-picker')) return;

  const options = Array.from(sel.options);
  let current   = sel.value || options[0]?.value || '';

  const picker = document.createElement('details');
  picker.id        = 'model-picker';
  picker.className = 'model-picker';

  const summary = document.createElement('summary');
  summary.className = 'model-pill';

  const pillText = document.createElement('span');
  pillText.className   = 'model-pill-text';
  pillText.textContent = current;

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

  options.forEach(opt => {
    const btn = document.createElement('button');
    btn.type        = 'button';
    btn.className   = 'model-option';
    btn.textContent = opt.value;
    if (opt.value === current) btn.dataset.selected = '';

    btn.addEventListener('click', () => {
      current              = opt.value;
      sel.value            = opt.value;
      pillText.textContent = opt.value;
      panel.querySelectorAll('.model-option').forEach(b => delete b.dataset.selected);
      btn.dataset.selected = '';
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

// ── Streaming chat handler ───────────────────────────────────
const form = document.getElementById('chat-form');
const msgs = document.getElementById('messages');
let modelReady = false;

form.addEventListener('submit', async e => {
  e.preventDefault();
  if (document.body.dataset.streaming) return;

  const textarea = document.getElementById('msg-input');
  const text     = textarea.value.trim();
  if (!text) return;

  textarea.value = '';
  resize(textarea);
  document.body.dataset.streaming = '1';

  msgs.appendChild(makeUserMsg(text));

  const { wrap, bubble } = makeAssistantShell();
  msgs.appendChild(wrap);
  msgs.scrollTop = 999999;

  let firstToken   = false;
  let responseText = '';
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
      think.body.textContent += chunk;
      think.body.scrollTop    = think.body.scrollHeight;
      msgs.scrollTop          = 999999;
    },
    chunk => {
      if (isThinking) {
        isThinking              = false;
        think.label.textContent = 'Reasoning';
        think.label.classList.remove('active');
        think.details.open      = false;
      }
      responseText       += chunk;
      bubble.innerHTML    = marked.parse(responseText);
      msgs.scrollTop      = 999999;
    }
  );

  try {
    const fd  = new FormData();
    fd.append('message', text);
    const sel = document.getElementById('model-select');
    if (sel) fd.append('model', sel.value);

    const resp = await fetch('/chat', { method: 'POST', body: fd });
    if (!resp.ok) {
      bubble.textContent = `Error ${resp.status}: ${resp.statusText}`;
      return;
    }

    const reader  = resp.body.getReader();
    const decoder = new TextDecoder();
    let lineBuf   = '';

    while (true) {
      const { done, value } = await reader.read();
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
            think.body.textContent += chunk.thinking;
            think.body.scrollTop    = think.body.scrollHeight;
          }
          if (chunk.response) {
            if (!firstToken) {
              firstToken        = true;
              modelReady        = true;
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
    bubble.textContent = `Connection error: ${err.message}`;
  } finally {
    clearTimeout(loadingHint);
    bubble.classList.remove('streaming');
    if (isThinking && think) {
      think.label.textContent = 'Reasoning';
      think.label.classList.remove('active');
      think.details.open = false;
    }
    delete document.body.dataset.streaming;
    msgs.scrollTop = 999999;
  }
});
