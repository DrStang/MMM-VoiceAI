# MMM-VoiceAI

A MagicMirror² module that adds a voice-activated AI assistant powered by OpenAI. Say **"Hey Jarvis"** to activate, speak your question, and get a spoken response with on-screen transcription.

Wake word detection runs **locally** via [openWakeWord](https://github.com/dscripka/openWakeWord) — zero API cost, low CPU. Only the actual voice interaction (transcription, chat, speech) hits OpenAI.

## How It Works

```
┌──────────────┐     ┌──────────┐     ┌──────────┐     ┌─────────┐
│ "Hey Jarvis"  │ ──→ │ Record   │ ──→ │ Whisper  │ ──→ │ GPT-4o  │
│ openWakeWord  │     │ Prompt   │     │ STT      │     │ mini    │
│ (local/free)  │     │ (sox)    │     │ (API)    │     │ (API)   │
└──────────────┘     └──────────┘     └──────────┘     └────┬────┘
                                                            │
                     ┌──────────┐     ┌──────────┐         │
                     │ Speaker  │ ←── │ TTS      │ ←───────┘
                     │ Playback │     │ (API)    │
                     └──────────┘     └──────────┘
```

## Requirements

- Raspberry Pi 3B+ or newer (Pi 4/5 recommended)
- USB microphone
- Speaker (HDMI, 3.5mm, or USB)
- MagicMirror² installed and running
- OpenAI API key (for Whisper, Chat, and TTS)
- Internet connection
- Python 3.7+

## Installation

```bash
cd ~/MagicMirror/modules
git clone https://github.com/yourusername/MMM-VoiceAI.git
cd MMM-VoiceAI
chmod +x install.sh
bash install.sh
```

The installer will:
1. Install system audio packages (`alsa-utils`, `sox`, `mpv`, `ffmpeg`)
2. Create a Python venv and install openWakeWord
3. Download pre-trained wake word models
4. Install Node.js dependencies
5. Create a `.env` file for your API key

### Set Your API Key

```bash
nano ~/MagicMirror/modules/MMM-VoiceAI/.env
```

Replace `sk-your-api-key-here` with your OpenAI API key.

## MagicMirror Configuration

Add to `~/MagicMirror/config/config.js`:

```js
{
  module: "MMM-VoiceAI",
  position: "bottom_center",
  config: {
    wakeWordModel: "hey_jarvis",   // or: alexa, hey_mycroft, hey_rhasspy
    wakeWordThreshold: 0.5,        // 0.0–1.0, higher = less sensitive
    openaiModel: "gpt-4o-mini",
    ttsVoice: "nova",              // alloy, echo, fable, onyx, nova, shimmer
    showTranscription: true,
  }
},
```

## Configuration Options

| Option | Default | Description |
|---|---|---|
| **Wake Word (local)** | | |
| `wakeWordModel` | `"hey_jarvis"` | Model name or path to custom `.tflite`/`.onnx` |
| `wakeWordThreshold` | `0.5` | Detection threshold (0.0–1.0) |
| `wakeWordCooldown` | `3.0` | Seconds between detections |
| `wakeWordDebug` | `false` | Log detection scores to console |
| `alsaCaptureDevice` | `null` | ALSA device (e.g. `"plughw:3,0"`), null = default |
| **OpenAI** | | |
| `openaiModel` | `"gpt-4o-mini"` | Chat model |
| `ttsModel` | `"tts-1"` | TTS model (`tts-1` or `tts-1-hd`) |
| `ttsVoice` | `"nova"` | Voice: alloy, echo, fable, onyx, nova, shimmer |
| `whisperModel` | `"whisper-1"` | Whisper STT model |
| `systemPrompt` | *(see code)* | System prompt for GPT personality |
| `maxTokens` | `300` | Maximum response tokens |
| **Recording** | | |
| `silenceTimeout` | `2000` | Silence (ms) before auto-stop recording |
| `maxRecordingTime` | `30000` | Hard limit on recording (ms) |
| **UI** | | |
| `conversationHistory` | `5` | Exchanges kept in context |
| `showTranscription` | `true` | Display transcript on mirror |
| `idleTimeout` | `30000` | Clear transcript after idle (ms) |

## Available Wake Word Models

openWakeWord ships with several pre-trained models:

| Model | Wake Phrase |
|---|---|
| `hey_jarvis` | "Hey Jarvis" |
| `alexa` | "Alexa" |
| `hey_mycroft` | "Hey Mycroft" |
| `hey_rhasspy` | "Hey Rhasspy" |

You can also train custom models — see the [openWakeWord docs](https://github.com/dscripka/openWakeWord).

## Testing Wake Word Standalone

```bash
cd ~/MagicMirror/modules/MMM-VoiceAI
source venv/bin/activate
python3 wake_word_service.py --debug
```

You should see `READY` and then score values when you speak. Say "Hey Jarvis" and look for `WAKE_DETECTED` in the output.

## Audio Setup (Raspberry Pi)

### ALSA Config (~/.asoundrc)

Example for GeeekPi HDMI display + USB mic:

```
pcm.!default {
  type asym
  playback.pcm "sysdefault:CARD=vc4hdmi0"
  capture.pcm "plughw:CARD=Device,DEV=0"
}

ctl.!default {
  type hw
  card vc4hdmi0
}
```

### Test Audio

```bash
# Record 3 seconds from USB mic
arecord -f S16_LE -r 16000 -c 1 -d 3 /tmp/test.wav

# Play through HDMI speakers
aplay -D sysdefault:CARD=vc4hdmi0 /tmp/test.wav
```

## Visual States

| State | Orb Color | Behavior |
|---|---|---|
| **Listening** | Blue pulse | Waiting for wake word |
| **Recording** | Cyan glow + waveform | Capturing your voice |
| **Processing** | Amber spin | Sending to OpenAI |
| **Speaking** | Green + waveform | Playing AI response |

## API Cost

Wake word detection is **free** (runs locally). Per voice interaction:
- Whisper STT: ~$0.006/min
- GPT-4o-mini: ~$0.001 per exchange
- TTS: ~$0.015 per 1K characters

A typical exchange costs roughly **$0.01–0.03**.

## Troubleshooting

**openWakeWord won't start:** Make sure the venv exists: `ls modules/MMM-VoiceAI/venv/bin/python3`. If not, re-run `bash install.sh`.

**Wake word not detecting:** Run with `--debug` flag to see scores. Try lowering `wakeWordThreshold` to `0.3`. Make sure your mic is working: `arecord -d 3 /tmp/test.wav`.

**No sound from speakers:** Check your `.asoundrc` playback device. Test with `speaker-test -D sysdefault:CARD=vc4hdmi0 -t wav`.

**HDMI audio not working:** Make sure HDMI audio is enabled: `sudo raspi-config` → System Options → Audio → HDMI.

## License

MIT
