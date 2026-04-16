#!/bin/bash
# MMM-VoiceAI Installation Script for Raspberry Pi
# Run from the MMM-VoiceAI module directory

set -e

echo "╔══════════════════════════════════════════╗"
echo "║       MMM-VoiceAI Installer              ║"
echo "╚══════════════════════════════════════════╝"

# ── System dependencies ──────────────────────────
echo ""
echo "→ Installing system audio packages..."
sudo apt-get update -qq
sudo apt-get install -y -qq \
  alsa-utils \
  sox \
  libsox-fmt-all \
  mpv \
  ffmpeg \
  python3-pip \
  python3-venv \
  portaudio19-dev \
  2>/dev/null

# ── Python virtual environment + openWakeWord ────
echo ""
echo "→ Setting up Python environment for openWakeWord..."

VENV_DIR="$(pwd)/venv"
if [ ! -d "$VENV_DIR" ]; then
  python3 -m venv "$VENV_DIR"
fi

source "$VENV_DIR/bin/activate"

echo "→ Installing openWakeWord and dependencies..."
pip install --upgrade pip setuptools wheel 2>/dev/null
pip install openwakeword numpy 2>/dev/null

# Download pre-trained models
echo "→ Downloading openWakeWord models..."
python3 -c "import openwakeword; openwakeword.utils.download_models()" 2>/dev/null || \
  echo "  ⚠ Model download had issues — will retry on first run"

deactivate

# ── npm dependencies ─────────────────────────────
echo ""
echo "→ Installing Node.js dependencies..."
npm install --production

# ── .env setup ───────────────────────────────────
if [ ! -f .env ]; then
  echo ""
  echo "→ Creating .env file from template..."
  cp .env.example .env
  echo "  ⚠  IMPORTANT: Edit .env and add your OpenAI API key!"
  echo "     nano $(pwd)/.env"
fi

# ── Test audio devices ───────────────────────────
echo ""
echo "→ Checking audio devices..."
echo "  Playback devices:"
aplay -l 2>/dev/null | grep "^card" || echo "  (none found)"
echo "  Capture devices:"
arecord -l 2>/dev/null | grep "^card" || echo "  (none found — you need a USB mic!)"

# ── Summary ──────────────────────────────────────
echo ""
echo "────────────────────────────────────────────"
echo "  Installation complete!"
echo ""
echo "  Next steps:"
echo "  1. Edit .env with your OpenAI API key"
echo "  2. Add the module to your MagicMirror config"
echo "  3. Make sure your ~/.asoundrc is configured"
echo ""
echo "  Wake word: 'Hey Jarvis' (default)"
echo "  Available models: hey_jarvis, alexa,"
echo "    hey_mycroft, hey_rhasspy"
echo ""
echo "  Test wake word standalone:"
echo "    source $(pwd)/venv/bin/activate"
echo "    python3 $(pwd)/wake_word_service.py --debug"
echo "────────────────────────────────────────────"
