"""Opt-in frontend fixture joining a real Python graph commit to Run preparation.

Invoke with an approved interpreter using -I -B. stdout carries ONLY the genuine
desktop_bridge.run_worker reply. fd3 carries bounded newline JSON control frames:
ready(workerRequest), before_compile, then committed(source/hash/flow/Undo/proof).
Send ready.workerRequest unchanged on stdin, await before_compile, then send
{"command":"release"}. Closing stdout's parent read end before release creates
a genuine reply-lost-after-commit case; its committed frame reports replyLost and
the helper exits74. Normal completion exits0. The controller owns kill/reap and
cleanup of the empty helm-graph-run-join-* temp directory supplied with --repo.

No fixture source is imported/executed, no network or child shell is used, and
only this literal disposable project can be mutated by the accepted request.
"""

from __future__ import annotations

import argparse
import hashlib
import io
import json
import os
import queue
import sys
import threading
from pathlib import Path
from typing import Any


MAX_INPUT_LINE = 64 * 1024
MAX_INPUT_TOTAL = 128 * 1024
MAX_CONTROL_FRAME = 128 * 1024
SYMBOL = "symbol:service:run"
SOURCE = 'LABEL = "joined graph Ω"\n\ndef run(a, b):\n    return b\n'
MARKER = ".helm-graph-run-join-owner.json"


class BoundedInput:
    def __init__(self, timeout: float) -> None:
        self.timeout = timeout
        self.lines: queue.Queue[bytes | BaseException | None] = queue.Queue(maxsize=4)
        # Raw os.read avoids a daemon holding a buffered sys.stdin lock at exit.
        threading.Thread(target=self._read, name="graph-join-stdin", daemon=True).start()

    def _read(self) -> None:
        pending = bytearray()
        total = 0
        try:
            while chunk := os.read(0, 8192):
                total += len(chunk)
                if total > MAX_INPUT_TOTAL:
                    raise ValueError("Fixture input exceeded its bounded protocol budget.")
                pending.extend(chunk)
                while b"\n" in pending:
                    line, _, remainder = pending.partition(b"\n")
                    pending = bytearray(remainder)
                    if len(line) > MAX_INPUT_LINE:
                        raise ValueError("Fixture request line exceeded its bounded budget.")
                    self.lines.put(bytes(line), timeout=self.timeout)
                if len(pending) > MAX_INPUT_LINE:
                    raise ValueError("Fixture request line exceeded its bounded budget.")
            if pending:
                self.lines.put(bytes(pending), timeout=self.timeout)
            self.lines.put(None, timeout=self.timeout)
        except BaseException as error:
            try:
                self.lines.put(error, timeout=self.timeout)
            except queue.Full:
                return

    def receive(self) -> Any:
        try:
            line = self.lines.get(timeout=self.timeout)
        except queue.Empty as error:
            raise ValueError("Fixture controller did not respond before its deadline.") from error
        if line is None:
            raise ValueError("Fixture controller input closed before release.")
        if isinstance(line, BaseException):
            raise ValueError("Fixture input could not be read safely.") from line
        return json.loads(line)


def _arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-root", type=Path, required=True)
    parser.add_argument("--repo", type=Path, required=True)
    parser.add_argument("--timeout", type=float, default=10)
    arguments = parser.parse_args()
    if not 0 < arguments.timeout <= 15:
        parser.error("Fixture timeout must be greater than zero and at most15 seconds.")
    return arguments


def _owned_fixture(repo: Path) -> Path:
    if repo.is_symlink():
        raise ValueError("Fixture directory must not be a symlink.")
    root = repo.resolve(strict=True)
    if not root.is_dir() or not root.name.startswith("helm-graph-run-join-"):
        raise ValueError("Fixture requires an existing controller-owned temp directory.")
    if hasattr(os, "getuid") and root.stat().st_uid != os.getuid():
        raise ValueError("Fixture directory belongs to a different owner.")
    with os.scandir(root) as entries:
        if next(entries, None) is not None:
            raise ValueError("Fixture refuses to modify a nonempty directory.")
    (root / MARKER).write_text(
        json.dumps({"kind": "helm-graph-run-join-v1", "ownedNames": ["service.py", ".helm"]}),
        encoding="utf-8",
    )
    (root / "service.py").write_bytes(SOURCE.encode("utf-8"))
    return root


def _control_frame(control: Any, event: str, **fields: Any) -> None:
    frame = json.dumps({"event": event, **fields}, ensure_ascii=True, sort_keys=True) + "\n"
    if len(frame.encode("utf-8")) > MAX_CONTROL_FRAME:
        raise ValueError("Fixture control frame exceeded its bounded budget.")
    control.write(frame)
    control.flush()


def main() -> int:
    arguments = _arguments()
    with os.fdopen(3, "w", encoding="utf-8", buffering=1) as control:
        try:
            source_root = arguments.source_root.resolve(strict=True)
            if not (source_root / "src/helm/ui/desktop_bridge.py").is_file():
                raise ValueError("Selected checkout has no HELM worker source.")
            # -I intentionally ignores PYTHONPATH. This explicit checkout is the
            # approved application source, never the synthetic project below.
            sys.path.insert(0, str(source_root / "src"))
            from helm.editor.flow_model import (
                FLOW_MODEL_RELATIVE_PATH,
                import_flow_document_from_function_source,
                read_flow_document,
            )
            from helm.ui import desktop_bridge
            from helm.ui.run_preparation import prepare_run_source

            root = _owned_fixture(arguments.repo)
            document = import_flow_document_from_function_source(
                symbol_id=SYMBOL,
                relative_path="service.py",
                qualname="run",
                module_source=SOURCE,
            ).to_dict()
            return_id = next(node["id"] for node in document["nodes"] if node["kind"] == "return")
            slot = next(slot for slot in document["input_slots"] if slot["node_id"] == return_id)
            value = next(value for value in document["function_inputs"] if value["name"] == "a")
            document["input_bindings"] = [
                {
                    **binding,
                    "id": f"flowbinding:{slot['id']}->{value['id']}",
                    "slot_id": slot["id"],
                    "source_id": value["id"],
                    "function_input_id": value["id"],
                }
                if binding["slot_id"] == slot["id"]
                else binding
                for binding in document["input_bindings"]
            ]
            request = {
                "id": 41,
                "command": "apply-edit",
                "params": {
                    "repo": str(root),
                    "request_json": json.dumps(
                        {"kind": "replace_flow_graph", "target_id": SYMBOL, "flow_graph": document}
                    ),
                },
            }
            controller = BoundedInput(arguments.timeout)
            _control_frame(
                control,
                "ready",
                repoPath=str(root),
                workerRequest=request,
                initialSourceHash=hashlib.sha256(SOURCE.encode("utf-8")).hexdigest(),
                symbolId=SYMBOL,
                flowStoreRelativePath=FLOW_MODEL_RELATIVE_PATH,
            )
            if controller.receive() != request:
                raise ValueError("Fixture accepts only its exact literal graph edit request.")
            _control_frame(control, "before_compile", repoPath=str(root), requestId=request["id"])
            if controller.receive() != {"command": "release"}:
                raise ValueError("Fixture expected the explicit compile release command.")

            actual = desktop_bridge._handle_worker_command
            committed: list[dict[str, Any]] = []

            def record_actual_commit(command: str, params: dict[str, Any], **kwargs: Any) -> dict:
                result = actual(command, params, **kwargs)
                committed.append(result)
                return result

            desktop_bridge._handle_worker_command = record_actual_commit
            reply_lost = False
            try:
                # The real worker writes/flushes its real response on stdout.
                # No fake output object or injected JS transport error is used.
                desktop_bridge.run_worker(io.StringIO(json.dumps(request) + "\n"), sys.stdout)
            except BrokenPipeError:
                reply_lost = True
            finally:
                desktop_bridge._handle_worker_command = actual
            if (
                len(committed) != 1
                or committed[0].get("edit", {}).get("flow_sync_state") != "clean"
            ):
                raise ValueError("Fixture did not receive one successful real graph commit.")
            source = (root / "service.py").read_bytes()
            metadata = (root / FLOW_MODEL_RELATIVE_PATH).read_bytes()
            stored = read_flow_document(root, SYMBOL)
            if stored is None or stored.sync_state != "clean":
                raise ValueError("Fixture committed graph metadata is not clean.")
            proof = prepare_run_source(root)
            _control_frame(
                control,
                "committed",
                repoPath=str(root),
                requestId=request["id"],
                applyCount=len(committed),
                sourceContent=source.decode("utf-8"),
                sourceSha256=hashlib.sha256(source).hexdigest(),
                flowStoreRelativePath=FLOW_MODEL_RELATIVE_PATH,
                flowStoreSha256=hashlib.sha256(metadata).hexdigest(),
                flowSyncState=stored.sync_state,
                undoTransaction=committed[0]["edit"]["undo_transaction"],
                journalCount=len(list((root / ".helm/recovery/journals").glob("*.json"))),
                preparedSource=proof,
                replyLost=reply_lost,
            )
            if reply_lost:
                # Real stdout EPIPE would otherwise be retried during interpreter
                # stream finalization. The controller already has the durable
                # evidence and owns cleanup/reap; do not manufacture another reply.
                os._exit(74)
            return 0
        except Exception as error:
            _control_frame(control, "error", message=str(error)[:1000])
            return 2


if __name__ == "__main__":
    raise SystemExit(main())
