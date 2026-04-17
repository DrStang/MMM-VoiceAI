/* node_helper.js – MMM-VoiceAI
 * Backend: openWakeWord (Python) for wake word detection,
 * audio capture via arecord/rec, OpenAI Whisper/GPT/TTS pipeline,
 * audio playback via mpv/ffplay/aplay.
 */

const NodeHelper = require("node_helper");
const { exec, spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const https = require("https");
const FormData = require("form-data");

module.exports = NodeHelper.create({
  name: "MMM-VoiceAI",

  start() {
    console.log(`[MMM-VoiceAI] Node helper started`);
    this.config = null;
    this.wakeWordProcess = null;
    this.isProcessing = false;
    this.conversationHistory = [];
    this.audioDir = path.join(__dirname, "audio_tmp");
    if (!fs.existsSync(this.audioDir)) {
      fs.mkdirSync(this.audioDir, { recursive: true });
    }
  },

  socketNotificationReceived(notification, payload) {
    switch (notification) {
      case "INIT":
        this.config = payload;
        this._loadApiKey().then(() => {
          this._startWakeWordService();
        });
        break;

      case "FORCE_ACTIVATE":
        this._onWakeWordDetected();
        break;
    }
  },

  // ─── API Key ───────────────────────────────────────────────
  async _loadApiKey() {
    if (process.env.OPENAI_API_KEY) {
      this.apiKey = process.env.OPENAI_API_KEY;
      return;
    }
    const envFile = path.join(__dirname, ".env");
    if (fs.existsSync(envFile)) {
      const content = fs.readFileSync(envFile, "utf8");
      const match = content.match(/OPENAI_API_KEY\s*=\s*(.+)/);
      if (match) {
        this.apiKey = match[1].trim().replace(/^["']|["']$/g, "");
        return;
      }
    }
    console.error("[MMM-VoiceAI] No OPENAI_API_KEY found! Set it in environment or .env file.");
    this.apiKey = null;
  },

  // ─── openWakeWord Service ──────────────────────────────────

  _startWakeWordService() {
    if (this.wakeWordProcess) {
      this.wakeWordProcess.kill();
      this.wakeWordProcess = null;
    }

    const scriptPath = path.join(__dirname, "wake_word_service.py");
    
    // Resolve model path - if it's just a filename, look in the module dir
    let modelPath = this.config.wakeWordModel || "hey_jarvis";
    if (!path.isAbsolute(modelPath) && (modelPath.endsWith(".tflite") || modelPath.endsWith(".onnx"))) {
      modelPath = path.join(__dirname, modelPath);
    }
    
    const args = [
      scriptPath,
      "--model", modelPath,
      "--threshold", String(this.config.wakeWordThreshold || 0.5),
      "--cooldown", String(this.config.wakeWordCooldown || 3.0),
    ];

    // Pass ALSA device if configured
    if (this.config.alsaCaptureDevice) {
      args.push("--device", this.config.alsaCaptureDevice);
    }

    if (this.config.wakeWordDebug) {
      args.push("--debug");
    }

    // Use venv python if available, otherwise system python
    const venvPython = path.join(__dirname, "venv", "bin", "python3");
    const pythonBin = fs.existsSync(venvPython) ? venvPython : "python3";

    console.log(`[MMM-VoiceAI] Starting openWakeWord: ${pythonBin} ${args.join(" ")}`);

    this._autoRestart = true;
    this.wakeWordProcess = spawn(pythonBin, args, {
      cwd: __dirname,
      env: { ...process.env },
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
    });

    console.log(`[MMM-VoiceAI] Wake word PID: ${this.wakeWordProcess.pid}`);

    // ── Handle stdout (detection events) ──
    let lineBuffer = "";
    this.wakeWordProcess.stdout.on("data", (data) => {
      lineBuffer += data.toString();
      const lines = lineBuffer.split("\n");
      lineBuffer = lines.pop(); // keep incomplete line in buffer

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        if (trimmed === "READY") {
          console.log("[MMM-VoiceAI] openWakeWord service ready");
          this.sendSocketNotification("READY", {});
          this.sendSocketNotification("STATE_CHANGE", { state: "LISTENING_WAKE" });
        } else if (trimmed.startsWith("WAKE_DETECTED:")) {
          // Format: WAKE_DETECTED:model_name:score
          const parts = trimmed.split(":");
          const model = parts[1] || "unknown";
          const score = parseFloat(parts[2]) || 0;
          console.log(`[MMM-VoiceAI] Wake word detected: ${model} (${score.toFixed(3)})`);

          if (!this.isProcessing) {
            this._onWakeWordDetected();
          }
        }
      }
    });

    // ── Handle stderr (debug/info logs) ──
    this.wakeWordProcess.stderr.on("data", (data) => {
      const msg = data.toString().trim();
      if (msg) {
        console.log(`[MMM-VoiceAI:oww] ${msg}`);
      }
    });

    // ── Handle process exit ──
    this.wakeWordProcess.on("close", (code) => {
      console.log(`[MMM-VoiceAI] openWakeWord process exited with code ${code}`);
      this.wakeWordProcess = null;

      // Auto-restart after a delay (unless deliberately stopped)
      if (this.config && this._autoRestart !== false) {
        console.log("[MMM-VoiceAI] Restarting openWakeWord in 5s...");
        setTimeout(() => this._startWakeWordService(), 5000);
      }
    });

    this.wakeWordProcess.on("error", (err) => {
      console.error(`[MMM-VoiceAI] Failed to start openWakeWord: ${err.message}`);
      this.sendSocketNotification("ERROR", {
        message: "Failed to start wake word service. Is openWakeWord installed?",
      });
    });
  },

  // ─── Stop/Restart wake word during interaction ─────────────

  _stopWakeWord() {
    return new Promise((resolve) => {
      if (this.wakeWordProcess) {
        this._autoRestart = false; // prevent auto-restart on close
        const proc = this.wakeWordProcess;
        
        proc.on("close", () => {
          this.wakeWordProcess = null;
          // Small delay to ensure ALSA device is fully released
          setTimeout(resolve, 300);
        });

        // Kill the entire process group (Python + arecord child)
        try {
          process.kill(-proc.pid, "SIGTERM");
        } catch (e) {
          try { proc.kill("SIGTERM"); } catch (e2) { /* ignore */ }
        }

        // Force kill after 1 second if still alive
        setTimeout(() => {
          try { proc.kill("SIGKILL"); } catch (e) { /* ignore */ }
          resolve();
        }, 1000);
      } else {
        resolve();
      }
    });
  },

  _restartWakeWord() {
    this._autoRestart = true;
    this._startWakeWordService();
  },

  // ─── Voice Interaction Pipeline ────────────────────────────

  async _onWakeWordDetected() {
    if (this.isProcessing) return;
    this.isProcessing = true;

    // Kill wake word listener to free the mic
    await this._stopWakeWord();

    this.sendSocketNotification("WAKE_WORD_DETECTED", {});

    try {
      // Play a confirmation chime
      await this._playChime("activate");

      // Record the user's prompt (with silence detection)
      const promptPath = path.join(this.audioDir, "user_prompt.wav");
      this.sendSocketNotification("STATE_CHANGE", { state: "RECORDING" });
      await this._recordWithSilenceDetection(promptPath);

      // Transcribe the prompt
      this.sendSocketNotification("STATE_CHANGE", { state: "PROCESSING" });
      const userText = await this._transcribeAudio(promptPath);
      console.log(`[MMM-VoiceAI] User said: "${userText}"`);
      this.sendSocketNotification("USER_TRANSCRIPT", { text: userText });

      // Get GPT response
      const aiText = await this._getChatResponse(userText);
      console.log(`[MMM-VoiceAI] AI response: "${aiText}"`);
      this.sendSocketNotification("AI_RESPONSE", { text: aiText });

      // Convert response to speech and play
      const speechPath = path.join(this.audioDir, "response.mp3");
      this.sendSocketNotification("STATE_CHANGE", { state: "SPEAKING" });
      await this._textToSpeech(aiText, speechPath);
      await this._playAudio(speechPath);

      this.sendSocketNotification("PLAYBACK_COMPLETE", {});
    } catch (err) {
      console.error("[MMM-VoiceAI] Pipeline error:", err.message);
      this.sendSocketNotification("ERROR", { message: err.message });
    }

    // Restart wake word listener
    this.isProcessing = false;
    this._restartWakeWord();
    this.sendSocketNotification("STATE_CHANGE", { state: "LISTENING_WAKE" });
  },

  // ─── Audio Recording ───────────────────────────────────────

  // Records using arecord piped to raw stdout, monitors audio energy,
  // and stops after silence is detected. Saves to WAV file.
  _recordWithSilenceDetection(outputPath) {
    return new Promise((resolve, reject) => {
      const device = this.config.alsaCaptureDevice || "default";
      const maxMs = this.config.maxRecordingTime || 30000;
      const silenceMs = this.config.silenceTimeout || 2000;
      const silenceThreshold = this.config.silenceThreshold || 500;

      console.log(`[MMM-VoiceAI] Recording with silence detection: device=${device}, silenceTimeout=${silenceMs}ms, maxTime=${maxMs}ms`);

      // Record raw PCM to stdout so we can monitor energy levels
      const proc = spawn("arecord", [
        "-D", device,
        "-f", "S16_LE",
        "-r", "16000",
        "-c", "1",
        "-t", "raw",
      ]);

      const chunks = [];
      let totalBytes = 0;
      let lastSoundTime = Date.now();
      let hasHeardSpeech = false;
      let stderrOutput = "";

      proc.stderr.on("data", (data) => {
        stderrOutput += data.toString();
      });

      proc.stdout.on("data", (data) => {
        chunks.push(data);
        totalBytes += data.length;

        // Calculate RMS energy of this chunk (16-bit signed samples)
        let energy = 0;
        const samples = data.length / 2;
        for (let i = 0; i < data.length - 1; i += 2) {
          const sample = data.readInt16LE(i);
          energy += sample * sample;
        }
        const rms = Math.sqrt(energy / samples);

        if (rms > silenceThreshold) {
          lastSoundTime = Date.now();
          if (!hasHeardSpeech) {
            hasHeardSpeech = true;
            console.log(`[MMM-VoiceAI] Speech detected (RMS=${rms.toFixed(0)})`);
          }
        }

        const now = Date.now();

        // Stop if we heard speech and then silence for silenceTimeout
        if (hasHeardSpeech && (now - lastSoundTime > silenceMs)) {
          console.log(`[MMM-VoiceAI] Silence detected after speech, stopping recording`);
          proc.kill("SIGTERM");
        }
      });

      proc.on("close", () => {
        if (totalBytes === 0) {
          if (stderrOutput) console.log(`[MMM-VoiceAI] arecord stderr: ${stderrOutput.trim()}`);
          return reject(new Error("Recording captured no audio"));
        }

        // Write raw PCM data as a proper WAV file
        try {
          const pcmData = Buffer.concat(chunks);
          const wavHeader = this._createWavHeader(pcmData.length, 16000, 1, 16);
          fs.writeFileSync(outputPath, Buffer.concat([wavHeader, pcmData]));
          const durationSec = (pcmData.length / (16000 * 2)).toFixed(1);
          console.log(`[MMM-VoiceAI] Recording saved: ${outputPath} (${durationSec}s, ${pcmData.length} bytes)`);
          resolve(outputPath);
        } catch (err) {
          reject(new Error(`Failed to write WAV: ${err.message}`));
        }
      });

      proc.on("error", (err) => {
        reject(new Error(`arecord not found: ${err.message}`));
      });

      // Hard timeout
      setTimeout(() => {
        console.log("[MMM-VoiceAI] Max recording time reached, stopping");
        proc.kill("SIGTERM");
      }, maxMs);
    });
  },

  _createWavHeader(dataSize, sampleRate, channels, bitsPerSample) {
    const header = Buffer.alloc(44);
    const byteRate = sampleRate * channels * (bitsPerSample / 8);
    const blockAlign = channels * (bitsPerSample / 8);

    header.write("RIFF", 0);
    header.writeUInt32LE(36 + dataSize, 4);
    header.write("WAVE", 8);
    header.write("fmt ", 12);
    header.writeUInt32LE(16, 16);           // subchunk size
    header.writeUInt16LE(1, 20);            // PCM format
    header.writeUInt16LE(channels, 22);
    header.writeUInt32LE(sampleRate, 24);
    header.writeUInt32LE(byteRate, 28);
    header.writeUInt16LE(blockAlign, 32);
    header.writeUInt16LE(bitsPerSample, 34);
    header.write("data", 36);
    header.writeUInt32LE(dataSize, 40);

    return header;
  },

  // ─── OpenAI: Whisper STT ───────────────────────────────────

  _transcribeAudio(filePath) {
    return new Promise((resolve, reject) => {
      if (!this.apiKey) return reject(new Error("No API key configured"));

      const form = new FormData();
      form.append("file", fs.createReadStream(filePath));
      form.append("model", this.config.whisperModel);
      form.append("language", "en");

      const options = {
        hostname: "api.openai.com",
        path: "/v1/audio/transcriptions",
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          ...form.getHeaders(),
        },
      };

      const req = https.request(options, (res) => {
        let body = "";
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => {
          try {
            const result = JSON.parse(body);
            if (result.error) {
              reject(new Error(result.error.message));
            } else {
              resolve(result.text || "");
            }
          } catch (e) {
            reject(new Error("Failed to parse Whisper response"));
          }
        });
      });

      req.on("error", reject);
      form.pipe(req);
    });
  },

  // ─── OpenAI: Chat Completion ───────────────────────────────

  _getChatResponse(userText) {
    return new Promise((resolve, reject) => {
      if (!this.apiKey) return reject(new Error("No API key configured"));

      const messages = [
        { role: "system", content: this.config.systemPrompt },
      ];

      for (const entry of this.conversationHistory) {
        messages.push({ role: "user", content: entry.user });
        messages.push({ role: "assistant", content: entry.assistant });
      }

      messages.push({ role: "user", content: userText });

      const payload = JSON.stringify({
        model: this.config.openaiModel,
        messages,
        max_tokens: this.config.maxTokens,
        temperature: 0.7,
      });

      const options = {
        hostname: "api.openai.com",
        path: "/v1/chat/completions",
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
        },
      };

      const req = https.request(options, (res) => {
        let body = "";
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => {
          try {
            const result = JSON.parse(body);
            if (result.error) {
              reject(new Error(result.error.message));
              return;
            }
            const text = result.choices[0].message.content.trim();

            this.conversationHistory.push({ user: userText, assistant: text });
            if (this.conversationHistory.length > this.config.conversationHistory) {
              this.conversationHistory.shift();
            }

            resolve(text);
          } catch (e) {
            reject(new Error("Failed to parse GPT response"));
          }
        });
      });

      req.on("error", reject);
      req.write(payload);
      req.end();
    });
  },

  // ─── OpenAI: TTS ───────────────────────────────────────────

  _textToSpeech(text, outputPath) {
    return new Promise((resolve, reject) => {
      if (!this.apiKey) return reject(new Error("No API key configured"));

      const payload = JSON.stringify({
        model: this.config.ttsModel,
        input: text,
        voice: this.config.ttsVoice,
        response_format: "mp3",
      });

      const options = {
        hostname: "api.openai.com",
        path: "/v1/audio/speech",
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
        },
      };

      const req = https.request(options, (res) => {
        if (res.statusCode !== 200) {
          let body = "";
          res.on("data", (chunk) => (body += chunk));
          res.on("end", () => reject(new Error(`TTS error: ${body}`)));
          return;
        }

        const fileStream = fs.createWriteStream(outputPath);
        res.pipe(fileStream);
        fileStream.on("finish", () => {
          fileStream.close();
          resolve(outputPath);
        });
      });

      req.on("error", reject);
      req.write(payload);
      req.end();
    });
  },

  // ─── Audio Playback ────────────────────────────────────────

  _playAudio(filePath) {
    return new Promise((resolve, reject) => {
      const vol = this.config.ttsVolume || 200;
      const players = [
        { cmd: "mpv", args: ["--no-video", "--really-quiet", `--volume=${vol}`, filePath] },
        { cmd: "ffplay", args: ["-nodisp", "-autoexit", "-loglevel", "quiet", "-volume", String(vol), filePath] },
        { cmd: "aplay", args: [filePath] },
      ];

      const tryPlayer = (index) => {
        if (index >= players.length) {
          return reject(new Error("No audio player available"));
        }

        const { cmd, args } = players[index];
        const proc = spawn(cmd, args);

        proc.on("error", () => tryPlayer(index + 1));
        proc.on("close", () => resolve());
      };

      tryPlayer(0);
    });
  },

  _playChime(type) {
    return new Promise((resolve) => {
      const chimePath = path.join(this.audioDir, "chime.wav");
      const freq = type === "activate" ? 880 : 440;

      exec(
        `sox -n ${chimePath} synth 0.15 sine ${freq} fade 0 0.15 0.05 vol 0.3 2>/dev/null`,
        (err) => {
          if (err) return resolve();
          this._playAudio(chimePath).then(resolve).catch(resolve);
        }
      );
    });
  },

  // ─── Cleanup ───────────────────────────────────────────────

  stop() {
    if (this.wakeWordProcess) {
      this.wakeWordProcess.kill("SIGTERM");
      this.wakeWordProcess = null;
    }
  },
});
