import sys
from typing import List

from .edools import exportar_curso
from .memberkit import importar_dados


def executar_exportacao(
    curso_ids: List[int],
    config: dict,
    jobs: dict,
    job_id: str,
):
    """Export-only: fetches courses from Edools and stores JSON, no MemberKit import."""
    original_stdout = sys.stdout
    sys.stdout = _JobLogger(jobs, job_id)

    try:
        for course_id in curso_ids:
            cid = str(course_id)
            jobs[job_id]['cursos'][cid] = 'processando'

            try:
                dados = exportar_curso(course_id, config)
                if not dados:
                    jobs[job_id]['cursos'][cid] = 'erro'
                    jobs[job_id]['erros'][cid] = f'Curso {course_id} não encontrado na Edools'
                    jobs[job_id]['logs'].append(f'❌ Curso {course_id} não encontrado na Edools')
                    continue

                jobs[job_id]['dados'][cid] = dados
                jobs[job_id]['cursos'][cid] = 'concluido'

            except Exception as exc:
                msg = str(exc)
                jobs[job_id]['cursos'][cid] = 'erro'
                jobs[job_id]['erros'][cid] = msg
                jobs[job_id]['logs'].append(f'❌ Erro ao exportar curso {course_id}: {msg}')

        total_ok  = sum(1 for v in jobs[job_id]['cursos'].values() if v == 'concluido')
        total_err = sum(1 for v in jobs[job_id]['cursos'].values() if v == 'erro')
        jobs[job_id]['status']    = 'done'
        jobs[job_id]['resultado'] = {'concluidos': total_ok, 'erros': total_err}

    except Exception as exc:
        jobs[job_id]['status'] = 'error'
        jobs[job_id]['logs'].append(f'❌ Erro fatal: {exc}')

    finally:
        sys.stdout = original_stdout


class _JobLogger:
    """Redirects stdout prints to the in-memory job log list."""

    def __init__(self, jobs: dict, job_id: str):
        self._jobs = jobs
        self._job_id = job_id

    def write(self, text: str):
        if text and text.strip():
            self._jobs[self._job_id]['logs'].append(text.strip())

    def flush(self):
        pass


def executar_migracao(
    curso_ids: List[int],
    config: dict,
    jobs: dict,
    job_id: str,
    mapping_file: str,
):
    """
    Sync function (runs in FastAPI's thread pool via BackgroundTasks).
    Exports each course from Edools and imports it into MemberKit,
    updating the jobs dict so the frontend can poll progress.
    """
    original_stdout = sys.stdout
    sys.stdout = _JobLogger(jobs, job_id)

    try:
        for course_id in curso_ids:
            cid = str(course_id)
            jobs[job_id]['cursos'][cid] = 'processando'

            try:
                # ── Exportar da Edools ────────────────────────────────────
                dados = exportar_curso(course_id, config)
                if not dados:
                    jobs[job_id]['cursos'][cid] = 'erro'
                    jobs[job_id]['erros'][cid] = f'Curso {course_id} não encontrado na Edools'
                    jobs[job_id]['logs'].append(f'❌ Curso {course_id} não encontrado na Edools')
                    continue

                # Armazena JSON exportado para download posterior
                jobs[job_id]['dados'][cid] = dados

                # ── Importar no MemberKit ─────────────────────────────────
                result = importar_dados(dados, config, mapping_file)

                # Valida se o curso foi realmente criado/encontrado no mapping
                edools_id = str(dados[0]['course'].get('id'))
                if not result or edools_id not in result.get('courses', {}):
                    raise RuntimeError(
                        'Curso não foi registrado no MemberKit — verifique a API Key e a URL'
                    )

                jobs[job_id]['cursos'][cid] = 'concluido'

            except Exception as exc:
                msg = str(exc)
                jobs[job_id]['cursos'][cid] = 'erro'
                jobs[job_id]['erros'][cid] = msg
                jobs[job_id]['logs'].append(f'❌ Erro no curso {course_id}: {msg}')

        total_ok  = sum(1 for v in jobs[job_id]['cursos'].values() if v == 'concluido')
        total_err = sum(1 for v in jobs[job_id]['cursos'].values() if v == 'erro')
        jobs[job_id]['status']    = 'done'
        jobs[job_id]['resultado'] = {'concluidos': total_ok, 'erros': total_err}

    except Exception as exc:
        jobs[job_id]['status'] = 'error'
        jobs[job_id]['logs'].append(f'❌ Erro fatal: {exc}')

    finally:
        sys.stdout = original_stdout
