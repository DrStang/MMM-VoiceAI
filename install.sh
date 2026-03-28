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
  2>/dev/null

# ── Test microphone ──────────────────────────────
echo ""
echo "→ Checking audio devices..."
echo "  Playback devices:"
aplay -l 2>/dev/null | grep "^card" || echo "  (none found)"
echo "  Capture devices:"
arecord -l 2>/dev/null | grep "^card" || echo "  (none found — you need a USB mic!)"

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

# ── ALSA config hint ─────────────────────────────
echo ""
echo "────────────────────────────────────────────"
echo "  Installation complete!"
echo ""
echo "  Next steps:"
echo "  1. Edit .env with your OpenAI API key"
echo "  2. Add the module to your MagicMirror config"
echo "  3. (Optional) Configure ALSA default mic:"
echo ""
echo "     Create/edit ~/.asoundrc:"
echo "     pcm.!default {"
echo "       type asym"
echo "       playback.pcm \"plughw:0,0\""
echo "       capture.pcm \"plughw:1,0\""
echo "     }"
echo ""
echo "  4. Test your mic:  arecord -d 3 test.wav && aplay test.wav"
echo "────────────────────────────────────────────"
