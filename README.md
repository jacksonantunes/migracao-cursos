# Migrador de Cursos — Edools → MemberKit

Ferramenta web para migrar cursos completos da plataforma **Edools** para o **MemberKit**, preservando módulos, aulas e conteúdos. Suporta migração incremental via arquivo de mapeamento e exibe progresso em tempo real.

---

## Funcionalidades

- Listagem de cursos disponíveis na conta Edools
- Seleção individual ou em lote dos cursos a migrar
- Exportação completa: módulos, aulas, vídeos (YouTube, Vimeo, Panda Video) e materiais
- Importação automática no MemberKit com criação de seções e lições
- Migração incremental: retoma de onde parou (baseado em `memberkit_mapping.json`)
- Log de progresso em tempo real na interface web
- Download do JSON exportado por curso

---

## Arquitetura

```
┌─────────────────────────────────────────┐
│              Frontend (SPA)             │
│  index.html + app.js  ·  Tailwind CSS   │
└──────────────────┬──────────────────────┘
                   │ HTTP REST
┌──────────────────▼──────────────────────┐
│           Backend (FastAPI)             │
│              backend/main.py            │
│   /api/config · /api/buscar-cursos      │
│   /api/migrar · /api/status · /download │
└──────┬───────────────────────┬──────────┘
       │                       │
┌──────▼──────┐         ┌──────▼──────┐
│  Edools API │         │MemberKit API│
│  (export)   │         │  (import)   │
└─────────────┘         └─────────────┘
```

### Fluxo de dados

1. Usuário insere as credenciais na tela de configuração
2. Sistema lista os cursos disponíveis no Edools
3. Usuário seleciona os cursos desejados
4. Para cada curso selecionado:
   - Exporta estrutura completa do Edools
   - Importa no MemberKit (módulos → seções, aulas → lições)
   - Registra IDs criados no arquivo de mapeamento
5. Log de progresso exibido em tempo real

---

## Pré-requisitos

- Docker (recomendado) **ou** Python 3.11+
- Token de API do Edools
- Chave de API do MemberKit

---

## Instalação e execução

### Com Docker (recomendado)

```bash
docker build -t migrador-cursos .
docker run -p 8000:8000 migrador-cursos
```

Acesse: [http://localhost:8000](http://localhost:8000)

### Sem Docker

```bash
pip install -r requirements.txt
uvicorn backend.main:app --host 0.0.0.0 --port 8000
```

---

## Configuração

As credenciais são informadas diretamente na interface web e **nunca são gravadas em disco**. Ficam armazenadas apenas em memória durante a sessão.

| Campo | Descrição |
|---|---|
| Token Edools | Token de autenticação da API Edools |
| URL Edools | URL base da sua conta (ex: `https://suaescola.edools.com`) |
| API Key MemberKit | Chave de API do MemberKit |
| URL MemberKit | URL base da API (padrão: `https://memberkit.com.br/api/v1`) |

---

## Migração incremental

O arquivo `memberkit_mapping.json` (gerado automaticamente na raiz do projeto) registra todos os recursos já criados no MemberKit. Em caso de interrupção, ao executar novamente a migração do mesmo curso, os itens já criados são ignorados e a migração continua do ponto onde parou.

> **Atenção:** não commite o arquivo `memberkit_mapping.json`. Ele já está no `.gitignore`.

---

## Estrutura do projeto

```
.
├── Dockerfile
├── requirements.txt
├── .gitignore
├── edools_export.py          # Cliente da API Edools
├── memberkit_import.py       # Cliente da API MemberKit
└── backend/
    ├── main.py               # Aplicação FastAPI + endpoints REST
    └── services/
        ├── edools.py         # Serviço de exportação
        ├── memberkit.py      # Serviço de importação
        └── migration.py      # Orquestrador da migração
└── frontend/
    ├── index.html            # Interface web
    └── app.js                # Lógica do frontend
```

---

## Dependências

| Pacote | Uso |
|---|---|
| `fastapi` | Framework web / API REST |
| `uvicorn` | Servidor ASGI |
| `requests` | Cliente HTTP para as APIs externas |

---

## Segurança

- Credenciais armazenadas **apenas em memória** (nunca em disco ou logs)
- Nenhuma chave de API hardcoded no código-fonte
- `memberkit_mapping.json` ignorado pelo Git (pode conter IDs internos)
- Inputs de senha mascarados na interface web

---

## Deploy no Easypanel

1. Crie um novo serviço do tipo **App**
2. Aponte para este repositório
3. O Easypanel irá detectar o `Dockerfile` automaticamente
4. Exponha a porta **8000**
5. Acesse a URL gerada e configure suas credenciais na interface
