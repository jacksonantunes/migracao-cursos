import json
import os
import re
import sys
import uuid
from typing import List

from fastapi import BackgroundTasks, FastAPI, HTTPException, Request
from fastapi.responses import Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from starlette.middleware.base import BaseHTTPMiddleware

# ── Paths ─────────────────────────────────────────────────────────────────────
_BACKEND_DIR  = os.path.dirname(os.path.abspath(__file__))
_PROJECT_ROOT = os.path.dirname(_BACKEND_DIR)
_FRONTEND_DIR = os.path.join(_PROJECT_ROOT, 'frontend')
MAPPING_FILE  = os.path.join(_PROJECT_ROOT, 'memberkit_mapping.json')

if _BACKEND_DIR not in sys.path:
    sys.path.insert(0, _BACKEND_DIR)

from services.migration import executar_exportacao, executar_migracao  # noqa: E402

# ── Version ───────────────────────────────────────────────────────────────────
VERSION = '1.0.3'
GITHUB_REPO = 'jacksonantunes/migracao-cursos'

# ── In-memory state ───────────────────────────────────────────────────────────
app_config: dict = {}   # credentials (never written to disk)
jobs:       dict = {}   # migration jobs
busca_jobs: dict = {}   # course-search jobs

# ── App ───────────────────────────────────────────────────────────────────────
app = FastAPI(title='Migração Edools → MemberKit')


class _NoCacheMiddleware(BaseHTTPMiddleware):
    """Prevents browsers from caching HTML and JS so deploys take effect immediately."""
    async def dispatch(self, request: Request, call_next):
        response = await call_next(request)
        path = request.url.path
        if path.endswith(('.html', '.js')) or path in ('/', ''):
            response.headers['Cache-Control'] = 'no-store, no-cache, must-revalidate'
            response.headers['Pragma'] = 'no-cache'
        return response

app.add_middleware(_NoCacheMiddleware)


# ── Pydantic models ───────────────────────────────────────────────────────────
class ConfigPayload(BaseModel):
    edools_token: str
    edools_url:   str
    mk_key:       str
    mk_url:       str


class MigrarPayload(BaseModel):
    curso_ids: List[int]


# ── Course-search background task ─────────────────────────────────────────────

class _BuscaLogger:
    """Captures stdout from get_all() and parses progress."""
    def __init__(self, job: dict):
        self._job = job

    def write(self, text: str):
        if not text or not text.strip():
            return
        line = text.strip()
        self._job['logs'].append(line)

        # "✅ /courses: N itens coletados"
        m = re.search(r'(\d+) (?:de \d+ )?itens coletados', line)
        if m:
            self._job['coletados'] = int(m.group(1))

        # "[Y/Z — P%]" (known total)
        m2 = re.search(r'\[(\d+)/(\d+)', line)
        if m2:
            self._job['coletados'] = int(m2.group(1))
            self._job['total']     = int(m2.group(2))

        # "[Y coletados]" (unknown total)
        m3 = re.search(r'\[(\d+) coletados\]', line)
        if m3:
            self._job['coletados'] = int(m3.group(1))

    def flush(self):
        pass


def _executar_busca(job_id: str, config: dict):
    original  = sys.stdout
    sys.stdout = _BuscaLogger(busca_jobs[job_id])
    try:
        from services.edools import listar_cursos

        cursos = listar_cursos(config)

        migrated: set = set()
        if os.path.exists(MAPPING_FILE):
            try:
                with open(MAPPING_FILE, encoding='utf-8') as f:
                    mapping = json.load(f)
                migrated = set(mapping.get('courses', {}).keys())
            except Exception:
                pass

        busca_jobs[job_id]['cursos'] = [
            {
                'id':     c.get('id'),
                'name':   c.get('name', '?'),
                'migrado': str(c.get('id')) in migrated,
            }
            for c in cursos
        ]
        busca_jobs[job_id]['coletados'] = len(cursos)
        busca_jobs[job_id]['status']    = 'done'

    except Exception as exc:
        busca_jobs[job_id]['status'] = 'error'
        busca_jobs[job_id]['logs'].append(f'❌ {exc}')
    finally:
        sys.stdout = original


# ── API endpoints ─────────────────────────────────────────────────────────────

@app.post('/api/config')
def salvar_config(body: ConfigPayload):
    app_config.update(body.model_dump())
    return {'ok': True}


@app.post('/api/buscar-cursos')
def buscar_cursos(background_tasks: BackgroundTasks):
    """Start a background course-search job and return its job_id."""
    if not app_config:
        raise HTTPException(400, 'Configure as credenciais primeiro')

    job_id = str(uuid.uuid4())[:8]
    busca_jobs[job_id] = {
        'status':    'running',
        'cursos':    [],
        'logs':      [],
        'coletados': 0,
        'total':     None,
    }
    background_tasks.add_task(_executar_busca, job_id, dict(app_config))
    return {'job_id': job_id}


@app.get('/api/buscar-status/{job_id}')
def buscar_status(job_id: str):
    job = busca_jobs.get(job_id)
    if not job:
        raise HTTPException(404, 'Job de busca não encontrado')
    return job


@app.post('/api/migrar')
def iniciar_migracao(body: MigrarPayload, background_tasks: BackgroundTasks):
    if not app_config:
        raise HTTPException(400, 'Configure as credenciais primeiro')

    job_id = str(uuid.uuid4())[:8]
    jobs[job_id] = {
        'status':    'running',
        'logs':      [],
        'cursos':    {str(cid): 'aguardando' for cid in body.curso_ids},
        'erros':     {},
        'dados':     {},
        'resultado': None,
    }
    background_tasks.add_task(
        executar_migracao,
        body.curso_ids,
        dict(app_config),
        jobs,
        job_id,
        MAPPING_FILE,
    )
    return {'job_id': job_id}


@app.get('/api/status/{job_id}')
def status(job_id: str):
    job = jobs.get(job_id)
    if not job:
        raise HTTPException(404, 'Job não encontrado')
    return job


@app.get('/api/download/{job_id}/{course_id}')
def download_curso(job_id: str, course_id: str):
    job = jobs.get(job_id)
    if not job:
        raise HTTPException(404, 'Job não encontrado')
    dados = job.get('dados', {}).get(course_id)
    if not dados:
        raise HTTPException(404, 'Dados não disponíveis — exporte o curso primeiro')

    course_name = dados[0]['course'].get('name', f'curso_{course_id}')
    safe_name   = re.sub(r'[^\w\s-]', '', course_name).strip().replace(' ', '_')
    filename    = f'edools_{safe_name}_{course_id}.json'

    return Response(
        content=json.dumps(dados, ensure_ascii=False, indent=2),
        media_type='application/json',
        headers={'Content-Disposition': f'attachment; filename="{filename}"'},
    )


@app.get('/api/version')
def get_version():
    return {'version': VERSION, 'repo': GITHUB_REPO}


@app.post('/api/exportar')
def exportar_cursos(body: MigrarPayload, background_tasks: BackgroundTasks):
    """Export courses from Edools only (no MemberKit import)."""
    if not app_config:
        raise HTTPException(400, 'Configure as credenciais primeiro')

    job_id = str(uuid.uuid4())[:8]
    jobs[job_id] = {
        'status':    'running',
        'logs':      [],
        'cursos':    {str(cid): 'aguardando' for cid in body.curso_ids},
        'erros':     {},
        'dados':     {},
        'resultado': None,
    }
    background_tasks.add_task(
        executar_exportacao,
        body.curso_ids,
        dict(app_config),
        jobs,
        job_id,
    )
    return {'job_id': job_id}


# ── Health check ─────────────────────────────────────────────────────────────
@app.get('/health')
def health():
    return {'status': 'ok'}


# ── Frontend ──────────────────────────────────────────────────────────────────
app.mount('/', StaticFiles(directory=_FRONTEND_DIR, html=True), name='frontend')
