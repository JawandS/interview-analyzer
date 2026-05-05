# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Privacy-first local LLM system for qualitative analysis of ethnographic interview corpora. All inference runs on-device via Ollama — no data ever leaves the machine.

## Commands

```bash
uv sync                        # install dependencies
uv run python main.py          # run the app
uv add <package>               # add a dependency
uv run pytest                  # run tests (once tests exist)
uv run pytest tests/test_foo.py::test_name  # run a single test
```

## Architecture

**LLM backend:** Ollama runs as a Windows service. Python code runs in WSL2 and connects via the Windows host gateway. The gateway IP changes on WSL restart — `main.py` detects it dynamically via `ip route show default`. Never hardcode the IP; never replace Ollama with an external API — local inference is a hard requirement.

**Target hardware:** AMD RX 7900 XTX (24GB GDDR6). Model target is 32B parameters at Q5/Q6 quantization (~20–22GB VRAM). CPU fallback via `OLLAMA_NUM_GPU=0`.

**Python version:** 3.11 (pinned in `.python-version`). Package manager is `uv`.

## Constraints

- No external API calls for inference — Ollama only
- Python 3.11+, managed with `uv`
