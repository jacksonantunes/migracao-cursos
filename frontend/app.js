// ── Version check ─────────────────────────────────────────────────────────────
async function checkVersion() {
  let current, repo;
  try {
    const r = await fetch('/api/version');
    ({ version: current, repo } = await r.json());
  } catch { return; }

  // Exibe versão imediatamente, antes de checar o GitHub
  const badge = document.getElementById('version-badge');
  const dot   = document.getElementById('version-dot');
  const label = document.getElementById('version-label');
  label.textContent = `v${current}`;
  badge.classList.remove('hidden');
  badge.classList.add('flex');

  // Checa GitHub Releases em paralelo
  let latest = null;
  let releaseUrl = `https://github.com/${repo}/releases`;
  try {
    const r = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
      headers: { Accept: 'application/vnd.github+json' },
    });
    if (r.ok) {
      const data = await r.json();
      latest = data.tag_name?.replace(/^v/, '');
      if (data.html_url) releaseUrl = data.html_url;
    }
  } catch { /* offline ou sem releases */ }

  const upToDate = !latest || latest === current;
  badge.href = releaseUrl;

  if (upToDate) {
    badge.classList.add('border-green-200', 'bg-green-50', 'text-green-700');
    dot.classList.add('bg-green-500');
    label.textContent = `v${current} · Atualizado`;
  } else {
    badge.classList.add('border-orange-200', 'bg-orange-50', 'text-orange-700');
    dot.classList.add('bg-orange-500', 'animate-pulse');
    label.textContent = `v${current} → v${latest}`;
  }

  // Card na tela de configuração
  const card     = document.getElementById('version-card');
  const cardIcon = document.getElementById('version-card-icon');
  const cardText = document.getElementById('version-card-text');
  const cardLink = document.getElementById('version-card-link');

  card.classList.remove('hidden');
  if (upToDate) {
    card.classList.add('bg-green-50', 'border-green-200');
    cardIcon.textContent = '✅';
    cardText.textContent = `Versão ${current} — você está usando a versão mais recente.`;
  } else {
    card.classList.add('bg-orange-50', 'border-orange-200');
    cardIcon.textContent = '⬆️';
    cardText.innerHTML = `Versão <strong>${current}</strong> instalada — nova versão <strong>v${latest}</strong> disponível.`;
    cardLink.href = releaseUrl;
    cardLink.classList.remove('hidden');
    cardLink.classList.add('text-orange-600');
  }
}

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
function atualizarBtnConectar() {
  const id  = document.getElementById('curso-id-direto').value.trim();
  const btn = document.getElementById('btn-conectar');
  btn.textContent = id ? `Migrar curso #${id} →` : 'Conectar e Listar Cursos →';
}

async function conectar() {
  const token    = document.getElementById('edools-token').value.trim();
  const url      = document.getElementById('edools-url').value.trim();
  const key      = document.getElementById('mk-key').value.trim();
  const mkUrl    = document.getElementById('mk-url').value.trim();
  const cursoId  = document.getElementById('curso-id-direto').value.trim();

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

    if (cursoId) {
      migrarPorId(parseInt(cursoId));
    } else {
      showScreen('cursos');
      await carregarCursos();
    }
  } catch (e) {
    setError('config-error', `Erro: ${e.message}`);
  } finally {
    atualizarBtnConectar();
    btn.disabled = false;
  }
}

function migrarPorId(courseId) {
  pendingCourseIds = [courseId];
  _prepararTela([{ id: courseId, name: `Curso ID ${courseId}` }]);
  iniciarExportacaoAutomatica();
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
let exportJobId      = null; // job_id from auto-export (used for import-only)

function _prepararTela(cursos) {
  logCount        = 0;
  courseJobMap    = {};
  courseDataReady = {};
  currentJobId    = null;
  exportJobId     = null;
  document.getElementById('log-area').innerHTML = '';
  document.getElementById('resultado-card').classList.add('hidden');
  document.getElementById('btn-nova-migracao').classList.add('hidden');
  document.getElementById('btn-iniciar-migracao').classList.add('hidden');
  renderProgressoCursos(cursos);
  showScreen('progresso');
}

function iniciarMigracao() {
  const checks = [...document.querySelectorAll('.curso-check:checked')];
  const ids    = checks.map(c => parseInt(c.dataset.id));
  if (!ids.length) return;

  pendingCourseIds = ids;
  _prepararTela(checks.map(c => ({ id: parseInt(c.dataset.id), name: c.dataset.name })));
  iniciarExportacaoAutomatica();
}

async function iniciarExportacaoAutomatica() {
  document.getElementById('progresso-status').textContent = 'Buscando dados do Edools...';

  // Set all courses to "buscando"
  pendingCourseIds.forEach(id => {
    const icon  = document.getElementById(`icon-${id}`);
    const badge = document.getElementById(`badge-${id}`);
    if (icon)  icon.textContent  = '📥';
    if (badge) { badge.textContent = 'Buscando...'; badge.className = 'text-xs font-medium shrink-0 text-blue-500'; }
  });

  try {
    const res = await fetch('/api/exportar', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ curso_ids: pendingCourseIds }),
    });
    if (!res.ok) throw new Error((await res.json()).detail || await res.text());
    exportJobId = (await res.json()).job_id;

    await new Promise((resolve) => {
      const timer = setInterval(async () => {
        try {
          const r   = await fetch(`/api/status/${exportJobId}`);
          const job = await r.json();

          appendLogs(job.logs);

          for (const [cid, status] of Object.entries(job.cursos)) {
            const icon   = document.getElementById(`icon-${cid}`);
            const badge  = document.getElementById(`badge-${cid}`);
            const dlBtn  = document.getElementById(`dl-${cid}`);
            const viewBtn = document.getElementById(`view-${cid}`);

            if (status === 'processando') {
              if (icon)  icon.textContent  = '⚙️';
              if (badge) { badge.textContent = 'Exportando...'; badge.className = 'text-xs font-medium shrink-0 text-blue-500'; }
            } else if (status === 'concluido') {
              if (icon)  icon.textContent  = '📦';
              if (badge) { badge.textContent = 'Pronto para migrar'; badge.className = 'text-xs font-medium shrink-0 text-blue-600'; }
              if (dlBtn)  { dlBtn.classList.remove('hidden');  dlBtn.classList.add('flex'); }
              if (viewBtn){ viewBtn.classList.remove('hidden'); viewBtn.classList.add('flex'); }
              courseDataReady[parseInt(cid)] = exportJobId;
            } else if (status === 'erro') {
              if (icon)  icon.textContent  = '❌';
              if (badge) { badge.textContent = 'Erro na busca'; badge.className = 'text-xs font-medium shrink-0 text-red-500'; }
              const erroEl = document.getElementById(`erro-${cid}`);
              if (erroEl && (job.erros || {})[cid]) {
                erroEl.textContent = job.erros[cid];
                erroEl.classList.remove('hidden');
              }
            }
          }

          if (job.status === 'done' || job.status === 'error') {
            clearInterval(timer);
            resolve();
          }
        } catch (e) { console.warn('Export poll error:', e); }
      }, 1500);
    });

    const ok  = Object.values(jobs_exportados_local()).filter(v => v === 'concluido').length;
    const err = pendingCourseIds.length - ok;
    if (ok > 0) {
      document.getElementById('progresso-status').textContent =
        `${ok} curso${ok !== 1 ? 's' : ''} pronto${ok !== 1 ? 's' : ''} — clique em "Iniciar Migração" para importar no MemberKit.` +
        (err > 0 ? ` (${err} com erro)` : '');
      document.getElementById('btn-iniciar-migracao').classList.remove('hidden');
    } else {
      document.getElementById('progresso-status').textContent = 'Erro ao buscar dados — verifique as credenciais.';
    }

  } catch (e) {
    document.getElementById('progresso-status').textContent = `Erro ao buscar dados: ${e.message}`;
    document.getElementById('btn-iniciar-migracao').classList.remove('hidden');
  }
}

function jobs_exportados_local() {
  // Helper: returns the cursos map from the current export job (already polled)
  return Object.fromEntries(
    pendingCourseIds.map(id => [String(id), courseDataReady[id] ? 'concluido' : 'erro'])
  );
}

async function executarMigracao() {
  if (!pendingCourseIds.length) return;

  const btn = document.getElementById('btn-iniciar-migracao');
  btn.textContent = '⏳ Iniciando...';
  btn.disabled = true;
  document.getElementById('progresso-status').textContent = 'Importando no MemberKit...';

  // Only migrate courses that were successfully exported
  const idsMigrar = exportJobId
    ? pendingCourseIds.filter(id => courseDataReady[id] === exportJobId)
    : pendingCourseIds;

  try {
    let res;
    if (exportJobId && idsMigrar.length) {
      res = await fetch('/api/importar', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ export_job_id: exportJobId, curso_ids: idsMigrar }),
      });
    } else {
      res = await fetch('/api/migrar', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ curso_ids: idsMigrar }),
      });
    }
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
      <span id="badge-${c.id}" class="text-xs text-gray-400 font-medium shrink-0">Aguardando</span>
      <div class="flex gap-1 shrink-0">
        <button onclick="migrarCursoUnico(${c.id}, '${escHtml(c.name)}')"
          id="btn-migrar-${c.id}" title="Re-migrar"
          class="w-7 h-7 flex items-center justify-center text-sm bg-blue-50 hover:bg-blue-100 text-blue-600 border border-blue-200 rounded-lg transition-colors">
          🔄
        </button>
        <button onclick="handleDownload(${c.id})"
          id="dl-${c.id}" title="Baixar JSON"
          class="hidden w-7 h-7 items-center justify-center text-sm bg-gray-50 hover:bg-gray-100 text-gray-600 border border-gray-200 rounded-lg transition-colors">
          ⬇
        </button>
        <button onclick="handleView(${c.id})"
          id="view-${c.id}" title="Visualizar dados"
          class="hidden w-7 h-7 items-center justify-center text-sm bg-purple-50 hover:bg-purple-100 text-purple-600 border border-purple-200 rounded-lg transition-colors">
          👁
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

// ── Visualizar curso (modal) ──────────────────────────────────────────────────
async function handleView(courseId) {
  const jobId = courseDataReady[courseId];
  if (jobId) {
    await fetchAndShowModal(jobId, courseId);
    return;
  }
  await exportarEVisualizar(courseId);
}

async function exportarEVisualizar(courseId) {
  const btn = document.getElementById(`view-${courseId}`);
  if (btn) { btn.dataset.orig = btn.textContent; btn.textContent = '⏳'; btn.disabled = true; }

  try {
    const res = await fetch('/api/exportar', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ curso_ids: [courseId] }),
    });
    if (!res.ok) throw new Error((await res.json()).detail || await res.text());
    const { job_id } = await res.json();

    await new Promise((resolve, reject) => {
      const timer = setInterval(async () => {
        try {
          const r   = await fetch(`/api/status/${job_id}`);
          const job = await r.json();
          if (job.status === 'done' || job.status === 'error') {
            clearInterval(timer);
            const cid = String(courseId);
            if ((job.dados || {})[cid]) { courseDataReady[courseId] = job_id; resolve(); }
            else reject(new Error((job.erros || {})[cid] || 'Falha ao exportar'));
          }
        } catch (e) { clearInterval(timer); reject(e); }
      }, 1500);
    });

    await fetchAndShowModal(courseDataReady[courseId], courseId);
  } catch (e) {
    alert(`Erro ao carregar dados: ${e.message}`);
  } finally {
    if (btn) { btn.textContent = btn.dataset.orig || '👁 Ver'; btn.disabled = false; }
  }
}

async function fetchAndShowModal(jobId, courseId) {
  try {
    const res = await fetch(`/api/download/${jobId}/${courseId}`);
    if (!res.ok) throw new Error('Dados não disponíveis');
    const dados = await res.json();
    renderModal(dados);
    document.getElementById('modal-overlay').classList.remove('hidden');
    document.getElementById('modal-body').scrollTop = 0;
  } catch (e) {
    alert(`Erro ao abrir visualização: ${e.message}`);
  }
}

function renderModal(dados) {
  if (!dados?.length) return;
  const cd      = dados[0];
  const course  = cd.course  || {};
  const modules = cd.modules || [];

  const totalContents = modules.reduce((acc, m) => acc + (m.contents || []).length, 0);

  document.getElementById('modal-title').textContent = course.name || `Curso ID ${course.id}`;
  document.getElementById('modal-subtitle').textContent =
    `ID: ${course.id} · ${modules.length} módulo${modules.length !== 1 ? 's' : ''} · ${totalContents} conteúdo${totalContents !== 1 ? 's' : ''}`;

  const body = document.getElementById('modal-body');
  body.innerHTML = '';

  if (!modules.length) {
    body.innerHTML = '<p class="text-gray-400 text-sm text-center py-8">Nenhum módulo encontrado.</p>';
    return;
  }

  modules.forEach((m, mi) => {
    const mod      = m.module   || {};
    const contents = m.contents || [];
    const num      = String(mi + 1).padStart(2, '0');

    const section = document.createElement('div');
    section.className = 'border border-gray-100 rounded-xl overflow-hidden';

    // ── Cabeçalho do módulo (clicável) ────────────────────────────────
    const header = document.createElement('div');
    header.className = 'flex items-center gap-3 px-4 py-3 bg-gray-50 hover:bg-gray-100 cursor-pointer select-none transition-colors';
    header.innerHTML = `
      <span class="text-xs font-mono text-gray-300 shrink-0 w-5">${num}</span>
      <span class="text-xl shrink-0">📦</span>
      <span class="flex-1 text-sm font-semibold text-gray-700 truncate">${escHtml(mod.name || `Módulo ${mi + 1}`)}</span>
      <span class="text-xs text-gray-400 shrink-0">${contents.length} item${contents.length !== 1 ? 's' : ''}</span>
      <span class="text-gray-400 text-xs shrink-0 ml-1 toggle-chevron">▼</span>
    `;

    // ── Lista de conteúdos ────────────────────────────────────────────
    const list = document.createElement('div');
    list.className = 'divide-y divide-gray-50';

    contents.forEach((c, ci) => {
      const title      = c.title || c.name || `Conteúdo ${ci + 1}`;
      const flags      = getContentFlags(c);
      const ctype      = c.content_type ? `<span class="text-xs text-gray-300 font-mono shrink-0">${escHtml(c.content_type)}</span>` : '';
      const detailHtml = buildContentDetail(c);
      const hasDetail  = detailHtml.length > 0;

      const item = document.createElement('div');
      item.className = 'border-b border-gray-50 last:border-0';

      const rowHeader = document.createElement('div');
      rowHeader.className = 'flex items-center gap-3 px-4 py-2.5' + (hasDetail ? ' cursor-pointer hover:bg-gray-50 transition-colors' : '');
      rowHeader.innerHTML = `
        <span class="text-xs font-mono text-gray-200 shrink-0 w-5 text-right">${ci + 1}</span>
        <span class="flex-1 text-sm text-gray-600 truncate" title="${escHtml(title)}">${escHtml(title)}</span>
        ${ctype}
        <div class="flex gap-0.5 shrink-0">${flags.map(f => `<span class="text-sm" title="${f.label}">${f.icon}</span>`).join('')}</div>
        ${hasDetail ? '<span class="text-gray-300 text-xs shrink-0 ml-1 content-chevron">▶</span>' : ''}
      `;

      item.appendChild(rowHeader);

      if (hasDetail) {
        const detail = document.createElement('div');
        detail.className = 'hidden bg-gray-50 px-4 pb-3 pt-2 space-y-2.5 border-t border-gray-100';
        detail.innerHTML = detailHtml;
        item.appendChild(detail);

        rowHeader.addEventListener('click', () => {
          const open    = !detail.classList.contains('hidden');
          const chevron = rowHeader.querySelector('.content-chevron');
          detail.classList.toggle('hidden', open);
          if (chevron) chevron.textContent = open ? '▶' : '▼';
        });
      }

      list.appendChild(item);
    });

    // Toggle accordion
    header.addEventListener('click', () => {
      const chevron = header.querySelector('.toggle-chevron');
      const open    = !list.classList.contains('hidden');
      list.classList.toggle('hidden', open);
      chevron.textContent = open ? '▶' : '▼';
    });

    section.appendChild(header);
    section.appendChild(list);
    body.appendChild(section);
  });
}

function stripHtml(html) {
  const div = document.createElement('div');
  div.innerHTML = html;
  return (div.textContent || div.innerText || '').replace(/\s+/g, ' ').trim();
}

function buildContentDetail(c) {
  const parts = [];

  // Texto
  const bodyRaw = c.body || c.content;
  if (bodyRaw) {
    const plain   = stripHtml(bodyRaw);
    const preview = plain.length > 500 ? plain.slice(0, 500) + '…' : plain;
    if (preview) parts.push(`
      <div>
        <span class="text-xs font-semibold text-gray-400 uppercase tracking-wide">📝 Texto</span>
        <p class="text-xs text-gray-500 mt-1 leading-relaxed whitespace-pre-wrap">${escHtml(preview)}</p>
      </div>`);
  }

  // Vídeo URL direta
  const videoUrl = c.video_url;
  if (videoUrl) parts.push(`
    <div>
      <span class="text-xs font-semibold text-gray-400 uppercase tracking-wide">🎥 Vídeo</span>
      <a href="${videoUrl}" target="_blank" rel="noopener"
        class="block text-xs text-blue-500 hover:underline mt-1 truncate">${escHtml(videoUrl)}</a>
    </div>`);

  // Embed
  const embedRaw = c.video_embed || c.embed_code;
  if (embedRaw && !videoUrl) {
    const srcMatch = embedRaw.match(/src=["']([^"']+)["']/i);
    const embedUrl = srcMatch ? srcMatch[1] : null;
    parts.push(`
      <div>
        <span class="text-xs font-semibold text-gray-400 uppercase tracking-wide">🎥 Embed</span>
        ${embedUrl
          ? `<a href="${embedUrl}" target="_blank" rel="noopener" class="block text-xs text-blue-500 hover:underline mt-1 truncate">${escHtml(embedUrl)}</a>`
          : `<span class="block text-xs text-gray-400 mt-1 font-mono bg-white rounded px-2 py-1 border border-gray-100 truncate">${escHtml(embedRaw.slice(0, 120))}${embedRaw.length > 120 ? '…' : ''}</span>`
        }
      </div>`);
  }

  // Arquivo
  const fileUrl = c.file_url || c.attachment_url || (typeof c.file === 'string' ? c.file : null);
  if (fileUrl) {
    const fname = decodeURIComponent(fileUrl.split('/').pop().split('?')[0]) || 'Arquivo';
    parts.push(`
      <div>
        <span class="text-xs font-semibold text-gray-400 uppercase tracking-wide">📎 Arquivo</span>
        <a href="${fileUrl}" target="_blank" rel="noopener"
          class="block text-xs text-blue-500 hover:underline mt-1 truncate">${escHtml(fname)}</a>
      </div>`);
  }

  // Link externo
  const linkUrl = c.url || c.external_url;
  if (linkUrl) parts.push(`
    <div>
      <span class="text-xs font-semibold text-gray-400 uppercase tracking-wide">🔗 Link</span>
      <a href="${linkUrl}" target="_blank" rel="noopener"
        class="block text-xs text-blue-500 hover:underline mt-1 truncate">${escHtml(linkUrl)}</a>
    </div>`);

  return parts.join('');
}

function getContentFlags(c) {
  const flags = [];
  if (c.body || c.content)                                   flags.push({ icon: '📝', label: 'Texto' });
  if (c.video_url || c.video_embed || c.embed_code)          flags.push({ icon: '🎥', label: 'Vídeo' });
  if (c.file_url  || c.attachment_url || c.file)             flags.push({ icon: '📎', label: 'Arquivo' });
  if (c.url       || c.external_url)                         flags.push({ icon: '🔗', label: 'Link' });
  if (!flags.length)                                         flags.push({ icon: '⚪', label: 'Sem mídia detectada' });
  return flags;
}

function closeModal() {
  document.getElementById('modal-overlay').classList.add('hidden');
}

function handleModalClick(e) {
  if (e.target === document.getElementById('modal-overlay')) closeModal();
}

// Fechar modal com ESC
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') closeModal();
});

// ── Init ──────────────────────────────────────────────────────────────────────
checkVersion();
