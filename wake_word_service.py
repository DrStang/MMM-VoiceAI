#!/usr/bin/env python3
"""
wake_word_service.py – openWakeWord listener for MMM-VoiceAI

Continuously listens on the default ALSA capture device and prints
"WAKE_DETECTED" to stdout when the configured wake word is heard.
The Node.js node_helper spawns this process and watches stdout.

Usage:
  python3 wake_word_service.py [--model hey_jarvis] [--threshold 0.5] [--chunk_size 1280]

Pre-trained models included with openWakeWord:
  - hey_jarvis (recommended for "Hey Jarvis")
  - alexa
  - hey_mycroft
  - hey_rhasspy
  - current_weather / timer

Custom .tflite or .onnx model paths are also accepted via --model.
"""

import sys
import argparse
import struct
import subprocess
import time
import numpy as np

def main():
    parser = argparse.ArgumentParser(description="openWakeWord listener service")
    parser.add_argument("--model", type=str, default="hey_jarvis",
                        help="Model name or path to .tflite/.onnx file")
    parser.add_argument("--threshold", type=float, default=0.5,
                        help="Detection threshold (0.0–1.0, default 0.5)")
    parser.add_argument("--chunk_size", type=int, default=1280,
                        help="Audio chunk size in samples (default 1280 = 80ms at 16kHz)")
    parser.add_argument("--cooldown", type=float, default=3.0,
                        help="Seconds to wait after detection before listening again")
    parser.add_argument("--device", type=str, default=None,
                        help="ALSA capture device (e.g. plughw:3,0). None = default")
    parser.add_argument("--debug", action="store_true",
                        help="Print score values for debugging")
    args = parser.parse_args()

    # ── Import openWakeWord ──────────────────────────────
    try:
        import openwakeword
        from openwakeword.model import Model
    except ImportError:
        print("ERROR: openwakeword not installed. Run: pip install openwakeword", file=sys.stderr)
        sys.exit(1)

    # ── Download models if needed ────────────────────────
    print("INIT: Downloading/checking models...", file=sys.stderr)
    try:
        openwakeword.utils.download_models()
    except Exception as e:
        print(f"WARN: Model download issue: {e}", file=sys.stderr)

    # ── Load model ───────────────────────────────────────
    model_arg = args.model
    if model_arg.endswith(".tflite") or model_arg.endswith(".onnx"):
        oww_model = Model(wakeword_models=[model_arg])
    else:
        oww_model = Model(wakeword_models=[model_arg])

    # models.keys() is reliable; prediction_buffer may be empty for custom models
    model_names = list(oww_model.models.keys())
    if not model_names:
        model_names = list(oww_model.prediction_buffer.keys())
    print(f"INIT: Loaded models: {model_names}", file=sys.stderr)

    # ── Open audio stream via arecord (no pyaudio dependency) ──
    # arecord outputs raw S16_LE mono 16kHz PCM to stdout
    arecord_cmd = [
        "arecord",
        "-f", "S16_LE",
        "-r", "16000",
        "-c", "1",
        "-t", "raw",
        "--buffer-size=4096",
    ]
    if args.device:
        arecord_cmd.extend(["-D", args.device])

    print(f"INIT: Starting audio capture: {' '.join(arecord_cmd)}", file=sys.stderr)

    try:
        mic_proc = subprocess.Popen(
            arecord_cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL
        )
    except FileNotFoundError:
        print("ERROR: arecord not found. Install alsa-utils.", file=sys.stderr)
        sys.exit(1)

    bytes_per_chunk = args.chunk_size * 2  # 16-bit = 2 bytes per sample

    print("READY", flush=True)
    print("INIT: Listening for wake word...", file=sys.stderr)

    last_detection = 0

    # ── Main detection loop ──────────────────────────────
    try:
        while True:
            raw_audio = mic_proc.stdout.read(bytes_per_chunk)
            if not raw_audio or len(raw_audio) < bytes_per_chunk:
                print("WARN: Audio stream ended or underrun", file=sys.stderr)
                time.sleep(0.1)
                continue

            # Convert raw bytes to numpy int16 array
            audio_frame = np.frombuffer(raw_audio, dtype=np.int16)

            # Run prediction
            prediction = oww_model.predict(audio_frame)

            # Check all loaded models
            for model_name in model_names:
                score = prediction.get(model_name, 0) if isinstance(prediction, dict) else 0

                if args.debug and score > 0.1:
                    print(f"DEBUG: {model_name} = {score:.4f}", file=sys.stderr)

                if score > args.threshold:
                    now = time.time()
                    if now - last_detection > args.cooldown:
                        last_detection = now
                        print(f"WAKE_DETECTED:{model_name}:{score:.4f}", flush=True)
                        print(f"DETECTED: {model_name} (score={score:.4f})", file=sys.stderr)

                        # Reset model scores to avoid repeated triggers
                        oww_model.reset()
                        break

    except KeyboardInterrupt:
        print("SHUTDOWN: Stopping wake word service", file=sys.stderr)
    finally:
        mic_proc.terminate()
        mic_proc.wait()


if __name__ == "__main__":
    main()
