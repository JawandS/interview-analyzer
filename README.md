# Interview Analyzer

Privacy-first local LLM system for qualitative analysis of ethnographic interview corpora.

## Setup

### 1. Install Ollama (Windows)

Download and install [Ollama for Windows](https://ollama.com/download/windows). It runs as a background service on port `11434`.

### 2. Open Ollama to WSL2

By default WSL2 cannot reach Windows localhost. Two steps required:

**Allow Ollama to bind on all interfaces** — set this environment variable in Windows before starting Ollama:
```
OLLAMA_HOST=0.0.0.0
```
Add it via System Properties → Environment Variables, then restart Ollama.

**Open the firewall** — run once in PowerShell as Administrator:
```powershell
New-NetFirewallRule -DisplayName "Ollama WSL" -Direction Inbound -Protocol TCP -LocalPort 11434 -Action Allow
```

**Find the Windows host IP from WSL** — `localhost` won't work, use the gateway IP instead:
```bash
ip route | grep default  # e.g. 172.31.208.1
curl http://172.31.208.1:11434/api/tags  # should return {"models":[...]}
```

Set that IP as your `OLLAMA_HOST` in `.env` or config (it can change on WSL restart).

### 3. Pull a model

```powershell
ollama pull qwen2.5:32b
```

Recommended: 32B models at Q5/Q6 (~20–22GB) fit fully on the 7900 XTX's 24GB VRAM.

### 4. Install Python dependencies

```bash
uv sync
uv run python main.py
```

---

## Purpose

Analyze a large collection of research interviews locally — no data leaves the machine. Designed for ethnographic research where participant privacy is non-negotiable.

## Architecture

### LLM Backend: Ollama (Windows) + Python (WSL)

- **Ollama** runs as a Windows service, exposing a REST API at `localhost:11434`
- **Python code** runs in WSL2, connecting to Ollama over the shared network stack
- This split keeps the dev environment clean (Linux tooling) while letting Windows own the GPU

### Target Hardware

| Component | Spec |
|-----------|------|
| GPU | AMD Radeon RX 7900 XTX (24GB GDDR6) |
| CPU | Intel Core i5-12600K |
| Board | ASUS (RDNA 3 / gfx1100) |

### Model Strategy

With 24GB VRAM the sweet spot is **32B parameter models at Q5 or Q6 quantization** (~20–22GB), which fits fully on-GPU with headroom. This outperforms cramming a 70B model at Q3 for nuanced qualitative work.

| Quantization | Bits/weight | Quality |
|-------------|-------------|---------|
| Q8 | 8-bit | Negligible loss |
| Q6 | 6-bit | Very slight loss |
| Q5 | 5-bit | Minor loss |
| Q4 | 4-bit | Acceptable |
| Q3 | 3-bit | Significant loss |

CPU inference is available as a fallback via `OLLAMA_NUM_GPU=0`.

## Design Principles

- **Local-only**: all inference runs on-device
- **Privacy-first**: no API calls to external services
- **Quality over speed**: batch analysis, not real-time chat — prioritize model quality
