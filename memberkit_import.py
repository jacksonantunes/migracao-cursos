import requests
import json
import time
import sys
import os
import re

# ==============================
# CONFIGURAÇÃO
# ==============================

MEMBERKIT_API_KEY = 'SUA_API_KEY_AQUI'
MEMBERKIT_BASE    = 'https://memberkit.com.br/api/v1'

DELAY      = 0.6   # ~100 req/min (limite: 120/min)
DRY_RUN    = False  # True = simula sem criar nada
MAPPING_FILE = 'memberkit_mapping.json'  # salva IDs criados para retomar

MK_HEADERS = {
    'Content-Type': 'application/json',
    'Accept':       'application/json',
}


# ==============================
# MAPEAMENTO DE VÍDEOS
# ==============================

def detectar_video(content):
    """
    Tenta extrair source e uid de vídeo a partir dos campos do course_content.
    MemberKit aceita: youtube, vimeo, panda_video
    """
    # campos possíveis com URL de vídeo
    url = (
        content.get('video_url') or
        content.get('video_embed') or
        content.get('embed_code') or
        content.get('url') or
        ''
    )

    if not url:
        # tenta extrair de embed HTML
        for field in ('body', 'content', 'embed_code'):
            val = content.get(field) or ''
            if 'youtube' in val or 'vimeo' in val or 'pandavideo' in val:
                url = val
                break

    if not url:
        return None

    # YouTube
    yt = re.search(r'(?:youtube\.com/watch\?v=|youtu\.be/|youtube\.com/embed/)([A-Za-z0-9_-]{11})', url)
    if yt:
        return {'source': 'youtube', 'uid': yt.group(1)}

    # Vimeo
    vi = re.search(r'vimeo\.com/(?:video/)?(\d+)', url)
    if vi:
        return {'source': 'vimeo', 'uid': vi.group(1)}

    # Panda Video
    pv = re.search(r'pandavideo\.com\.br/(?:embed/)?([A-Za-z0-9_-]+)', url)
    if pv:
        return {'source': 'panda_video', 'uid': pv.group(1)}

    return None


def extrair_texto(content):
    """Retorna o conteúdo de texto/HTML da aula."""
    return (
        content.get('body') or
        content.get('content') or
        content.get('description') or
        ''
    )


# ==============================
# CLIENTE MEMBERKIT
# ==============================

def mk_get(endpoint, params=None):
    params = params or {}
    params['api_key'] = MEMBERKIT_API_KEY
    r = requests.get(f'{MEMBERKIT_BASE}{endpoint}', headers=MK_HEADERS, params=params)
    return r


def mk_post(endpoint, payload):
    if DRY_RUN:
        print(f'   [DRY-RUN] POST {endpoint}: {json.dumps(payload)[:120]}')
        return {'id': f'dry_{endpoint.strip("/")}', '_dry': True}

    params = {'api_key': MEMBERKIT_API_KEY}
    r = requests.post(
        f'{MEMBERKIT_BASE}{endpoint}',
        headers=MK_HEADERS,
        params=params,
        json=payload
    )
    time.sleep(DELAY)

    if r.status_code in (200, 201):
        return r.json()

    print(f'   ❌ POST {endpoint} → HTTP {r.status_code}: {r.text[:200]}')
    return None


def mk_put(endpoint, payload):
    if DRY_RUN:
        print(f'   [DRY-RUN] PUT {endpoint}: {json.dumps(payload)[:120]}')
        return {'id': endpoint.split('/')[-1], '_dry': True}

    params = {'api_key': MEMBERKIT_API_KEY}
    r = requests.put(
        f'{MEMBERKIT_BASE}{endpoint}',
        headers=MK_HEADERS,
        params=params,
        json=payload
    )
    time.sleep(DELAY)

    if r.status_code in (200, 201):
        return r.json()

    print(f'   ❌ PUT {endpoint} → HTTP {r.status_code}: {r.text[:200]}')
    return None


# ==============================
# MAPEAMENTO (RETOMADA)
# ==============================

def carregar_mapping():
    if os.path.exists(MAPPING_FILE):
        with open(MAPPING_FILE, encoding='utf-8') as f:
            return json.load(f)
    return {'courses': {}, 'sections': {}, 'lessons': {}}


def salvar_mapping(mapping):
    with open(MAPPING_FILE, 'w', encoding='utf-8') as f:
        json.dump(mapping, f, ensure_ascii=False, indent=2)


# ==============================
# CRIAÇÃO DE RECURSOS
# ==============================

def criar_ou_obter_course(edools_course, mapping):
    eid = str(edools_course.get('id'))

    if eid in mapping['courses']:
        mk_id = mapping['courses'][eid]
        print(f'   ↩️  Curso já criado (MemberKit ID: {mk_id})')
        return mk_id

    payload = {
        'name':        edools_course.get('name') or f'Curso {eid}',
        'description': edools_course.get('description') or '',
    }

    resultado = mk_post('/courses', payload)
    if not resultado:
        return None

    mk_id = resultado.get('id')
    mapping['courses'][eid] = mk_id
    salvar_mapping(mapping)
    print(f'   ✔ Curso criado → MemberKit ID: {mk_id}')
    return mk_id


def criar_ou_obter_section(edools_module, mk_course_id, position, mapping):
    eid = str(edools_module.get('id'))

    if eid in mapping['sections']:
        mk_id = mapping['sections'][eid]
        print(f'      ↩️  Seção já criada (MemberKit ID: {mk_id})')
        return mk_id

    payload = {
        'name':      edools_module.get('name') or f'Módulo {eid}',
        'course_id': mk_course_id,
        'position':  position,
    }

    resultado = mk_post('/sections', payload)
    if not resultado:
        return None

    mk_id = resultado.get('id')
    mapping['sections'][eid] = mk_id
    salvar_mapping(mapping)
    print(f'      ✔ Seção criada → MemberKit ID: {mk_id}')
    return mk_id


def criar_ou_obter_lesson(edools_content, mk_section_id, position, mapping):
    eid = str(edools_content.get('id'))

    if eid in mapping['lessons']:
        mk_id = mapping['lessons'][eid]
        print(f'         ↩️  Aula já criada (MemberKit ID: {mk_id})')
        return mk_id

    titulo = (
        edools_content.get('title') or
        edools_content.get('name') or
        f'Aula {eid}'
    )
    texto   = extrair_texto(edools_content)
    video   = detectar_video(edools_content)

    payload = {
        'title':      titulo,
        'section_id': mk_section_id,
        'position':   position,
        'content':    texto,
    }

    if video:
        payload['video_uid']    = video['uid']
        payload['video_source'] = video['source']

    resultado = mk_post('/lessons', payload)
    if not resultado:
        return None

    mk_id = resultado.get('id')
    mapping['lessons'][eid] = mk_id
    salvar_mapping(mapping)

    flags = []
    if texto:    flags.append('📝texto')
    if video:    flags.append(f'🎥{video["source"]}')
    if not flags: flags.append('⚠️ sem conteúdo')
    print(f'         ✔ Aula criada → MemberKit ID: {mk_id}  [{", ".join(flags)}]')
    return mk_id


# ==============================
# IMPORTAÇÃO COMPLETA
# ==============================

def importar(dados):
    mapping = carregar_mapping()

    total_courses  = len(dados)
    total_sections = sum(len(c['modules']) for c in dados)
    total_lessons  = sum(len(m['contents']) for c in dados for m in c['modules'])

    print(f'\n📊 Para importar:')
    print(f'   📚 Cursos:   {total_courses}')
    print(f'   📦 Seções:   {total_sections}')
    print(f'   📄 Aulas:    {total_lessons}')

    ja_criados = len(mapping['lessons'])
    if ja_criados:
        print(f'   ↩️  Aulas já criadas (retomando): {ja_criados}')

    print()
    lesson_counter = 0

    for ci, course_data in enumerate(dados, 1):
        edools_course = course_data['course']
        cname = edools_course.get('name', f'ID {edools_course.get("id")}')
        print(f'\n{"="*55}')
        print(f'📚 Curso {ci}/{total_courses}: {cname}')
        print('='*55)

        mk_course_id = criar_ou_obter_course(edools_course, mapping)
        if not mk_course_id:
            print('   ❌ Falha ao criar curso. Pulando.')
            continue

        for mi, module_data in enumerate(course_data['modules'], 1):
            edools_module = module_data['module']
            mname = edools_module.get('name', f'ID {edools_module.get("id")}')
            contents = module_data.get('contents', [])
            print(f'\n  📦 Seção {mi}/{len(course_data["modules"])}: {mname} ({len(contents)} aula(s))')

            mk_section_id = criar_ou_obter_section(edools_module, mk_course_id, mi, mapping)
            if not mk_section_id:
                print('      ❌ Falha ao criar seção. Pulando.')
                continue

            for li, content in enumerate(contents, 1):
                lesson_counter += 1
                pct = int(lesson_counter / total_lessons * 100) if total_lessons else 0
                lname = content.get('title') or content.get('name') or f'ID {content.get("id")}'
                print(f'\n      [{lesson_counter}/{total_lessons} — {pct}%] {lname}')

                criar_ou_obter_lesson(content, mk_section_id, li, mapping)

    return mapping


# ==============================
# EXECUÇÃO
# ==============================

if __name__ == '__main__':
    print('🚀 MemberKit Import\n')

    if MEMBERKIT_API_KEY == 'SUA_API_KEY_AQUI':
        print('❌ Configure MEMBERKIT_API_KEY no início do arquivo.')
        sys.exit(1)

    # Arquivo de exportação: argumento ou padrão
    if len(sys.argv) > 1:
        arquivo = sys.argv[1]
    else:
        # tenta encontrar automaticamente
        candidatos = sorted(
            [f for f in os.listdir('.') if f.startswith('edools') and f.endswith('.json')],
            key=os.path.getmtime,
            reverse=True
        )
        if not candidatos:
            print('❌ Nenhum arquivo edools_*.json encontrado. Passe o caminho como argumento.')
            sys.exit(1)
        arquivo = candidatos[0]
        print(f'📂 Usando arquivo: {arquivo}')

    with open(arquivo, encoding='utf-8') as f:
        dados = json.load(f)

    # Normaliza: aceita lista de cursos ou objeto único
    if isinstance(dados, dict) and 'course' in dados:
        dados = [dados]
    elif not isinstance(dados, list):
        print('❌ Formato de arquivo inesperado.')
        sys.exit(1)

    if DRY_RUN:
        print('⚠️  MODO DRY-RUN — nenhuma alteração será feita no MemberKit\n')

    mapping = importar(dados)

    print('\n' + '='*55)
    print('✅ Importação finalizada!')
    print(f'   📚 Cursos criados:  {len(mapping["courses"])}')
    print(f'   📦 Seções criadas:  {len(mapping["sections"])}')
    print(f'   📄 Aulas criadas:   {len(mapping["lessons"])}')
    print(f'📁 Mapeamento salvo em: {MAPPING_FILE}')
    print('='*55)
