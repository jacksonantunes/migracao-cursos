import os
import sys

# Add project root to path so we can import the existing script
_PROJECT_ROOT = os.path.normpath(os.path.join(os.path.dirname(__file__), '..', '..'))
if _PROJECT_ROOT not in sys.path:
    sys.path.insert(0, _PROJECT_ROOT)

import memberkit_import as mk


def _patch(config: dict, mapping_file: str):
    """Patch memberkit_import module globals with user-supplied credentials."""
    mk.MEMBERKIT_API_KEY = config['mk_key']
    mk.MEMBERKIT_BASE = config['mk_url'].rstrip('/')
    mk.DRY_RUN = False
    mk.MAPPING_FILE = mapping_file


def importar_dados(dados: list, config: dict, mapping_file: str) -> dict:
    """
    Import the exported Edools structure into MemberKit.
    Returns the mapping dict (courses/sections/lessons IDs).
    """
    _patch(config, mapping_file)
    return mk.importar(dados)
