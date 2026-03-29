// ── State ─────────────────────────────────────────────────────────────────────
let currentJobId    = null;  // active migration job
let pollingInterval = null;  // migration poll timer
let buscarInterval  = null;  // course-search poll timer
let allCourses      = [];
let logCount        = 0;
let courseJobMap    = {};    // courseId → mini job_id (single-course re-migrations)
let courseDataReady = {};    // courseId → jobId where export data is available

// ── Helpers ───────────────────────────────────────────────────────────────────
function showScreen(name) {
  ['config', 'cursos', 'progresso'].forEach(s =>
    document.getElementById(`screen-${s}`).classList.add('hidden')
  );
  document.getElementById(`screen-${name}`).classList.remove('hidden');
}

function setError(id, msg) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = msg;
  el.classList.toggle('hidden', !msg);
}

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ── Tela 1 — Configuração ─────────────────────────────────────────────────────
async function conectar() {
  const token = document.getElementById('edools-token').value.trim();
  const url   = document.getElementById('edools-url').value.trim();
  const key   = document.getElementById('mk-key').value.trim();
  const mkUrl = document.getElementById('mk-url').value.trim();

  if (!token || !url || !key || !mkUrl) {
    setError('config-error', 'Preencha todos os campos antes de continuar.');
    return;
  }
  setError('config-error', '');

  const btn = document.getElementById('btn-conectar');
  btn.textContent = 'Conectando...';
  btn.disabled = true;

  try {
    const res = await fetch('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ edools_token: token, edools_url: url, mk_key: key, mk_url: mkUrl }),
    });
    if (!res.ok) throw new Error((await res.json()).detail || await res.text());

    showScreen('cursos');
    await carregarCursos();
  } catch (e) {
    setError('config-error', `Erro: ${e.message}`);
  } finally {
    btn.textContent = 'Conectar e Listar Cursos →';
    btn.disabled = false;
  }
}

function voltarConfig() {
  clearInterval(buscarInterval);
  buscarInterval = null;
  showScreen('config');
}

// ── Tela 2 — Busca com progresso ─────────────────────────────────────────────
async function carregarCursos() {
  // Reset UI
  document.getElementById('cursos-loading').classList.remove('hidden');
  document.getElementById('cursos-content').classList.add('hidden');
  document.getElementById('cursos-summary').textContent = '';
  document.getElementById('course-filter').value = '';
  document.getElementById('busca-bar').style.width = '0%';
  document.getElementById('busca-count').textContent = '';
  document.getElementById('busca-label').textContent = 'Iniciando...';
  document.getElementById('busca-log').textContent = '';

  // Start background search
  let jobId;
  try {
    const res = await fetch('/api/buscar-cursos', { method: 'POST' });
    if (!res.ok) throw new Error((await res.json()).detail || await res.text());
    jobId = (await res.json()).job_id;
  } catch (e) {
    document.getElementById('cursos-summary').textContent = `Erro: ${e.message}`;
    document.getElementById('cursos-loading').classList.add('hidden');
    document.getElementById('cursos-content').classList.remove('hidden');
    return;
  }

  // Poll search progress
  clearInterval(buscarInterval);
  buscarInterval = setInterval(async () => {
    try {
      const r = await fetch(`/api/buscar-status/${jobId}`);
      if (!r.ok) return;
      const job = await r.json();

      // Update progress bar
      const coletados = job.coletados || 0;
      const total     = job.total || null;
      const pct       = total ? Math.min(100, Math.round(coletados / total * 100)) : 0;

      document.getElementById('busca-bar').style.width = total ? `${pct}%` : '100%';
      document.getElementById('busca-bar').classList.toggle('animate-pulse', !total);
      document.getElementById('busca-count').textContent =
        total ? `${coletados} / ${total}` : `${coletados} encontrado${coletados !== 1 ? 's' : ''}`;
      document.getElementById('busca-label').textContent =
        job.status === 'running' ? 'Buscando páginas...' : 'Concluído';

      // Last log line
      if (job.logs && job.logs.length) {
        const last = job.logs[job.logs.length - 1];
        document.getElementById('busca-log').textContent = last.replace(/[\r\n]/g, ' ');
      }

      if (job.status === 'done' || job.status === 'error') {
        clearInterval(buscarInterval);
        buscarInterval = null;

        if (job.status === 'error') {
          document.getElementById('cursos-summary').textContent =
            'Erro ao buscar cursos — verifique as credenciais.';
          document.getElementById('cursos-loading').classList.add('hidden');
          document.getElementById('cursos-content').classList.remove('hidden');
          return;
        }

        allCourses = job.cursos;
        renderCursos(allCourses);
        document.getElementById('cursos-loading').classList.add('hidden');
        document.getElementById('cursos-content').classList.remove('hidden');
      }
    } catch (e) {
      console.warn('Busca poll error:', e);
    }
  }, 800);
}

function filtrarCursos(termo) {
  const t = termo.toLowerCase().trim();
  renderCursos(t ? allCourses.filter(c => c.name.toLowerCase().includes(t)) : allCourses);
}

function renderCursos(cursos) {
  const list = document.getElementById('cursos-list');
  list.innerHTML = '';

  if (!cursos.length) {
    list.innerHTML = '<p class="text-center text-gray-400 text-sm py-8">Nenhum curso encontrado.</p>';
    updateCount();
    return;
  }

  cursos.forEach(c => {
    const row = document.createElement('label');
    row.className = 'flex items-center px-4 py-3 hover:bg-gray-50 cursor-pointer gap-3';
    row.innerHTML = `
      <input type="checkbox" class="curso-check w-4 h-4 rounded border-gray-300 accent-blue-600"
        data-id="${c.id}" data-name="${escHtml(c.name)}"
        ${c.migrado ? 'checked' : ''} onchange="updateCount()">
      <span class="flex-1 text-sm font-medium text-gray-700">${escHtml(c.name)}</span>
      <span class="text-xs text-gray-300 mr-1">ID: ${c.id}</span>
      ${c.migrado
        ? '<span class="text-xs bg-green-50 text-green-600 border border-green-200 px-2 py-0.5 rounded-full whitespace-nowrap">✓ Já migrado</span>'
        : ''}
    `;
    list.appendChild(row);
  });

  const total    = allCourses.length;
  const migrados = allCourses.filter(c => c.migrado).length;
  const visiveis = cursos.length;
  document.getElementById('cursos-summary').textContent =
    `${total} curso(s)` +
    (migrados ? ` · ${migrados} já migrado(s)` : '') +
    (visiveis < total ? ` · ${visiveis} exibido(s)` : '');

  updateCount();
}

function updateCount() {
  const all     = document.querySelectorAll('.curso-check');
  const checked = document.querySelectorAll('.curso-check:checked');
  const n = checked.length;
  document.getElementById('selected-count').textContent = `${n} selecionado(s)`;
  document.getElementById('btn-migrar').disabled = n === 0;
  const sa = document.getElementById('select-all');
  sa.indeterminate = n > 0 && n < all.length;
  sa.checked = all.length > 0 && n === all.length;
}

function toggleAll(el) {
  document.querySelectorAll('.curso-check').forEach(c => { c.checked = el.checked; });
  updateCount();
}

/** Selects all visible courses (no auto-start). */
function selecionarTodos() {
  document.querySelectorAll('.curso-check').forEach(c => { c.checked = true; });
  updateCount();
}

/** Selects all visible courses and goes to progress screen (no auto-start). */
function migrarTodosSelecionados() {
  selecionarTodos();
  iniciarMigracao();
}

// ── Tela 3 — Progresso ───────────────────────────────────────────────────────
let pendingCourseIds = [];  // IDs waiting to be migrated

function iniciarMigracao() {
  const checks = [...document.querySelectorAll('.curso-check:checked')];
  const ids    = checks.map(c => parseInt(c.dataset.id));
  if (!ids.length) return;

  pendingCourseIds = ids;
  const selectedCourses = checks.map(c => ({ id: parseInt(c.dataset.id), name: c.dataset.name }));

  // Prepare screen without starting
  logCount = 0;
  courseJobMap = {};
  courseDataReady = {};
  currentJobId = null;
  document.getElementById('log-area').innerHTML = '';
  document.getElementById('resultado-card').classList.add('hidden');
  document.getElementById('btn-nova-migracao').classList.add('hidden');
  document.getElementById('btn-iniciar-migracao').classList.remove('hidden');
  renderProgressoCursos(selectedCourses);
  showScreen('progresso');
  document.getElementById('progresso-status').textContent = 'Pronto — clique em "Iniciar Migração" para começar.';
}

async function executarMigracao() {
  if (!pendingCourseIds.length) return;

  const btn = document.getElementById('btn-iniciar-migracao');
  btn.textContent = '⏳ Iniciando...';
  btn.disabled = true;

  document.getElementById('progresso-status').textContent = 'Iniciando migração...';

  try {
    const res = await fetch('/api/migrar', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ curso_ids: pendingCourseIds }),
    });
    if (!res.ok) throw new Error((await res.json()).detail || await res.text());
    currentJobId = (await res.json()).job_id;
  } catch (e) {
    document.getElementById('progresso-status').textContent = `Erro ao iniciar: ${e.message}`;
    btn.textContent = '▶ Iniciar Migração';
    btn.disabled = false;
    return;
  }

  btn.classList.add('hidden');
  pollingInterval = setInterval(pollStatus, 2000);
  pollStatus();
}

function renderProgressoCursos(cursos) {
  const lista = document.getElementById('progresso-lista');
  lista.innerHTML = '';
  cursos.forEach(c => {
    const row = document.createElement('div');
    row.id    = `row-${c.id}`;
    row.className = 'flex items-center px-4 py-3 gap-3';
    row.innerHTML = `
      <span id="icon-${c.id}" class="text-lg w-6 text-center shrink-0">⏳</span>
      <div class="flex-1 min-w-0">
        <span class="block text-sm font-medium text-gray-700 truncate">${escHtml(c.name)}</span>
        <span id="erro-${c.id}" class="text-xs text-red-500 hidden block"></span>
      </div>
      <span class="text-xs text-gray-300 shrink-0">ID: ${c.id}</span>
      <span id="badge-${c.id}" class="text-xs text-gray-400 font-medium min-w-[90px] text-right shrink-0">Aguardando</span>
      <div class="flex gap-1.5 shrink-0 ml-1">
        <button onclick="migrarCursoUnico(${c.id}, '${escHtml(c.name)}')"
          id="btn-migrar-${c.id}"
          class="text-xs bg-blue-50 hover:bg-blue-100 text-blue-600 border border-blue-200 px-2.5 py-1 rounded-lg transition-colors whitespace-nowrap">
          🔄 Migrar
        </button>
        <button onclick="handleDownload(${c.id})"
          id="dl-${c.id}"
          class="text-xs bg-gray-50 hover:bg-gray-100 text-gray-600 border border-gray-200 px-2.5 py-1 rounded-lg transition-colors whitespace-nowrap">
          ⬇ JSON
        </button>
      </div>
    `;
    lista.appendChild(row);
  });
}

async function pollStatus() {
  if (!currentJobId) return;
  try {
    const res = await fetch(`/api/status/${currentJobId}`);
    if (!res.ok) return;
    const job = await res.json();

    updateProgressoCursos(job.cursos, job.erros || {}, job.dados || {});
    appendLogs(job.logs);

    if (job.status === 'done' || job.status === 'error') {
      clearInterval(pollingInterval);
      pollingInterval = null;
      mostrarResultado(job);
    } else {
      const done  = Object.values(job.cursos).filter(v => v === 'concluido' || v === 'erro').length;
      const total = Object.keys(job.cursos).length;
      document.getElementById('progresso-status').textContent =
        `Migrando... (${done}/${total} processado${done !== 1 ? 's' : ''})`;
    }
  } catch (e) { console.warn('Poll error:', e); }
}

const STATUS_MAP = {
  aguardando:  { icon: '⏳', label: 'Aguardando',     cls: 'text-gray-400' },
  processando: { icon: '⚙️',  label: 'Processando...', cls: 'text-blue-500' },
  concluido:   { icon: '✅', label: 'Concluído',       cls: 'text-green-600' },
  erro:        { icon: '❌', label: 'Erro',             cls: 'text-red-500'  },
};

function updateProgressoCursos(cursos, erros, dados) {
  for (const [cid, status] of Object.entries(cursos)) {
    const icon   = document.getElementById(`icon-${cid}`);
    const badge  = document.getElementById(`badge-${cid}`);
    const erroEl = document.getElementById(`erro-${cid}`);
    const dlBtn  = document.getElementById(`dl-${cid}`);
    if (!icon) continue;

    const s = STATUS_MAP[status] || { icon: '❓', label: status, cls: 'text-gray-400' };
    icon.textContent  = s.icon;
    badge.textContent = s.label;
    badge.className   = `text-xs font-medium min-w-[90px] text-right shrink-0 ${s.cls}`;

    if (status === 'erro' && erros[cid] && erroEl) {
      erroEl.textContent = erros[cid];
      erroEl.classList.remove('hidden');
    } else if (status !== 'erro' && erroEl) {
      erroEl.classList.add('hidden');
    }

    // Track data availability for direct download
    if (dados[cid] && !courseDataReady[cid]) {
      courseDataReady[cid] = currentJobId;
    }
  }
}

// ── Migrar curso individual ───────────────────────────────────────────────────
async function migrarCursoUnico(courseId, courseName) {
  const btn = document.getElementById(`btn-migrar-${courseId}`);
  if (btn) { btn.textContent = '⏳'; btn.disabled = true; }

  // Reset row UI
  const icon  = document.getElementById(`icon-${courseId}`);
  const badge = document.getElementById(`badge-${courseId}`);
  const erroEl = document.getElementById(`erro-${courseId}`);
  if (icon)  icon.textContent  = '⚙️';
  if (badge) { badge.textContent = 'Processando...'; badge.className = 'text-xs font-medium min-w-[90px] text-right shrink-0 text-blue-500'; }
  if (erroEl) erroEl.classList.add('hidden');

  try {
    const res = await fetch('/api/migrar', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ curso_ids: [courseId] }),
    });
    if (!res.ok) throw new Error((await res.json()).detail || await res.text());
    const { job_id } = await res.json();
    courseJobMap[courseId] = job_id;

    // Poll until done
    const timer = setInterval(async () => {
      try {
        const r   = await fetch(`/api/status/${job_id}`);
        const job = await r.json();
        const cid = String(courseId);

        appendLogs(job.logs.slice(logCount >= 0 ? 0 : 0)); // append new logs
        // We append ALL logs from this sub-job to the shared log
        if (job.logs.length) {
          const area = document.getElementById('log-area');
          const lastJobLogs = job.logs;
          // Only append lines we haven't seen for this sub-job
          const seen = parseInt(btn.dataset.logCount || '0');
          lastJobLogs.slice(seen).forEach(line => {
            const div = document.createElement('div');
            div.textContent = line;
            if (line.startsWith('❌')) div.classList.add('text-red-400');
            area.appendChild(div);
            area.scrollTop = area.scrollHeight;
          });
          btn.dataset.logCount = lastJobLogs.length;
        }

        if (job.status === 'done' || job.status === 'error') {
          clearInterval(timer);

          const status = job.cursos[cid];
          const s = STATUS_MAP[status] || { icon: '❓', label: status, cls: 'text-gray-400' };
          if (icon)  icon.textContent  = s.icon;
          if (badge) { badge.textContent = s.label; badge.className = `text-xs font-medium min-w-[90px] text-right shrink-0 ${s.cls}`; }

          if (status === 'erro' && erroEl) {
            erroEl.textContent = (job.erros || {})[cid] || 'Erro desconhecido';
            erroEl.classList.remove('hidden');
          }

          if ((job.dados || {})[cid]) {
            courseDataReady[courseId] = job_id;
          }

          if (btn) { btn.textContent = '🔄 Migrar'; btn.disabled = false; btn.dataset.logCount = '0'; }
        }
      } catch (e) { console.warn('Sub-poll error:', e); }
    }, 1500);

  } catch (e) {
    if (icon)  icon.textContent  = '❌';
    if (badge) { badge.textContent = 'Erro'; badge.className = 'text-xs font-medium min-w-[90px] text-right shrink-0 text-red-500'; }
    if (erroEl) { erroEl.textContent = e.message; erroEl.classList.remove('hidden'); }
    if (btn)  { btn.textContent = '🔄 Migrar'; btn.disabled = false; }
  }
}

// ── Download ──────────────────────────────────────────────────────────────────
function handleDownload(courseId) {
  const jobId = courseDataReady[courseId];
  if (jobId) {
    triggerDownload(`/api/download/${jobId}/${courseId}`);
    return;
  }
  // Data not available yet — export from Edools first
  exportarEBaixar(courseId);
}

async function exportarEBaixar(courseId) {
  const dlBtn = document.getElementById(`dl-${courseId}`);
  if (dlBtn) { dlBtn.textContent = '⏳'; dlBtn.disabled = true; }

  try {
    const res = await fetch('/api/exportar', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ curso_ids: [courseId] }),
    });
    if (!res.ok) throw new Error((await res.json()).detail || await res.text());
    const { job_id } = await res.json();

    // Poll until done
    await new Promise((resolve, reject) => {
      const timer = setInterval(async () => {
        try {
          const r   = await fetch(`/api/status/${job_id}`);
          const job = await r.json();
          if (job.status === 'done' || job.status === 'error') {
            clearInterval(timer);
            const cid = String(courseId);
            if ((job.dados || {})[cid]) {
              courseDataReady[courseId] = job_id;
              resolve(job_id);
            } else {
              reject(new Error((job.erros || {})[cid] || 'Falha ao exportar'));
            }
          }
        } catch (e) { clearInterval(timer); reject(e); }
      }, 1500);
    });

    triggerDownload(`/api/download/${courseDataReady[courseId]}/${courseId}`);
  } catch (e) {
    alert(`Erro ao exportar: ${e.message}`);
  } finally {
    if (dlBtn) { dlBtn.textContent = '⬇ JSON'; dlBtn.disabled = false; }
  }
}

function downloadFromJob(jobId, courseId) {
  triggerDownload(`/api/download/${jobId}/${courseId}`);
}

function triggerDownload(url) {
  const a = document.createElement('a');
  a.href = url;
  a.click();
}

// ── Log ───────────────────────────────────────────────────────────────────────
function appendLogs(logs) {
  const area     = document.getElementById('log-area');
  const newLines = logs.slice(logCount);
  const atBottom = area.scrollHeight - area.scrollTop <= area.clientHeight + 20;

  newLines.forEach(line => {
    const div = document.createElement('div');
    div.textContent = line;
    if (line.startsWith('❌')) div.classList.add('text-red-400');
    area.appendChild(div);
  });
  logCount = logs.length;
  if (atBottom) area.scrollTop = area.scrollHeight;
}

function scrollLog() {
  const area = document.getElementById('log-area');
  area.scrollTop = area.scrollHeight;
}

// ── Resultado ─────────────────────────────────────────────────────────────────
function mostrarResultado(job) {
  const { concluidos = 0, erros = 0 } = job.resultado || {};
  document.getElementById('progresso-status').textContent =
    erros > 0 ? '⚠️ Migração concluída com erros' : '✅ Migração concluída com sucesso!';
  document.getElementById('btn-iniciar-migracao').classList.add('hidden');
  document.getElementById('btn-nova-migracao').classList.remove('hidden');

  document.getElementById('resultado-content').innerHTML = `
    <div class="flex gap-10">
      <div class="text-center">
        <div class="text-3xl font-bold text-green-600">${concluidos}</div>
        <div class="text-sm text-gray-500 mt-1">migrado${concluidos !== 1 ? 's' : ''} com sucesso</div>
      </div>
      ${erros > 0 ? `
      <div class="text-center">
        <div class="text-3xl font-bold text-red-500">${erros}</div>
        <div class="text-sm text-gray-500 mt-1">com erro</div>
      </div>` : ''}
    </div>
    ${erros > 0 ? '<p class="text-xs text-gray-400 mt-4">Verifique as mensagens de erro em cada curso acima e no log.</p>' : ''}
  `;
  document.getElementById('resultado-card').classList.remove('hidden');
}

function novaMigracao() {
  clearInterval(pollingInterval);
  pollingInterval = null;
  currentJobId    = null;
  showScreen('cursos');
  carregarCursos();
}
