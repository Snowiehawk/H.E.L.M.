"""Byte fidelity through the inspector Save and serialized backend Undo/Redo path."""

import json

import pytest

from helm.ui.workspace_session import WorkspaceSession


ORIGINAL = (
    b"def greet(name):\n    return 'Hello, ' + name\n\ndef main():\n    return greet('Windows')\n"
)


def wire_copy(value):
    return json.loads(json.dumps(value))


@pytest.mark.parametrize("newline", [b"\n", b"\r\n"], ids=["lf", "crlf"])
def test_inspector_save_preserves_module_newlines(tmp_path, newline):
    source = tmp_path / "sample.py"
    original = ORIGINAL.replace(b"\n", newline)
    source.write_bytes(original)
    session = WorkspaceSession.open(tmp_path)
    draft = session.get_editable_node_source("symbol:sample:greet")["content"]

    saved = session.save_node_source("symbol:sample:greet", draft.replace("Hello", "j"))

    assert source.read_bytes() == original.replace(b"Hello", b"j")
    undone = session.apply_undo(wire_copy(saved["edit"]["undo_transaction"]))
    assert source.read_bytes() == original
    session.apply_undo(wire_copy(undone["undo"]["redo_transaction"]))
    assert source.read_bytes() == original.replace(b"Hello", b"j")


@pytest.mark.parametrize(
    "original",
    [
        ORIGINAL,
        ORIGINAL.replace(b"\n", b"\r\n"),
        ORIGINAL.replace(b"\n", b"\r\n", 2),
    ],
    ids=["lf", "crlf", "mixed"],
)
def test_backend_undo_redo_restores_exact_bytes(tmp_path, original):
    source = tmp_path / "sample.py"
    source.write_bytes(original)
    session = WorkspaceSession.open(tmp_path)
    saved = session.save_node_source(
        "symbol:sample:greet", "def greet(name):\n    return 'j, ' + name\n"
    )
    edited = source.read_bytes()

    undone = session.apply_undo(wire_copy(saved["edit"]["undo_transaction"]))

    assert source.read_bytes() == original
    redone = session.apply_undo(wire_copy(undone["undo"]["redo_transaction"]))
    assert source.read_bytes() == edited
    session.apply_undo(wire_copy(redone["undo"]["redo_transaction"]))
    assert source.read_bytes() == original


@pytest.mark.parametrize("newline", [b"\n", b"\r\n"], ids=["lf", "crlf"])
def test_unicode_declaration_save_confirms_exact_source_before_following_code(tmp_path, newline):
    source = tmp_path / "sample.py"
    original = ORIGINAL.replace(b"\n", newline)
    source.write_bytes(original)
    session = WorkspaceSession.open(tmp_path)
    baseline = session.get_editable_node_source("symbol:sample:greet")["content"]
    declaration = 'def greet(name):\n    return "QA_DECLARATION_3 🧭 " + name\n'

    saved = session.save_node_source("symbol:sample:greet", declaration, expected_source=baseline)

    assert source.read_bytes() == original.replace(
        b"def greet(name):" + newline + b"    return 'Hello, ' + name" + newline,
        declaration.encode().replace(b"\n", newline),
    )
    confirmed = session.get_editable_node_source("symbol:sample:greet")["content"]
    assert confirmed.strip() == declaration.strip()
    assert session.get_editable_node_source("symbol:sample:main")["content"].startswith(
        "def main():"
    )
    undone = session.apply_undo(wire_copy(saved["edit"]["undo_transaction"]))
    assert source.read_bytes() == original
    session.apply_undo(wire_copy(undone["undo"]["redo_transaction"]))
    assert (
        session.get_editable_node_source("symbol:sample:greet")["content"].strip()
        == declaration.strip()
    )
