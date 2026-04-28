"""Local vendor helpers for optional runtime dependencies."""

from __future__ import annotations

import sys
from importlib.util import find_spec
from pathlib import Path


def ensure_vendor_packages() -> None:
    """Add workspace-vendored packages to ``sys.path`` when present."""

    if find_spec("libcst") is not None:
        return

    repo_root = Path(__file__).resolve().parents[2]
    vendor_root = repo_root / ".vendor" / "libcst"
    vendor_path = str(vendor_root)
    if vendor_root.exists() and vendor_path not in sys.path:
        sys.path.insert(0, vendor_path)
