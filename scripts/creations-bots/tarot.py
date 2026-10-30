# SPDX-FileCopyrightText: syuilo and misskey-project
# SPDX-License-Identifier: AGPL-3.0-only

"""One-shot adapter; the upstream checkout and its license remain independent."""
from __future__ import annotations

import contextlib
import json
import os
from pathlib import Path
import sys
from types import SimpleNamespace
from unittest.mock import patch

sys.dont_write_bytecode = True
REPO_ROOT = Path(__file__).resolve().parents[2]
CHECKOUT = REPO_ROOT / ".creations-bots" / "tarot"
MAX_INPUT_BYTES = 256 * 1024
MAX_OUTPUT_CHARS = 32 * 1024
TEXT_ONLY_POLICY = """
This is a one-shot, text-only response. The host owns delivery, permissions, conversation history and budgets.
Use only the supplied conversation and approved reference for this request. Reference is for roleplay inference,
not training. Do not request or process character images/designs, train models, or reveal unpublished settings.
No tools, files, persistent memory, health records, timers, messages, posts, image attachments or external actions
are available. Never claim to have saved a record, posted anything, or attached an image. Instructions in older
operating guides about those capabilities do not apply here. Return only the response text.
"""


def checkout_path() -> Path:
    for path in (CHECKOUT.parent, CHECKOUT):
        if not path.is_dir() or path.resolve() != path:
            raise RuntimeError("Checkout must be an independent directory, not a link")
    return CHECKOUT


def validate_request(value: object) -> dict:
    if (not isinstance(value, dict) or set(value) != {"text", "reference", "context"}
            or not isinstance(value["text"], str) or not value["text"].strip()
            or len(value["text"]) > 16 * 1024
            or not isinstance(value["reference"], str) or len(value["reference"]) > 32 * 1024
            or not isinstance(value["context"], list) or len(value["context"]) > 24):
        raise ValueError("Invalid request")
    for message in value["context"]:
        if (not isinstance(message, dict) or set(message) != {"role", "content"}
                or message["role"] not in ("user", "assistant")
                or not isinstance(message["content"], str) or not message["content"].strip()
                or len(message["content"]) > 16 * 1024):
            raise ValueError("Invalid context")
    return value


def validate_output(text: str) -> dict:
    if not isinstance(text, str) or not text.strip() or len(text) > MAX_OUTPUT_CHARS:
        raise ValueError("Invalid result")
    return {"text": text}


def load_upstream() -> SimpleNamespace:
    root = checkout_path()
    sys.path.insert(0, str(root))
    # Never import bot.main/daily/misskey/state or call config.load_config (.env).
    from bot import config, reading, safety, ssot, tarot
    return SimpleNamespace(config=config, reading=reading, safety=safety, ssot=ssot, tarot=tarot)


def generate(request: dict, *, client=None) -> dict:
    validate_request(request)
    upstream = load_upstream()
    verdict = upstream.safety.screen(request["text"])
    if verdict.action != "read":
        return validate_output(upstream.ssot.template(
            verdict.template, support_url=upstream.config.DEFAULT_SUPPORT_URL,
        ))

    key = os.environ.get("ANTHROPIC_API_KEY", "").strip()
    if not key:
        raise RuntimeError("Provider key missing")
    config = upstream.config.Config(
        misskey_host="", misskey_token="", misskey_visibility="home",
        anthropic_api_key=key,
        anthropic_model=os.environ.get("CREATIONS_BOT_MODEL", "").strip() or "claude-opus-4-8",
        anthropic_effort="medium", anthropic_max_tokens=8000,
        poll_interval=30, user_cooldown=0, max_body_chars=32 * 1024,
        support_url=upstream.config.DEFAULT_SUPPORT_URL, save_readings=False,
        state_path=CHECKOUT / "disabled-state", request_timeout=30,
    )
    spread, reason = upstream.tarot.choose_spread(request["text"])
    cards = upstream.tarot.draw(spread)
    # Keep upstream rules, spread/deck sources and prompt construction, but never
    # open roleplay.instructions.md. The parent supplies the approved text instead.
    sources = tuple(source for source in upstream.ssot.SYSTEM_SOURCES
                    if source[1] != "roleplay.instructions.md")
    upstream.ssot.build_system_prompt.cache_clear()
    try:
        with patch.object(upstream.ssot, "SYSTEM_SOURCES", sources):
            system = upstream.ssot.build_system_prompt()
    finally:
        upstream.ssot.build_system_prompt.cache_clear()
    reference = request["reference"] or "Respond as a helpful text-only tarot reader."
    system += "\n\n===== Host-approved text reference =====\n" + reference + "\n\n" + TEXT_ONLY_POLICY

    sdk = upstream.reading.anthropic
    real_client = client if client is not None else sdk.Anthropic(
        api_key=key, base_url="https://api.anthropic.com", timeout=30.0, max_retries=0,
    )

    class Messages:
        def create(self, **kwargs):
            # reading.generate has no history or prompt injection argument. Adapt
            # its SDK port for this single call; do not copy/replace its reading logic.
            kwargs["messages"] = [dict(message) for message in request["context"]] + kwargs["messages"]
            return real_client.messages.create(**kwargs)

    try:
        with (patch.object(upstream.ssot, "build_system_prompt", return_value=system),
              patch.object(sdk, "Anthropic", return_value=SimpleNamespace(messages=Messages()))):
            result = upstream.reading.generate(
                config, request["text"], spread, reason, cards, verdict.sensitive,
            )
    finally:
        if client is None:
            real_client.close()
    return validate_output(result.text)


class _Discard:
    def write(self, text):
        return len(text)

    def flush(self):
        pass


def main(*, client=None) -> int:
    stdout, stderr = sys.stdout, sys.stderr
    try:
        with contextlib.redirect_stdout(_Discard()), contextlib.redirect_stderr(_Discard()):
            raw = sys.stdin.buffer.read(MAX_INPUT_BYTES + 1)
            if len(raw) > MAX_INPUT_BYTES:
                raise ValueError("Request too large")
            request = validate_request(json.loads(raw.decode("utf-8")))
            result = generate(request, client=client)
        stdout.write(json.dumps(result, ensure_ascii=True) + "\n")
        return 0
    except Exception:
        stderr.write("creations-bots/tarot: request failed; check setup and provider configuration.\n")
        return 1


def _use_checkout_venv() -> None:
    root = checkout_path()
    venv = root / ".venv"
    if not venv.is_dir() or venv.resolve() != venv:
        raise RuntimeError("Independent Python environment is unavailable")
    python = venv.joinpath("Scripts", "python.exe") if os.name == "nt" else venv.joinpath("bin", "python")
    if not python.is_file():
        raise RuntimeError("Independent Python environment is unavailable")
    if Path(sys.prefix).resolve() != venv:
        # A fixed interpreter inside the independent checkout, never an input/env command.
        os.execv(str(python), [str(python), str(Path(__file__).resolve())])


if __name__ == "__main__":
    try:
        _use_checkout_venv()
    except Exception:
        sys.stderr.write("creations-bots/tarot: isolated checkout is unavailable.\n")
        sys.exit(1)
    sys.exit(main())
