"""
Mock server da API MemberKit para testes locais.

Uso:
    pip install fastapi uvicorn
    python tools/mock_memberkit.py

Depois configure no sistema:
    URL MemberKit: http://localhost:8765/api/v1
    API Key:       qualquer-valor

Endpoints disponíveis:
    POST   /api/v1/courses
    POST   /api/v1/sections
    POST   /api/v1/lessons
    GET    /api/v1/courses
    GET    /api/v1/sections
    GET    /api/v1/lessons
    GET    /mock/log        → histórico de requisições
    DELETE /mock/reset      → limpa tudo
"""

import json
import time
from datetime import datetime
from fastapi import FastAPI, Request, HTTPException
from fastapi.responses import JSONResponse
import uvicorn

app = FastAPI(title="Mock MemberKit API")

# ── Estado em memória ────────────────────────────────────────────────────────
_store = {
    "courses":  {},   # id → objeto
    "sections": {},
    "lessons":  {},
}
_counter = {"courses": 1000, "sections": 2000, "lessons": 3000}
_log: list[dict] = []


# ── Helpers ──────────────────────────────────────────────────────────────────
def _next_id(resource: str) -> int:
    _counter[resource] += 1
    return _counter[resource]


def _log_req(method: str, path: str, params: dict, body: dict | None, status: int, response: dict):
    entry = {
        "ts":       datetime.now().strftime("%H:%M:%S"),
        "method":   method,
        "path":     path,
        "params":   params,
        "body":     body,
        "status":   status,
        "response": response,
    }
    _log.append(entry)
    # Imprime no terminal para acompanhamento em tempo real
    color = "\033[92m" if status < 300 else "\033[91m"
    reset = "\033[0m"
    body_preview = json.dumps(body)[:120] if body else "-"
    print(f"{color}[{entry['ts']}] {method} {path} → {status}{reset}  body={body_preview}")


# ── Middleware: loga todas as requisições ────────────────────────────────────
@app.middleware("http")
async def log_all(request: Request, call_next):
    response = await call_next(request)
    return response


# ── POST /api/v1/courses ─────────────────────────────────────────────────────
@app.post("/api/v1/courses")
async def create_course(request: Request):
    body = await request.json()
    params = dict(request.query_params)

    if not body.get("name"):
        _log_req("POST", "/api/v1/courses", params, body, 422, {"error": "name is required"})
        raise HTTPException(422, detail={"error": "name is required"})

    obj = {
        "id":          _next_id("courses"),
        "name":        body.get("name"),
        "description": body.get("description", ""),
        "created_at":  datetime.now().isoformat(),
    }
    _store["courses"][obj["id"]] = obj
    _log_req("POST", "/api/v1/courses", params, body, 201, obj)
    return JSONResponse(obj, status_code=201)


@app.get("/api/v1/courses")
async def list_courses(request: Request):
    result = list(_store["courses"].values())
    _log_req("GET", "/api/v1/courses", dict(request.query_params), None, 200, result)
    return result


# ── POST /api/v1/sections ────────────────────────────────────────────────────
@app.post("/api/v1/sections")
async def create_section(request: Request):
    body = await request.json()
    params = dict(request.query_params)

    if not body.get("name"):
        _log_req("POST", "/api/v1/sections", params, body, 422, {"error": "name is required"})
        raise HTTPException(422, detail={"error": "name is required"})
    if not body.get("course_id"):
        _log_req("POST", "/api/v1/sections", params, body, 422, {"error": "course_id is required"})
        raise HTTPException(422, detail={"error": "course_id is required"})

    obj = {
        "id":        _next_id("sections"),
        "name":      body.get("name"),
        "course_id": body.get("course_id"),
        "position":  body.get("position", 1),
        "created_at": datetime.now().isoformat(),
    }
    _store["sections"][obj["id"]] = obj
    _log_req("POST", "/api/v1/sections", params, body, 201, obj)
    return JSONResponse(obj, status_code=201)


@app.get("/api/v1/sections")
async def list_sections(request: Request):
    result = list(_store["sections"].values())
    _log_req("GET", "/api/v1/sections", dict(request.query_params), None, 200, result)
    return result


# ── POST /api/v1/lessons ─────────────────────────────────────────────────────
@app.post("/api/v1/lessons")
async def create_lesson(request: Request):
    body = await request.json()
    params = dict(request.query_params)

    if not body.get("title"):
        _log_req("POST", "/api/v1/lessons", params, body, 422, {"error": "title is required"})
        raise HTTPException(422, detail={"error": "title is required"})
    if not body.get("section_id"):
        _log_req("POST", "/api/v1/lessons", params, body, 422, {"error": "section_id is required"})
        raise HTTPException(422, detail={"error": "section_id is required"})

    obj = {
        "id":           _next_id("lessons"),
        "title":        body.get("title"),
        "section_id":   body.get("section_id"),
        "position":     body.get("position", 1),
        "content":      body.get("content", ""),
        "video_uid":    body.get("video_uid"),
        "video_source": body.get("video_source"),
        "created_at":   datetime.now().isoformat(),
    }
    _store["lessons"][obj["id"]] = obj
    _log_req("POST", "/api/v1/lessons", params, body, 201, obj)
    return JSONResponse(obj, status_code=201)


@app.get("/api/v1/lessons")
async def list_lessons(request: Request):
    result = list(_store["lessons"].values())
    _log_req("GET", "/api/v1/lessons", dict(request.query_params), None, 200, result)
    return result


# ── /mock/log — histórico de todas as requisições ────────────────────────────
@app.get("/mock/log")
async def get_log():
    summary = {
        "total_requests": len(_log),
        "courses_created":  len(_store["courses"]),
        "sections_created": len(_store["sections"]),
        "lessons_created":  len(_store["lessons"]),
        "requests": _log,
    }
    return summary


# ── /mock/reset — limpa tudo para recomeçar ───────────────────────────────────
@app.delete("/mock/reset")
async def reset():
    for k in _store:
        _store[k].clear()
    _log.clear()
    _counter.update({"courses": 1000, "sections": 2000, "lessons": 3000})
    return {"status": "reset ok"}


# ── /mock/store — estado atual ────────────────────────────────────────────────
@app.get("/mock/store")
async def get_store():
    return {
        "courses":  list(_store["courses"].values()),
        "sections": list(_store["sections"].values()),
        "lessons":  list(_store["lessons"].values()),
    }


# ── /health ───────────────────────────────────────────────────────────────────
@app.get("/health")
async def health():
    return {"status": "ok", "mock": True}


# ── Catch-all: ajuda a identificar endpoints desconhecidos ────────────────────
@app.api_route("/{full_path:path}", methods=["GET", "POST", "PUT", "PATCH", "DELETE"])
async def catch_all(full_path: str, request: Request):
    body = None
    try:
        body = await request.json()
    except Exception:
        pass
    msg = {"error": "Resource not found", "path": f"/{full_path}", "hint": "Este endpoint não existe no mock"}
    _log_req(request.method, f"/{full_path}", dict(request.query_params), body, 404, msg)
    return JSONResponse(msg, status_code=404)


# ── Entry point ───────────────────────────────────────────────────────────────
if __name__ == "__main__":
    print("=" * 60)
    print("  Mock MemberKit API")
    print("=" * 60)
    print("  URL base:  http://localhost:8765/api/v1")
    print("  API Key:   qualquer valor serve")
    print()
    print("  Endpoints de diagnóstico:")
    print("    GET  http://localhost:8765/mock/log    → histórico")
    print("    GET  http://localhost:8765/mock/store  → dados criados")
    print("    DELETE http://localhost:8765/mock/reset → limpar")
    print("=" * 60)
    uvicorn.run(app, host="0.0.0.0", port=8765, log_level="warning")
