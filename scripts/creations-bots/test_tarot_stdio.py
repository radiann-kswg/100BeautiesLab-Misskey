# SPDX-FileCopyrightText: syuilo and misskey-project
# SPDX-License-Identifier: AGPL-3.0-only

"""Test-only subprocess driver, never selected by the host worker launcher."""
import importlib.util
from pathlib import Path
import sys
from types import SimpleNamespace

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location("creations_tarot_worker", Path(__file__).with_name("tarot.py"))
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)


def create(**kwargs):
    print("dependency stdout must not escape")
    print("dependency stderr test-provider-secret must not escape", file=sys.stderr)
    if "FAIL" in kwargs["messages"][-1]["content"]:
        raise RuntimeError("test-provider-secret")
    return SimpleNamespace(
        stop_reason="end_turn",
        content=[SimpleNamespace(type="text", text="mock real reading result")],
        usage=SimpleNamespace(input_tokens=1, output_tokens=1),
    )


sys.exit(worker.main(client=SimpleNamespace(messages=SimpleNamespace(create=create))))
