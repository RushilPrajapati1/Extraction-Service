"""
Shared fixtures.

The suite deliberately imports nothing from the pipeline's heavy
dependencies (ollama, pypdfium2, fastapi) so `pytest` runs without a
model server, a GCP project, or a network connection.
"""

import sys
from pathlib import Path

# tests/ lives inside extraction-worker/, and the pipeline modules import
# each other flatly (`import db`, not `from extraction_worker import db`),
# so the package directory has to be on the path.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
