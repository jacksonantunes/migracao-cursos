import os
import sys

# Add project root to path so we can import the existing script
_PROJECT_ROOT = os.path.normpath(os.path.join(os.path.dirname(__file__), '..', '..'))
if _PROJECT_ROOT not in sys.path:
    sys.path.insert(0, _PROJECT_ROOT)

import edools_export as ed


def _patch(config: dict):
    """Patch edools_export module globals with user-supplied credentials."""
    token = config['edools_token']
    ed.TOKEN = token
    ed.BASE_URL = config['edools_url'].rstrip('/')
    ed.HEADERS = {
        'Authorization': f'Token token="{token}"',
        'Accept': 'application/vnd.edools.core.v1+json',
    }


def listar_cursos(config: dict) -> list:
    """Return all courses from Edools."""
    _patch(config)
    return ed.get_all('/courses')


def exportar_curso(course_id, config: dict):
    """
    Fetch full structure (modules + contents) for a single course.
    Returns the list [{course, modules: [{module, contents: [...]}]}]
    or None if the course is not found.
    """
    _patch(config)
    course = ed.buscar_curso_por_id(str(course_id))
    if not course:
        return None
    return ed.exportar([course])
