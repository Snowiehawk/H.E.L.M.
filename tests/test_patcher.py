from __future__ import annotations

import unittest

from helm.editor import apply_structural_edit, serialize_edit_request


class EditorStubsTests(unittest.TestCase):
    def test_patcher_is_intentionally_deferred(self) -> None:
        with self.assertRaises(NotImplementedError):
            apply_structural_edit()

    def test_serializer_is_intentionally_deferred(self) -> None:
        with self.assertRaises(NotImplementedError):
            serialize_edit_request()
