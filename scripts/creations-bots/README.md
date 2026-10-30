# Isolated creations-bot workers

These are **one-shot text adapters**, not independent Misskey bots. The Misskey host
authorizes and starts known functions, supplies approved text references and
conversation context, enforces paid-provider consent and separate budgets, and
posts the result as the centrally managed character account.

## Upstreams and licenses

The public upstream sources and `LICENCE` files were inspected with `gh`. Reviewed
revisions are pinned in `upstreams.json`:

| Worker | Independent public repository | Revision |
| --- | --- | --- |
| APHR | [radiann-kswg/APHRNTs_100](https://github.com/radiann-kswg/APHRNTs_100) | `ea5da87364f407535b772fcad07df7d249b0b400` |
| Tarot | [radiann-kswg/Tarot-byFateLineDealer](https://github.com/radiann-kswg/Tarot-byFateLineDealer) | `a94c2e72861aa66d6c7abcbc351367fea88cdf72` |

Both carry **CC BY-NC 4.0**, not AGPL. Their source, prompts, card data, assets and
licenses remain in separate ignored `.creations-bots\aphr` and
`.creations-bots\tarot` checkouts. Nothing is vendored or relicensed into Misskey.
Keep upstream attribution and license notices and comply with their noncommercial
restriction; this integration grants no additional commercial or character rights.
Adapter files in this directory follow Misskey's own license.

The workers do not read any preexisting main checkout, `.env`, bridge logs,
upstream saved sessions, or character-image/design files. Never copy those into
these independent checkouts. Do not start the upstream bots alongside the host.

## First use (from the Misskey repository root)

Prerequisites: **Node.js 24+ with npm**, Git and network access to the public
repositories/package registries; for Tarot, **Python 3.11+ with venv and pip**.
No Misskey pnpm workspace installation is needed for these scripts.

```powershell
node --version
node scripts\creations-bots\install.mjs all
```

`aphr` or `tarot` can replace `all`. The installer clones only the two fixed public
repositories and checks the origin, exact revision, tracked-file cleanliness and
original `LICENCE`. It refuses to overwrite an existing different/dirty checkout
or follow linked installation/dependency directories. Upgrades require reviewing
a new pin first, not an automatic `git pull`.

APHR installs missing/unsatisfied **upstream manifest** dependencies with npm
without lifecycle scripts, replacing no manifest or lockfile. TypeScript runs
through upstream's declared `tsx` dependency; no upstream build/start command or
native SQLite build is needed. Tarot uses its own `.venv` and pip installs only
missing/unsatisfied requirements from `bot\requirements.txt` (wheels only).
Repeated installation does not upgrade already satisfied dependencies. Caches and
installation work stay under `.creations-bots`.

On Windows, a Store `python.exe` alias is **not** a working interpreter. The
installer also discovers an already installed Python through `py -3` or
`uv python find`. Once installed, the host launches the fixed checkout executable
`.creations-bots\tarot\.venv\Scripts\python.exe`, **not** `python` from PATH.
No global PATH, service, or globally installed SDK changes are required.

The installer first removes any previous readiness marker, checks dependencies,
and runs each actual worker's deterministic safety path **without a provider
key/call**. Only after success and a final clean-source check does it create:

- `.creations-bots\aphr\.creations-worker-ready.json`
- `.creations-bots\tarot\.creations-worker-ready.json`

Each contains exactly these fields (APHR example):

```json
{
  "schemaVersion": 1,
  "status": "ready",
  "protocol": "creations-bots-json-v1",
  "worker": "aphr",
  "repository": "https://github.com/radiann-kswg/APHRNTs_100.git",
  "commit": "ea5da87364f407535b772fcad07df7d249b0b400"
}
```

For Tarot, `worker` is `tarot`, `repository` is
`https://github.com/radiann-kswg/Tarot-byFateLineDealer.git`, and `commit` is
`a94c2e72861aa66d6c7abcbc351367fea88cdf72`. The host must check marker
contents against these known values and, for Tarot, the fixed Python executable,
not just checkout-directory presence. A marker is installation evidence, not
tamper protection; missing dependencies/changed checkouts require reinstalling.
Never use marker contents to select arbitrary executable paths.

Supply keys to the host through its environment/secret manager, never in the
request, checkout files, CLI arguments or committed configuration. Workers receive:

- `ANTHROPIC_API_KEY`: the selected Anthropic provider's exact upstream key name.
- `CREATIONS_BOT_MODEL` (optional): model override. Defaults preserve the reviewed
  upstreams: APHR `claude-sonnet-5`, Tarot `claude-opus-4-8`. A changed model must
  support the upstream request shape (Tarot uses adaptive thinking/output effort).

Both SDK clients use the fixed Anthropic HTTPS endpoint, a 30-second request
timeout and no SDK retries. Neither worker accepts an API URL, plugin, command,
checkout path, provider name, Misskey host or token in its input.

## Host protocol

Fixed invocations, with the working directory set to the repository root:

```powershell
node scripts\creations-bots\aphr.mjs
.creations-bots\tarot\.venv\Scripts\python.exe scripts\creations-bots\tarot.py
```

For the parent's `worker.ts` (which already imports `resolve`), replace only its
`executable` assignment:

```typescript
const executable = bot === 'aphr'
  ? process.execPath
  : resolve(root, '.creations-bots', 'tarot', '.venv',
      process.platform === 'win32' ? 'Scripts' : 'bin',
      process.platform === 'win32' ? 'python.exe' : 'python');
```

Keep the fixed worker arguments, repo-root cwd, restricted environment and
`shell: false`. On POSIX, the corresponding fixed executable is
`.creations-bots/tarot/.venv/bin/python`.

Write one UTF-8 JSON object to stdin, then **close stdin**:

```json
{"text":"今日はどう過ごせばよいですか","reference":"","context":[{"role":"user","content":"こんにちは"},{"role":"assistant","content":"こんにちは、今日はどんなお話？"}]}
```

Successful stdout is exactly one JSON result and a newline; exit status is zero:

```json
{"text":"response text"}
```

Errors return nonzero, no stdout, and a fixed diagnostic without raw provider
exceptions, stderr or credentials. Dependency output is discarded. The host must
enforce its own process deadline, output cap and budget, and must not post anything
from failed workers. This subprocess boundary is **not an OS security sandbox**.
Only the reviewed, pinned upstream modules are supported.

Schema limits: 256 KiB UTF-8 input; nonempty `text` up to 16,384 characters;
`reference` up to 32,768; at most 24 context messages, each nonempty, up to 16,384,
with only `user`/`assistant` roles. No extra fields or rich/multimodal content.
Output is nonempty text up to 32,768 characters. Limits are defensive IPC limits,
not replacements for host budgets.

`reference` is **request-scoped, parent-permission-validated, text-only RP
reference**. Leave it empty without permission. The adapters never load APHR's
`.roleplay-datas\roleplay-prompt.md` or Tarot's `roleplay.instructions.md`,
including when reference is empty. Do not supply images/designs, unpublished
settings or training inputs. These are inference calls only, not a training or
fine-tuning workflow. Provider retention/use terms still require host consent.
There is no character-name allowlist, alias lookup or name-triggered file access:
both workers accept any parent-approved text verbatim. Source character labels
are APHR `100(モモ)` and Tarot `錦野舞`; alternative typography/approved names also
work. The parent, not the workers, validates which reference belongs to which
character and whether it is permitted.

## What is actually reused

- **APHR** imports real `createMessagePipeline`, `buildSystemPrompt`,
  crisis/safety rules, CBT guides and `createAnthropicProvider`. The supplied
  reference replaces the loader's old RP prompt. History comes exclusively from
  the request. Stateless host ports replace persistent stores/rate limiting;
  tools are not advertised, and attempted tool calls/XML leakage fail closed.
  Upstream deterministic crisis replies still work without a paid call. There
  are no SQLite records, preference changes, bridge sync, receive loops,
  schedulers, or posting clients. The upstream hotline-opt-out suggestion is not
  a supported preference operation in this stateless adapter.
- **Tarot** uses real `safety.screen`, templates, `choose_spread`, cryptographic
  `shuffle.draw` through `bot.tarot.draw`, deck entries and `reading.generate`.
  The cards are genuinely drawn once, never chosen by the model. A scoped SDK
  port adds host history; a scoped SSOT port replaces the old RP source with the
  approved reference. Upstream safety/reading rules, procedure and spread data
  remain intact. Safety/roleplay-stop templates require no paid call.
  No `bot.main`, `daily`, `misskey`, `state`, rendering, image reads/uploads,
  reading persistence or posting routines run. Rendering is intentionally omitted:
  the result is text only, not the upstream bot's image-attached post.

Tarot's current upstream API lacks explicit prompt/history injection; the scoped
ports are limited to this one subprocess request and restored afterwards, with
the prompt cache cleared. A future upstream `generate(..., system, messages,
client)` interface would eliminate those ports. No indispensable upstream code
change is required for the pinned versions.

## Offline-provider integration tests

Install the reviewed upstreams first. Tests use their real functions with mocked
Anthropic SDK responses; **no paid provider calls** or real Misskey requests:

```powershell
node --test scripts\creations-bots\aphr.test.mjs scripts\creations-bots\install.test.mjs
.creations-bots\tarot\.venv\Scripts\python.exe -B scripts\creations-bots\test_tarot.py
```

On POSIX, the Python test interpreter is `.creations-bots/tarot/.venv/bin/python`.
Tests check real SDK request shapes, default/overridden models, history/reference
isolation, upstream safety, real unique card draws, disabled storage/tools and
receive/post services, forbidden legacy-RP/secret/image reads, exact one-shot
stdio, sanitized failures, and production entrypoints on the no-paid safety path.
`test-aphr-stdio.mjs` and `test_tarot_stdio.py` are test-only subprocess drivers,
never runtime worker choices.
