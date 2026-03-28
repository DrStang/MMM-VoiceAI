# MMM-VoiceAI

A MagicMirror² module that adds a voice-activated AI assistant powered by OpenAI. Say **"Hey Mirror"** to activate, speak your question, and get a spoken response with on-screen transcription.

## How It Works

```
┌─────────────┐     ┌──────────┐     ┌──────────┐     ┌─────────┐
│ "Hey Mirror" │ ──→ │ Record   │ ──→ │ Whisper  │ ──→ │ GPT-4o  │
│ Wake Word    │     │ Prompt   │     │ STT      │     │ mini    │
└─────────────┘     └──────────┘     └──────────┘     └────┬────┘
                                                           │
                    ┌──────────┐     ┌──────────┐          │
                    │ Speaker  │ ←── │ TTS      │ ←────────┘
                    │ Playback │     │ Voice    │
                    └──────────┘     └──────────┘
```

**Pipeline:** Wake word detection → Audio recording with silence detection → Whisper transcription → GPT chat completion → TTS voice synthesis → Audio playback + on-screen transcript

## Requirements

- Raspberry Pi 3B+ or newer (Pi 4/5 recommended)
- USB microphone or USB sound card with mic input
- Speaker (3.5mm, HDMI, or USB)
- MagicMirror² installed and running
- OpenAI API key with access to Whisper, Chat, and TTS APIs
- Internet connection

## Installation

```bash
cd ~/MagicMirror/modules
git clone https://github.com/yourusername/MMM-VoiceAI.git  # or copy files manually
cd MMM-VoiceAI
bash install.sh
```

The installer will:
1. Install system audio packages (`alsa-utils`, `sox`, `mpv`, `ffmpeg`)
2. Install Node.js dependencies
3. Create a `.env` file for your API key

### Set Your API Key

```bash
nano ~/MagicMirror/modules/MMM-VoiceAI/.env
```

Replace `sk-your-api-key-here` with your actual OpenAI API key from [platform.openai.com/api-keys](https://platform.openai.com/api-keys).

## MagicMirror Configuration

Add to your `~/MagicMirror/config/config.js`:

```js
{
  module: "MMM-VoiceAI",
  position: "bottom_center",  // or any position
  config: {
    wakeWord: "hey mirror",          // Wake phrase (spoken naturally)
    openaiModel: "gpt-4o-mini",      // Chat model
    ttsVoice: "nova",                // TTS voice: alloy, echo, fable, onyx, nova, shimmer
    systemPrompt: "You are a helpful smart mirror assistant. Keep responses concise.",
    maxTokens: 300,                  // Max response length
    silenceTimeout: 2000,            // ms of silence before stopping recording
    maxRecordingTime: 30000,         // Max recording duration (ms)
    conversationHistory: 5,          // Number of exchanges to remember
    showTranscription: true,         // Show text on screen
    idleTimeout: 30000,              // Clear transcript after this long (ms)
  }
},
```

## Configuration Options

| Option | Default | Description |
|---|---|---|
| `wakeWord` | `"hey mirror"` | Phrase to activate recording |
| `openaiModel` | `"gpt-4o-mini"` | OpenAI chat model |
| `ttsModel` | `"tts-1"` | TTS model (`tts-1` or `tts-1-hd`) |
| `ttsVoice` | `"nova"` | Voice: alloy, echo, fable, onyx, nova, shimmer |
| `whisperModel` | `"whisper-1"` | Whisper STT model |
| `systemPrompt` | *(see above)* | System prompt for GPT personality |
| `maxTokens` | `300` | Maximum response tokens |
| `silenceTimeout` | `2000` | Silence (ms) before auto-stop recording |
| `maxRecordingTime` | `30000` | Hard limit on recording duration (ms) |
| `conversationHistory` | `5` | Exchanges to keep in context |
| `showTranscription` | `true` | Display transcript on mirror |
| `idleTimeout` | `30000` | Clear transcript after idle period (ms) |

## Audio Setup (Raspberry Pi)

### Find Your Devices

```bash
# List recording devices
arecord -l

# List playback devices
aplay -l
```

### Configure Default Devices

Create or edit `~/.asoundrc`:

```
pcm.!default {
  type asym
  playback.pcm "plughw:0,0"
  capture.pcm "plughw:1,0"
}
```

Adjust card/device numbers to match your hardware from the `arecord -l` / `aplay -l` output.

### Test Audio

```bash
# Record 3 seconds
arecord -f S16_LE -r 16000 -c 1 -d 3 test.wav

# Play it back
aplay test.wav
```

## Visual States

The module displays an animated orb that changes color/behavior based on state:

| State | Orb Color | Behavior |
|---|---|---|
| **Listening** | Blue pulse | Waiting for "Hey Mirror" |
| **Recording** | Cyan glow + waveform | Capturing your voice |
| **Processing** | Amber spin | Sending to OpenAI |
| **Speaking** | Green + waveform | Playing AI response |

## API Cost Estimates

Per interaction (approximate, as of 2025):
- Whisper STT: ~$0.006/minute of audio
- GPT-4o-mini: ~$0.00015 per 1K input tokens, $0.0006 per 1K output tokens
- TTS: ~$0.015 per 1K characters

A typical exchange costs roughly **$0.01–0.03**. The wake word detection loop uses short 2-second Whisper calls which add ~$0.0002 each — at one check every ~3 seconds, that's about **$0.24/hour** of idle listening.

### Reducing Wake Word Costs

For heavy use, consider replacing the Whisper-based wake word loop with a local keyword spotter:
- **Porcupine** (Picovoice) — free tier, very accurate, custom wake words
- **openWakeWord** — fully open-source, runs on Pi
- **Snowboy** (archived but functional)

## Troubleshooting

**No microphone detected:** Make sure a USB mic is plugged in. Run `arecord -l` to verify.

**"No API key" error:** Check that `.env` exists in the module folder and contains a valid key.

**Audio plays but no recording works:** Your ALSA default may point to the wrong capture device. Edit `~/.asoundrc`.

**sox/rec not found warnings:** The module falls back to `arecord` with a fixed timeout. Install sox for silence-based auto-stop: `sudo apt-get install sox`

**Wake word not detecting:** Speak clearly and naturally. You can adjust `wakeWord` to something your mic picks up more reliably. Check the MagicMirror logs for what Whisper is hearing: `pm2 logs MagicMirror`

## License

MIT
