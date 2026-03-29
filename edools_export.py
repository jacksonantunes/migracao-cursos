import requests
import json
import time
import sys

# ==============================
# CONFIGURAÇÃO
# ==============================

BASE_URL = 'https://core.myedools.com/api'

TOKEN = '...'

HEADERS = {
    'Authorization': f'Token token="{TOKEN}"',
    'Accept': 'application/vnd.edools.core.v1+json'
}

DELAY = 0.5        # segundos entre requisições
PER_PAGE = 50      # ajustado para o limite real da API
MAX_PAGES = None   # None = sem limite; 1 = modo teste
MAX_RETRIES = 5    # tentativas em caso de erro 5xx
RETRY_WAIT = 10    # espera inicial entre tentativas (dobra a cada retry)


# ==============================
# FUNÇÕES DE REQUISIÇÃO
# ==============================

def _request_with_retry(url, params=None):
    """GET com retry/backoff para erros 5xx."""
    response = None
    for attempt in range(1, MAX_RETRIES + 1):
        response = requests.get(url, headers=HEADERS, params=params)
        if response.status_code == 200:
            return response
        if response.status_code >= 500:
            wait = RETRY_WAIT * (2 ** (attempt - 1))
            print(f'   ⚠️  Erro {response.status_code} (tentativa {attempt}/{MAX_RETRIES}), aguardando {wait}s...')
            time.sleep(wait)
        else:
            break
    return response


def _extract_list_and_total(data):
    """
    Extrai a lista de itens e o total_count do envelope JSON da API.
    Retorna (lista, total_count_ou_None).
    """
    total = None

    if not isinstance(data, dict):
        return data if isinstance(data, list) else [], total

    # total_count vem em várias chaves dependendo do endpoint
    for key in ('total_count', 'total', 'count', 'meta'):
        if key in data:
            val = data[key]
            if isinstance(val, int):
                total = val
            elif isinstance(val, dict):
                total = val.get('total_count') or val.get('total')
            break

    # extrai a lista pelo nome do recurso ou chaves genéricas
    resource_keys = ('course_contents', 'lessons', 'course_modules', 'courses', 'data', 'items')
    for key in resource_keys:
        if key in data and isinstance(data[key], list):
            return data[key], total

    # fallback: primeira lista encontrada
    for value in data.values():
        if isinstance(value, list):
            return value, total

    return [], total


def get_total(endpoint, params=None):
    """
    Faz uma única requisição (page=1, per_page=1) para descobrir o total de itens.
    Retorna o total ou None se a API não informar.
    """
    query = params.copy() if params else {}
    query['page'] = 1
    query['per_page'] = 1

    response = _request_with_retry(f'{BASE_URL}{endpoint}', params=query)
    if response is None or response.status_code != 200:
        return None

    try:
        data = response.json()
    except Exception:
        return None

    _, total = _extract_list_and_total(data)
    return total


def get_all(endpoint, params=None, label=None):
    """Busca todos os itens de um endpoint paginado com barra de progresso."""
    results = []
    page = 1
    seen_ids = set()
    total_known = None
    stable_pages = 0   # páginas consecutivas com IDs duplicados (detecção de loop real)

    while True:
        if MAX_PAGES is not None and page > MAX_PAGES:
            print('🛑 Limite de páginas atingido (modo teste)')
            break

        query = params.copy() if params else {}
        query['page'] = page
        query['per_page'] = PER_PAGE

        # monta linha de progresso
        if total_known:
            pct = min(100, int(len(results) / total_known * 100))
            prog = f' [{len(results)}/{total_known} — {pct}%]'
        else:
            prog = f' [{len(results)} coletados]'
        prefix = f'({label}) ' if label else ''
        print(f'🔎 {prefix}Buscando {endpoint} pág {page}...{prog}', end='\r', flush=True)

        response = _request_with_retry(f'{BASE_URL}{endpoint}', params=query)

        if response is None or response.status_code != 200:
            print()
            desc = 'endpoint não existe' if response.status_code == 404 else f'após {MAX_RETRIES} tentativas'
            print(f'❌ Erro {response.status_code} {desc}: {response.text[:120]}')
            break

        try:
            raw = response.json()
        except Exception as e:
            print()
            print(f'❌ Erro ao parsear JSON: {e}')
            break

        items, total_from_response = _extract_list_and_total(raw)

        # captura total_count na primeira página
        if page == 1 and total_from_response is not None:
            total_known = total_from_response

        if not isinstance(items, list):
            print()
            print('❌ Resposta inesperada:', items)
            break

        if not items:
            print()
            print('✅ Fim da paginação')
            break

        novos = 0
        duplicados = 0
        for item in items:
            if not isinstance(item, dict):
                continue
            item_id = item.get('id')
            if item_id not in seen_ids:
                seen_ids.add(item_id)
                results.append(item)
                novos += 1
            else:
                duplicados += 1

        # loop real = API retornando IDs que já foram vistos
        if duplicados > 0:
            stable_pages += 1
        else:
            stable_pages = 0

        if stable_pages >= 3:
            print()
            print(f'⚠️  ALERTA: {stable_pages} páginas consecutivas com IDs duplicados ({duplicados} nesta página) — possível loop na paginação.')
            print('   Verifique se a API está paginando corretamente.')

        if novos == 0:
            print()
            print('🛑 Paginação encerrada (sem novos itens)')
            break

        page += 1
        time.sleep(DELAY)

    if total_known:
        print(f'✅ {endpoint}: {len(results)} de {total_known} itens coletados')
    else:
        print(f'✅ {endpoint}: {len(results)} itens coletados')

    return results


def get_one(endpoint):
    """Busca um único recurso."""
    response = _request_with_retry(f'{BASE_URL}{endpoint}')
    if response is None or response.status_code != 200:
        print(f'\n   ⚠️  Não foi possível buscar detalhe {endpoint}: {response.status_code}')
        return None
    data = response.json()
    if isinstance(data, dict) and len(data) == 1:
        inner = next(iter(data.values()))
        if isinstance(inner, dict):
            return inner
    return data


# ==============================
# PRÉ-VOO — TOTAIS ANTES DE EXPORTAR
# ==============================

def inspect_api(course):
    """
    Mostra campos brutos de: módulo, aula e conteúdo.
    Use: python edools_export.py --inspect <course_id>
    Ajuda a descobrir quais filtros a API realmente aceita.
    """
    cid = course.get('id')
    print(f'\n🔬 INSPEÇÃO DA API — Curso {cid}: {course.get("name")}\n')

    # 1. Campos do módulo
    modules_raw = _request_with_retry(f'{BASE_URL}/courses/{cid}/course_modules', params={'page': 1, 'per_page': 1})
    if modules_raw and modules_raw.status_code == 200:
        raw = modules_raw.json()
        print('── Envelope de /course_modules (chaves de topo):')
        print(f'   {list(raw.keys()) if isinstance(raw, dict) else type(raw).__name__}')
        items, total = _extract_list_and_total(raw)
        print(f'   total_count detectado: {total}')
        if items:
            print(f'\n── Campos do módulo (1º item):')
            for k, v in items[0].items():
                preview = str(v)[:80] if not isinstance(v, (dict, list)) else f'({type(v).__name__})'
                print(f'   {k}: {preview}')
            first_module_id = items[0].get('id')
        else:
            first_module_id = None
    else:
        first_module_id = None
        print('❌ Não foi possível buscar módulos')

    # 2. Campos de uma aula — testa filtros possíveis
    print(f'\n── Testando filtros em /lessons:')
    filtros = [
        {'course_id': cid},
        {'course_module_id': first_module_id} if first_module_id else None,
        {'module_id': first_module_id} if first_module_id else None,
    ]
    for f in filtros:
        if not f:
            continue
        r = _request_with_retry(f'{BASE_URL}/lessons', params={**f, 'page': 1, 'per_page': 1})
        if r and r.status_code == 200:
            raw = r.json()
            items, total = _extract_list_and_total(raw)
            print(f'   filtro {f} → total_count={total}, itens retornados={len(items)}')
            if items and f == list(filtros)[0]:  # mostra campos só na primeira resposta
                print(f'\n── Campos da aula (1º item):')
                for k, v in items[0].items():
                    preview = str(v)[:80] if not isinstance(v, (dict, list)) else f'({type(v).__name__})'
                    print(f'   {k}: {preview}')
        else:
            status = r.status_code if r else '?'
            print(f'   filtro {f} → HTTP {status}')

    # 3. Detalhe de um módulo individual
    if first_module_id:
        r = _request_with_retry(f'{BASE_URL}/course_modules/{first_module_id}')
        if r and r.status_code == 200:
            raw = r.json()
            data = raw
            if isinstance(raw, dict) and len(raw) == 1:
                data = next(iter(raw.values()))
            print(f'\n── Campos do detalhe GET /course_modules/{first_module_id}:')
            if isinstance(data, dict):
                for k, v in data.items():
                    preview = str(v)[:80] if not isinstance(v, (dict, list)) else f'({type(v).__name__}, len={len(v)})'
                    print(f'   {k}: {preview}')


def get_module_with_content_ids(module_id):
    """
    Busca o detalhe de um módulo para obter course_content_ids.
    O objeto da lista não inclui os IDs — apenas o detalhe individual inclui.
    """
    detail = get_one(f'/course_modules/{module_id}')
    return detail or {}


def preflight(courses):
    print('\n' + '='*55)
    print('📊 PRÉ-VOO — Verificando totais antes de exportar...')
    print('='*55)

    total_modules = 0
    total_contents = 0

    for course in courses:
        cid   = course.get('id')
        cname = course.get('name', f'ID {cid}')

        modules = get_all(f'/courses/{cid}/course_modules', label=f'preflight-{cid}')
        n_modules = len(modules)

        # Conta conteúdos somando course_content_ids de cada módulo
        n_contents = 0
        for module in modules:
            detail = get_module_with_content_ids(module.get('id'))
            ids = detail.get('course_content_ids') or []
            n_contents += len(ids)
            time.sleep(DELAY)

        total_modules  += n_modules
        total_contents += n_contents

        print(f'  📚 {cname[:50]}')
        print(f'     Módulos: {n_modules}  |  Conteúdos agendados: {n_contents}')

    print('='*55)
    print(f'  TOTAL  →  Módulos: {total_modules}  |  Conteúdos agendados: {total_contents}')
    print('='*55)

    resposta = input('\n▶ Iniciar exportação completa? (s/n): ').strip().lower()
    return resposta == 's'


# ==============================
# CONTEÚDOS DE AULA
# ==============================

def get_contents_for_lesson(lesson_id, label=None):
    """
    Busca conteúdos de uma aula com detalhe individual por conteúdo.
    """
    contents = []

    # lesson_id é o filtro confiável para conteúdos
    contents = get_all('/course_contents', {'lesson_id': lesson_id}, label=label)

    full_contents = []
    for c in contents:
        cid = c.get('id')
        detail = get_one(f'/course_contents/{cid}') if cid else None
        merged = {**c, **(detail or {})}
        full_contents.append(merged)
        time.sleep(DELAY)

    return full_contents


def log_content_summary(content, content_idx, content_total):
    flags = []
    if content.get('body') or content.get('content'):
        flags.append('📝texto')
    if content.get('video_url') or content.get('video_embed') or content.get('embed_code'):
        flags.append('🎥vídeo')
    if content.get('file_url') or content.get('attachment_url') or content.get('file'):
        flags.append('📎arquivo')
    if content.get('url') or content.get('external_url'):
        flags.append('🔗link')
    if not flags:
        flags.append('⚠️ sem mídia')

    ctype = content.get('content_type') or '?'
    pos   = content.get('position', '?')
    cid   = content.get('id', '?')
    print(f'            [{content_idx}/{content_total}] pos:{pos} id:{cid} type:{ctype} → {", ".join(flags)}')


# ==============================
# EXTRAÇÃO COMPLETA
# ==============================

def exportar(courses):
    estrutura = []
    total_courses = len(courses)

    for ci, course in enumerate(courses, 1):
        cid = course.get('id')
        cname = course.get('name', f'ID {cid}')
        print(f'\n{"="*55}')
        print(f'📚 Curso {ci}/{total_courses}: {cname} (ID: {cid})')
        print('='*55)

        course_data = {'course': course, 'modules': []}

        modules = get_all(f'/courses/{cid}/course_modules', label=f'C{ci}')

        # Pré-conta total de conteúdos somando course_content_ids de cada módulo
        total_contents_course = 0
        module_content_ids = {}
        for m in modules:
            detail = get_module_with_content_ids(m.get('id'))
            ids = detail.get('course_content_ids') or []
            module_content_ids[m.get('id')] = ids
            total_contents_course += len(ids)
            time.sleep(DELAY)
        print(f'   📄 Total de conteúdos agendados no curso: {total_contents_course}')

        content_counter = 0

        for mi, module in enumerate(modules, 1):
            mid = module.get('id')
            mname = module.get('name', f'ID {mid}')
            content_ids = module_content_ids.get(mid, [])
            print(f'\n  📦 Módulo {mi}/{len(modules)}: {mname} ({len(content_ids)} conteúdo(s))')

            module_data = {'module': module, 'contents': []}

            for li, content_id in enumerate(content_ids, 1):
                content_counter += 1
                pct = int(content_counter / total_contents_course * 100) if total_contents_course else 0

                # Busca detalhe completo do conteúdo agendado
                content = get_one(f'/course_contents/{content_id}')
                if not content:
                    print(f'\n    ⚠️  [{content_counter}/{total_contents_course}] Conteúdo {content_id} não encontrado')
                    continue

                cname_c = content.get('title') or content.get('name') or f'ID {content_id}'
                print(f'\n    📄 [{content_counter}/{total_contents_course} — {pct}%] {cname_c} (ID: {content_id})')
                log_content_summary(content, li, len(content_ids))

                module_data['contents'].append(content)
                time.sleep(DELAY)

            course_data['modules'].append(module_data)

        estrutura.append(course_data)

    return estrutura


# ==============================
# SELEÇÃO DE CURSOS
# ==============================

def listar_cursos(courses):
    print('\n' + '='*65)
    print(f'  {"ID":<10} {"NOME":<45} {"SLUG"}')
    print('='*65)
    for c in courses:
        cid   = str(c.get('id', '?'))
        name  = (c.get('name') or '')[:44]
        slug  = (c.get('slug') or c.get('permalink') or '')[:20]
        print(f'  {cid:<10} {name:<45} {slug}')
    print('='*65)


def buscar_curso_por_id(cid):
    """Busca um único curso diretamente pelo ID, sem carregar a lista completa."""
    response = _request_with_retry(f'{BASE_URL}/courses/{cid}')
    if response is None or response.status_code != 200:
        return None
    data = response.json()
    # desembrulha envelope {"course": {...}} se necessário
    if isinstance(data, dict) and 'course' in data:
        return data['course']
    return data if isinstance(data, dict) else None


def selecionar_cursos():
    """
    Resolve quais cursos exportar:
      - IDs via argumento  → busca cada curso diretamente (sem listar tudo)
      - 'todos' via argumento → busca lista completa
      - Sem argumento       → busca lista completa e exibe para escolha interativa
    """
    # ── IDs passados via linha de comando ────────────────────────────
    if len(sys.argv) > 1:
        ids_arg = sys.argv[1:]

        if ids_arg == ['todos']:
            print('🔎 Buscando lista completa de cursos...')
            return get_all('/courses')

        # busca cada curso individualmente — sem baixar a lista inteira
        selecionados = []
        for cid in ids_arg:
            print(f'🔎 Buscando curso {cid}...')
            course = buscar_curso_por_id(cid)
            if course:
                print(f'   ✔ {course.get("name", f"ID {cid}")}')
                selecionados.append(course)
            else:
                print(f'   ⚠️  Curso {cid} não encontrado.')

        if not selecionados:
            print('Nenhum curso encontrado. Verifique os IDs.')
            sys.exit(1)

        return selecionados

    # ── Modo interativo ───────────────────────────────────────────────
    resposta_rapida = input('Digite o(s) ID(s) do curso (ou Enter para listar todos): ').strip()

    if resposta_rapida:
        selecionados = []
        for cid in resposta_rapida.split():
            print(f'🔎 Buscando curso {cid}...')
            course = buscar_curso_por_id(cid)
            if course:
                print(f'   ✔ {course.get("name", f"ID {cid}")}')
                selecionados.append(course)
            else:
                print(f'   ⚠️  Curso {cid} não encontrado.')
        if not selecionados:
            print('Nenhum curso encontrado. Verifique os IDs.')
            sys.exit(1)
        return selecionados

    print('🔎 Buscando lista de cursos...')
    all_courses = get_all('/courses')

    if not all_courses:
        print('Nenhum curso encontrado. Verifique o token.')
        sys.exit(1)

    listar_cursos(all_courses)
    print('\nDigite os IDs dos cursos separados por espaço, ou "todos" para exportar tudo.')
    resposta = input('▶ IDs (ou "todos"): ').strip()

    if resposta.lower() == 'todos':
        return all_courses

    ids = set(resposta.split())
    selecionados = [c for c in all_courses if str(c.get('id')) in ids]
    nao_encontrados = ids - {str(c.get('id')) for c in selecionados}

    if nao_encontrados:
        print(f'⚠️  IDs não encontrados: {", ".join(nao_encontrados)}')

    if not selecionados:
        print('Nenhum curso selecionado.')
        sys.exit(0)

    return selecionados


def salvar(dados, courses_selecionados):
    if len(courses_selecionados) == 1:
        cid = courses_selecionados[0].get('id')
        filename = f'edools_curso_{cid}.json'
    else:
        filename = 'edools_export.json'

    with open(filename, 'w', encoding='utf-8') as f:
        json.dump(dados, f, ensure_ascii=False, indent=2)

    return filename


# ==============================
# EXECUÇÃO
# ==============================

if __name__ == '__main__':
    print('🚀 Edools Export\n')

    # Modo diagnóstico: python edools_export.py --inspect <course_id>
    if len(sys.argv) == 3 and sys.argv[1] == '--inspect':
        course = buscar_curso_por_id(sys.argv[2])
        if not course:
            print(f'Curso {sys.argv[2]} não encontrado.')
            sys.exit(1)
        inspect_api(course)
        sys.exit(0)

    courses = selecionar_cursos()
    print(f'\n✔ {len(courses)} curso(s) selecionado(s): {", ".join(str(c["id"]) for c in courses)}')

    if not preflight(courses):
        print('Exportação cancelada.')
        sys.exit(0)

    dados = exportar(courses)

    filename = salvar(dados, courses)

    total_modules  = sum(len(c['modules']) for c in dados)
    total_contents = sum(len(m['contents']) for c in dados for m in c['modules'])

    print('\n' + '='*55)
    print('✅ Exportação finalizada!')
    print(f'   📚 Cursos:              {len(dados)}')
    print(f'   📦 Módulos:             {total_modules}')
    print(f'   📄 Conteúdos agendados: {total_contents}')
    print(f'📁 Arquivo: {filename}')
    print('='*55)
