"""
Guards the storage seam at the source level.

A backend is only swappable if EVERY access to a stored document goes
through storage.py. Before this work, two call sites didn't: ingest.py
called os.path.exists() on storage_path and handed it to FileResponse,
and worker.py open()'d it. Both are fine against local disk and both
break instantly against a gs:// URI -- and neither would be caught by
testing storage.py alone, because storage.py was not the thing at fault.

These tests read the pipeline's source rather than importing it: the
modules pull in fastapi, pypdfium2 and ollama at import time, and
requiring a model server to run a lint-shaped assertion would make the
suite far more expensive than what it checks.
"""

import io
import re
import token as token_module
import tokenize
from pathlib import Path

import pytest

WORKER_DIR = Path(__file__).resolve().parent.parent

# Modules that handle a storage_path but must never interpret it.
CONSUMERS = ["ingest.py", "worker.py"]


def source_of(name: str) -> str:
    return (WORKER_DIR / name).read_text()


def code_only(src: str) -> str:
    """
    Blank out comments and docstrings, leaving executable source with its
    exact text and layout intact.

    Necessary because these modules *explain* the storage seam in prose
    -- ingest.py's comments mention both FileResponse and gs:// while
    doing neither. Scanning raw text would flag the documentation of the
    fix as the bug it documents.

    Comment spans are overwritten with spaces rather than deleted, so
    that code text is preserved byte for byte. An earlier version joined
    tokens with newlines instead, which silently split "open(storage_path"
    across lines and made every substring assertion below unfalsifiable.
    """
    lines = src.splitlines(keepends=True)
    at_line_start = True

    for tok in tokenize.generate_tokens(io.StringIO(src).readline):
        is_comment = tok.type == token_module.COMMENT
        is_docstring = tok.type == token_module.STRING and at_line_start

        if tok.type == token_module.STRING and not at_line_start:
            at_line_start = False
        elif tok.type in (token_module.NEWLINE, token_module.NL,
                          token_module.INDENT, token_module.DEDENT):
            at_line_start = True
        elif not is_comment:
            at_line_start = False

        if not (is_comment or is_docstring):
            continue

        (start_row, start_col), (end_row, end_col) = tok.start, tok.end
        for row in range(start_row, end_row + 1):
            line = lines[row - 1]
            begin = start_col if row == start_row else 0
            finish = end_col if row == end_row else len(line.rstrip("\n"))
            lines[row - 1] = (
                line[:begin]
                + " " * (finish - begin)
                + line[finish:]
            )

    return "".join(lines)



@pytest.mark.parametrize("module", CONSUMERS)
def test_consumers_do_not_open_storage_paths_directly(module):
    src = code_only(source_of(module))
    assert "open(storage_path" not in src, (
        f"{module} calls open() on a storage_path. That works on local disk and "
        "fails on a gs:// URI -- use storage.read_document() instead."
    )


@pytest.mark.parametrize("module", CONSUMERS)
def test_consumers_do_not_stat_storage_paths_directly(module):
    src = code_only(source_of(module))
    for forbidden in ("os.path.exists(storage_path", "Path(storage_path"):
        assert forbidden not in src, (
            f"{module} inspects a storage_path with the filesystem API "
            f"({forbidden}...). Use storage.document_exists() instead."
        )


def test_ingest_does_not_serve_storage_paths_with_fileresponse():
    """
    FileResponse takes a filesystem path. Handing it a gs:// URI produces
    a 500 at request time, not an import error -- so it survives every
    test that doesn't actually fetch a document.
    """
    src = code_only(source_of("ingest.py"))
    assert "FileResponse" not in src, (
        "ingest.py still uses FileResponse, which can only serve local files."
    )


@pytest.mark.parametrize("module", CONSUMERS)
def test_consumers_import_storage(module):
    assert re.search(r"^import storage$", source_of(module), re.MULTILINE), (
        f"{module} handles documents but doesn't import storage."
    )


def test_storage_is_the_only_module_that_knows_about_gs_uris():
    """
    The gs:// scheme is an implementation detail of storage.py. If it
    leaks into another module, that module has started caring which
    backend is configured -- which is the whole thing this seam exists
    to prevent.
    """
    leaked = [
        path.name
        for path in WORKER_DIR.glob("*.py")
        if path.name != "storage.py" and "gs://" in code_only(path.read_text())
    ]
    assert leaked == [], f"gs:// leaked outside storage.py into: {leaked}"
