# Interview Analyzer

Privacy-first local LLM system for qualitative analysis of ethnographic interview corpora.

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

## Setup

1. Install [Ollama for Windows](https://ollama.com/download/windows)
2. Pull a model: `ollama pull <model>`
3. (If needed) Set `OLLAMA_HOST=0.0.0.0` in Ollama's Windows config so WSL can reach it
4. In WSL: `uv sync && uv run python main.py`

## Design Principles

- **Local-only**: all inference runs on-device
- **Privacy-first**: no API calls to external services
- **Quality over speed**: batch analysis, not real-time chat — prioritize model quality
