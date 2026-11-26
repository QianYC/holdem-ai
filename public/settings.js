// Settings panel: game rules, AI roster (models, personas, art, stickers), sticker set and model endpoint.
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]);

let draft = null;
let art = {};
let hasApiKey = false;
let maxAi = 9;
let models = [];
let tab = 'game';
let open = null; // index of the expanded AI card
const jobs = {}; // key -> {id, stage, status}

async function api(url, body, opts = {}) {
  const r = await fetch(url, body === undefined ? opts : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), ...opts });
  return r.json().catch(() => ({ ok: false, error: `HTTP ${r.status}` }));
}

function status(msg, bad = false) {
  const el = $('setStatus');
  el.textContent = msg;
  el.className = bad ? 'bad' : '';
}

function slug(s, i) {
  const k = String(s ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32);
  return k || `ai${i + 1}`;
}

function get(obj, pathStr) {
  return pathStr.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}
function set(obj, pathStr, value) {
  const keys = pathStr.split('.');
  let o = obj;
  for (const k of keys.slice(0, -1)) o = o[k] ??= {};
  o[keys.at(-1)] = value;
}

// ---------------------------------------------------------------- field helpers
const field = (label, pathStr, { type = 'text', hint = '', attrs = '', list = '' } = {}) => {
  const v = get(draft, pathStr);
  if (type === 'bool') return `<label class="sf chk"><input type="checkbox" data-bind="${pathStr}" data-type="bool" ${v ? 'checked' : ''}> ${label}${hint ? `<small>${hint}</small>` : ''}</label>`;
  if (type === 'textarea') return `<label class="sf wide">${label}<textarea data-bind="${pathStr}" rows="3" ${attrs}>${esc(v)}</textarea>${hint ? `<small>${hint}</small>` : ''}</label>`;
  return `<label class="sf">${label}<input data-bind="${pathStr}" data-type="${type}" type="${type === 'number' ? 'number' : type === 'color' ? 'color' : type === 'password' ? 'password' : 'text'}" value="${esc(v)}" ${list ? `list="${list}"` : ''} ${attrs}>${hint ? `<small>${hint}</small>` : ''}</label>`;
};
const select = (label, pathStr, options, hint = '') =>
  `<label class="sf">${label}<select data-bind="${pathStr}">${options.map(([v, t]) => `<option value="${esc(v)}" ${String(get(draft, pathStr) ?? '') === v ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select>${hint ? `<small>${hint}</small>` : ''}</label>`;

// ---------------------------------------------------------------- tabs
function gameTab() {
  return `<div class="sgrid">
    ${field('你的名字', 'humanName')}
    ${field('起始筹码', 'startingStack', { type: 'number' })}
    ${field('小盲', 'smallBlind', { type: 'number' })}
    ${field('大盲', 'bigBlind', { type: 'number' })}
    ${field('每隔几手升一级盲注（0 = 不升）', 'handsPerLevel', { type: 'number' })}
    <label class="sf wide">盲注级别（小盲/大盲，逗号分隔；留空 = 按起始小盲自动生成，最后一级之后每级翻倍）<input id="blindLevelsText" value="${esc((draft.blindLevels ?? []).map(([s, b]) => `${s}/${b}`).join(', '))}" placeholder="10/20, 15/30, 20/40, 30/60, 50/100, 75/150, 100/200"></label>
    ${select('结算画面风格', 'defeatStyle', [['flirty', '魅惑（角色卡 + 撩人台词）'], ['classic', '经典 GAME OVER']])}
    ${field('AI 最短行动展示（毫秒）', 'minActionDelayMs', { type: 'number' })}
    ${field('自动发下一手（毫秒，0 = 手动）', 'autoNextHandMs', { type: 'number' })}
    ${field('观战每手间隔（毫秒）', 'spectateDelayMs', { type: 'number' })}
    ${field('快速发言用的模型', 'quickReplyModel', { list: 'modelList' })}
  </div>
  <div class="schecks">
    ${field('淘汰赛：筹码归零即出局', 'eliminateBusted', { type: 'bool' })}
    ${field('现金桌模式下 AI 输光自动补码', 'aiAutoRebuy', { type: 'bool', hint: '（关闭淘汰赛时生效）' })}
    ${field('每局随机换座', 'randomSeats', { type: 'bool' })}
    ${field('轮到我时生成快速发言', 'quickReplies', { type: 'bool' })}
    ${field('明牌模式（显示所有 AI 底牌）', 'revealAllCards', { type: 'bool' })}
  </div>
  <h4 class="shead">📶 局域网模式</h4>
  <div class="sgrid">
    ${field('开启局域网模式（同一网络的朋友用浏览器加入）', 'lan.enabled', { type: 'bool' })}
    ${field('房间密码（可选）', 'lan.password', { type: 'password', attrs: 'placeholder="留空 = 不需要密码"' })}
    ${field('朋友每次行动的时限（毫秒，超时自动过牌/弃牌，0 = 不限）', 'lan.turnTimeoutMs', { type: 'number', attrs: 'placeholder="90000"' })}
  </div>
  <p class="snote">开启后服务器会监听局域网地址，朋友打开页面右上角「📶 局域网」里显示的地址即可加入；保存后立即生效。只有房主（在这台电脑上打开页面的人）能改设置、发牌、开新局。</p>
  <p class="snote">盲注按「第一手的小盲/大盲 → 盲注级别」逐级上升（锦标赛结构），当前级别显示在页面顶部。<br>起始筹码、盲注、你的名字以及 AI 名单 / 模型的改动在<b>新的一局</b>生效；其余设置从下一手起生效。</p>`;
}

function artSlot(a, slot, label) {
  const url = art[a.key]?.[slot];
  return `<div class="slot">
    <div class="thumb">${url ? `<img src="${esc(url)}">` : '<span>无</span>'}</div>
    <div class="slabel">${label}</div>
    <div class="sbtns">
      <button type="button" data-up="${slot}">上传</button>
      ${url ? `<button type="button" data-del="${slot}">删除</button>` : ''}
    </div>
  </div>`;
}

function aiCard(a, i) {
  const k = a.key;
  const st = art[k]?.stickers ?? [];
  const job = jobs[k];
  const expanded = open === i;
  return `<div class="aicard" data-i="${i}">
    <div class="aihead">
      ${field('', `ai.${i}.avatar`, { attrs: 'class="emo" maxlength="4" title="没有立绘时的头像"' })}
      ${field('名字', `ai.${i}.name`)}
      ${field('模型', `ai.${i}.model`, { list: 'modelList' })}
      ${select('推理', `ai.${i}.reasoning`, [['', '默认'], ['low', 'low'], ['medium', 'medium'], ['high', 'high']])}
      ${field('颜色', `ai.${i}.color`, { type: 'color' })}
      <div class="aibtns">
        <button type="button" data-move="-1" ${i === 0 ? 'disabled' : ''} title="上移">↑</button>
        <button type="button" data-move="1" ${i === draft.ai.length - 1 ? 'disabled' : ''} title="下移">↓</button>
        <button type="button" data-toggle>${expanded ? '收起' : '人设与形象 ▾'}</button>
        <button type="button" class="danger" data-remove title="移除这个 AI" ${draft.ai.length <= 1 ? 'disabled' : ''}>✕</button>
      </div>
    </div>
    ${
      expanded
        ? `<div class="aibody">
      <div class="sgrid">
        ${field('称号', `ai.${i}.title`)}
        ${field('美术目录 key', `ai.${i}.key`, { hint: `public/characters/${esc(k)}/`, attrs: 'pattern="[a-z0-9_-]+"' })}
      </div>
      ${field('人设（写进系统提示词，决定说话风格）', `ai.${i}.persona`, { type: 'textarea', attrs: 'rows="4"' })}
      <div class="arts">
        ${artSlot(a, 'portrait', '立绘')}
        ${artSlot(a, 'win', '胜利')}
        ${artSlot(a, 'lose', '战败')}
        <div class="stickers">
          <div class="slabel">表情包（${st.length}）</div>
          <div class="sgrid2">${st.map((s) => `<div class="stk" title="${esc(s.label)}"><img src="${esc(s.url)}"><button type="button" data-delstk="${esc(s.id)}">×</button><span>${esc(s.label)}</span></div>`).join('') || '<span class="muted">还没有</span>'}</div>
          <div class="sbtns"><button type="button" data-upstk>＋ 上传表情</button></div>
        </div>
      </div>
      <details class="gen">
        <summary>🎨 用图像模型生成</summary>
        ${field('立绘来源图片 URL（下载）', `ai.${i}.art.source`)}
        ${field('或：立绘生成提示词', `ai.${i}.art.prompt`, { type: 'textarea' })}
        ${field('参考图 URL（可选）', `ai.${i}.art.reference`)}
        ${field('胜利姿势描述', `ai.${i}.art.win`, { type: 'textarea', attrs: 'rows="2"' })}
        ${field('战败姿势描述', `ai.${i}.art.lose`, { type: 'textarea', attrs: 'rows="2"' })}
        <div class="sbtns">
          <button type="button" data-gen="portraits">生成 / 下载立绘</button>
          <button type="button" data-gen="poses">生成胜负姿势</button>
          <button type="button" data-gen="stickers">生成表情包</button>
          <label class="chk"><input type="checkbox" data-force> 覆盖已有</label>
        </div>
        ${job ? `<div class="job ${job.status}">${job.status === 'running' ? '<span class="thinking-dots">生成中</span>' : job.status === 'done' ? '✓ 完成' : '✗ 失败'} · ${esc(job.stage)}${job.last ? ` · ${esc(job.last)}` : ''}</div>` : ''}
        <small>生成前请先保存（生成脚本读取已保存的配置）。每张图约 20–40 秒。</small>
      </details>
    </div>`
        : ''
    }
  </div>`;
}

function aiTab() {
  return `<div class="aitop"><b>${draft.ai.length}</b> 个 AI（最多 ${maxAi}）<button type="button" id="addAi" ${draft.ai.length >= maxAi ? 'disabled' : ''}>＋ 添加 AI</button></div>
    ${draft.ai.map(aiCard).join('')}`;
}

function stickerTab() {
  const entries = Object.entries(draft.stickers ?? {});
  return `<p class="snote">这里定义表情的中文名、emoji 和生成提示词。每个角色的实际表情图放在 <code>public/characters/&lt;key&gt;/stickers/&lt;id&gt;.png</code>，AI 只会用它自己有的表情。</p>
    <table class="stable"><tr><th>id（文件名）</th><th>名字</th><th>emoji</th><th>生成提示词（英文效果更好）</th><th></th></tr>
    ${entries
      .map(
        ([id]) => `<tr>
        <td><code>${esc(id)}</code></td>
        <td>${field('', `stickers.${id}.label`)}</td>
        <td>${field('', `stickers.${id}.emoji`, { attrs: 'class="emo" maxlength="4"' })}</td>
        <td>${field('', `stickers.${id}.prompt`)}</td>
        <td><button type="button" class="danger" data-delsticker="${esc(id)}">✕</button></td></tr>`,
      )
      .join('')}
    </table>
    <div class="sbtns"><input id="newStickerId" placeholder="新表情 id，如 wink"><button type="button" id="addSticker">＋ 添加</button></div>`;
}

function llmTab() {
  return `<div class="sgrid">
    ${field('接口地址（OpenAI Responses 兼容）', 'llm.baseUrl', { attrs: 'placeholder="http://127.0.0.1:4141/v1"' })}
    ${field('API Key', 'llm.apiKey', { type: 'password', attrs: `placeholder="${hasApiKey ? '已设置，留空不修改' : '留空则用环境变量 LOCAL_API_KEY'}"` })}
    ${field('单次超时（毫秒）', 'llm.timeoutMs', { type: 'number' })}
    ${field('最大输出 token', 'llm.maxOutputTokens', { type: 'number' })}
    ${field('图像模型（生成立绘 / 表情）', 'imageModel', { list: 'modelList' })}
  </div>
  <div class="sbtns"><button type="button" id="testLlm">测试连接 / 刷新模型列表</button> <span id="llmResult" class="muted">${models.length ? `可用模型 ${models.length} 个` : ''}</span></div>`;
}

// ---------------------------------------------------------------- render
function render() {
  const body = $('setBody');
  document.querySelectorAll('#setTabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === tab));
  body.innerHTML = { game: gameTab, ai: aiTab, stickers: stickerTab, llm: llmTab }[tab]();
  $('modelList').innerHTML = models.map((m) => `<option value="${esc(m)}">`).join('');
  body.querySelectorAll('[data-bind]').forEach((el) => {
    el.addEventListener(el.type === 'checkbox' || el.tagName === 'SELECT' ? 'change' : 'input', () => {
      const t = el.dataset.type;
      const v = t === 'bool' ? el.checked : t === 'number' ? (el.value === '' ? '' : Number(el.value)) : el.value;
      set(draft, el.dataset.bind, v);
      if (/^ai\.\d+\.name$/.test(el.dataset.bind)) {
        const i = Number(el.dataset.bind.split('.')[1]);
        if (draft.ai[i]._new) draft.ai[i].key = slug(v, i);
      }
      status('有未保存的修改');
    });
  });
  $('blindLevelsText')?.addEventListener('input', (e) => {
    const levels = e.target.value
      .split(/[,，\s]+/)
      .map((x) => x.split('/').map(Number))
      .filter(([s, b]) => s > 0 && b > 0);
    if (levels.length) draft.blindLevels = levels;
    else delete draft.blindLevels;
    status('有未保存的修改');
  });
  bindActions(body);
}

function bindActions(body) {
  body.querySelectorAll('.aicard').forEach((card) => {
    const i = Number(card.dataset.i);
    const a = draft.ai[i];
    card.querySelector('[data-toggle]')?.addEventListener('click', () => {
      open = open === i ? null : i;
      render();
    });
    card.querySelectorAll('[data-move]').forEach((b) =>
      b.addEventListener('click', () => {
        const j = i + Number(b.dataset.move);
        [draft.ai[i], draft.ai[j]] = [draft.ai[j], draft.ai[i]];
        if (open === i) open = j;
        status('有未保存的修改');
        render();
      }),
    );
    card.querySelector('[data-remove]')?.addEventListener('click', () => {
      if (!confirm(`移除 ${a.name}？（美术文件不会删除）`)) return;
      draft.ai.splice(i, 1);
      open = null;
      status('有未保存的修改');
      render();
    });
    card.querySelectorAll('[data-up]').forEach((b) => b.addEventListener('click', () => pickAndUpload(a.key, b.dataset.up)));
    card.querySelectorAll('[data-del]').forEach((b) =>
      b.addEventListener('click', async () => {
        if (!confirm('删除这张图？')) return;
        await artOp('/api/art/delete', { key: a.key, slot: b.dataset.del });
      }),
    );
    card.querySelectorAll('[data-delstk]').forEach((b) =>
      b.addEventListener('click', async () => {
        if (!confirm(`删除表情 ${b.dataset.delstk}？`)) return;
        await artOp('/api/art/delete', { key: a.key, slot: 'sticker', id: b.dataset.delstk });
      }),
    );
    card.querySelector('[data-upstk]')?.addEventListener('click', () => {
      const ids = Object.keys(draft.stickers ?? {});
      const id = prompt(`表情 id（文件名，可用中文）。已定义：${ids.join('、') || '无'}`, ids.find((x) => !(art[a.key]?.stickers ?? []).some((s) => s.id === x)) ?? '');
      if (id) pickAndUpload(a.key, 'sticker', id.trim());
    });
    card.querySelectorAll('[data-gen]').forEach((b) =>
      b.addEventListener('click', async () => {
        if (a._new) return status('先保存，再生成', true);
        const force = card.querySelector('[data-force]')?.checked;
        const r = await api('/api/art/generate', { key: a.key, stage: b.dataset.gen, force });
        if (!r.ok) return status(r.error, true);
        jobs[a.key] = { id: r.job, stage: b.dataset.gen, status: 'running' };
        render();
        pollJobs();
      }),
    );
  });
  $('addAi')?.addEventListener('click', () => {
    const i = draft.ai.length;
    draft.ai.push({ _new: true, key: `ai${i + 1}`, name: `AI ${i + 1}`, model: models[0] ?? '', avatar: '🤖', color: '#58a6ff', title: '', persona: '成年人，……', art: {} });
    open = i;
    status('有未保存的修改');
    render();
  });
  body.querySelectorAll('[data-delsticker]').forEach((b) =>
    b.addEventListener('click', () => {
      delete draft.stickers[b.dataset.delsticker];
      status('有未保存的修改');
      render();
    }),
  );
  $('addSticker')?.addEventListener('click', () => {
    const id = $('newStickerId').value.trim();
    if (!id) return;
    draft.stickers ??= {};
    draft.stickers[id] = { label: id, emoji: '', prompt: '' };
    status('有未保存的修改');
    render();
  });
  $('testLlm')?.addEventListener('click', async () => {
    $('llmResult').textContent = '连接中…';
    const r = await loadModels();
    $('llmResult').textContent = r.ok ? `可用模型 ${models.length} 个（已填入下拉提示）` : `失败：${r.error}`;
  });
}

let polling = null;
function pollJobs() {
  if (polling) return;
  polling = setInterval(async () => {
    const r = await api('/api/art/jobs');
    let running = false;
    for (const j of r.jobs ?? []) {
      const mine = jobs[j.key];
      if (!mine || mine.id !== j.id) continue;
      mine.status = j.status;
      mine.last = j.log.at(-1);
      if (j.status === 'running') running = true;
    }
    if (!running) {
      clearInterval(polling);
      polling = null;
      await refreshArt();
    }
    if (tab === 'ai') render();
  }, 2000);
}

async function refreshArt() {
  const r = await api('/api/config');
  if (r.ok) art = r.art;
}

async function artOp(url, body) {
  const r = await api(url, body);
  if (!r.ok) return status(r.error, true);
  art = r.art;
  render();
}

function pickAndUpload(key, slot, id) {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/png,image/jpeg,image/webp,image/gif';
  input.onchange = async () => {
    const file = input.files[0];
    if (!file) return;
    status('上传中…');
    const q = new URLSearchParams({ key, slot, ...(id ? { id } : {}) });
    const r = await fetch(`/api/art/upload?${q}`, { method: 'POST', headers: { 'content-type': file.type }, body: file }).then((x) => x.json());
    if (!r.ok) return status(r.error, true);
    art = r.art;
    status('已上传');
    render();
  };
  input.click();
}

async function loadModels() {
  const r = await api('/api/models');
  if (r.ok) models = r.models;
  return r;
}

async function save(andNewGame) {
  const payload = structuredClone(draft);
  for (const a of payload.ai) delete a._new;
  status('保存中…');
  const r = await api('/api/config', { config: payload });
  if (!r.ok) return status(r.error, true);
  for (const a of draft.ai) delete a._new;
  await refreshArt();
  if (andNewGame) {
    await api('/api/new-game', {});
    await api('/api/next', {});
    close();
    return;
  }
  status(r.needsNewGame ? '已保存。名单 / 模型 / 盲注的改动要在新的一局生效。' : '已保存，从下一手起生效。');
  render();
}

function close() {
  $('settingsModal').classList.add('hidden');
}

export async function openSettings(startTab, openIndex) {
  if (startTab) tab = startTab;
  if (openIndex != null && openIndex !== '') open = Number(openIndex);
  const r = await api('/api/config');
  if (!r.ok) return alert(r.error ?? '读取配置失败');
  draft = r.config;
  draft.stickers ??= {};
  for (const a of draft.ai) a.art ??= {};
  art = r.art;
  hasApiKey = r.hasApiKey;
  maxAi = r.maxAi;
  $('settingsModal').classList.remove('hidden');
  status(r.file === 'config.example.json' ? '当前使用默认配置，保存后会写入 config.json' : '');
  render();
  if (!models.length) loadModels().then(() => render());
}

export function initSettings() {
  $('setTabs').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-tab]');
    if (!b) return;
    tab = b.dataset.tab;
    render();
  });
  $('setCancel').onclick = close;
  $('setSave').onclick = () => save(false);
  $('setSaveNew').onclick = () => {
    if (confirm('保存并重新开始？当前牌局会结束，所有人筹码重置。')) save(true);
  };
  $('settingsModal').addEventListener('click', (e) => {
    if (e.target.id === 'settingsModal') close();
  });
}
