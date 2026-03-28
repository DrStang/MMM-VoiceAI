/* node_helper.js – MMM-VoiceAI
 * Backend: wake-word detection via Porcupine or keyword spotting,
 * audio capture via arecord, OpenAI Whisper/GPT/TTS pipeline,
 * audio playback via aplay/ffplay.
 */

const NodeHelper = require("node_helper");
const { exec, spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const http = require("http");
const https = require("https");
const FormData = require("form-data");

module.exports = NodeHelper.create({
  name: "MMM-VoiceAI",

  start() {
    console.log(`[MMM-VoiceAI] Node helper started`);
    this.config = null;
    this.isRecording = false;
    this.wakeWordProcess = null;
    this.recordProcess = null;
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
          this._startWakeWordListener();
          this.sendSocketNotification("READY", {});
        });
        break;

      case "FORCE_ACTIVATE":
        this._onWakeWordDetected();
        break;
    }
  },

  // ─── API Key ───────────────────────────────────────────────
  async _loadApiKey() {
    // Try env var first, then .env file in module dir
    if (process.env.OPENAI_API_KEY) {
      this.apiKey = process.env.OPENAI_API_KEY;
      return;
    }
    const envFile = path.join(__dirname, ".env");
    if (fs.existsSync(envFile)) {
      const content = fs.readFileSync(envFile, "utf8");
      const match = content.match(/OPENAI_API_KEY=(.+)/);
      if (match) {
        this.apiKey = match[1].trim();
        return;
      }
    }
    console.error("[MMM-VoiceAI] No OPENAI_API_KEY found! Set it in environment or .env file.");
    this.apiKey = null;
  },

  // ─── Wake Word Detection ───────────────────────────────────
  // Uses a lightweight keyword-spotting approach with arecord + pocketsphinx
  // OR a simple energy-based detection with a spoken keyword check via Whisper.
  // For production, Porcupine or Snowboy are recommended.
  // This implementation uses a continuous Whisper micro-listen loop.

  _startWakeWordListener() {
    if (this.wakeWordListening) return;
    this.wakeWordListening = true;
    console.log(`[MMM-VoiceAI] Listening for wake word: "${this.config.wakeWord}"`);
    this.sendSocketNotification("STATE_CHANGE", { state: "LISTENING_WAKE" });
    this._wakeWordLoop();
  },

  async _wakeWordLoop() {
    if (!this.wakeWordListening) return;

    try {
      // Record a short 2-second clip to check for wake word
      const clipPath = path.join(this.audioDir, "wake_clip.wav");
      await this._recordAudio(clipPath, 2500);

      // Check if clip has meaningful audio (energy threshold)
      const hasAudio = await this._checkAudioEnergy(clipPath);
      if (hasAudio) {
        // Transcribe the short clip
        const text = await this._transcribeAudio(clipPath);
        const normalized = text.toLowerCase().replace(/[^a-z0-9\s]/g, "").trim();
        console.log(`[MMM-VoiceAI] Wake check heard: "${normalized}"`);

        if (normalized.includes(this.config.wakeWord.toLowerCase())) {
          console.log("[MMM-VoiceAI] Wake word detected!");
          this._onWakeWordDetected();
          return; // Will restart loop after interaction completes
        }
      }
    } catch (err) {
      // Silence errors in wake loop - mic might be busy
    }

    // Continue the loop with a small gap
    setTimeout(() => this._wakeWordLoop(), 300);
  },

  async _onWakeWordDetected() {
    this.wakeWordListening = false;
    this.sendSocketNotification("WAKE_WORD_DETECTED", {});

    try {
      // Play a confirmation chime
      await this._playChime("activate");

      // Record the user's prompt (with silence detection)
      const promptPath = path.join(this.audioDir, "user_prompt.wav");
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
      await this._textToSpeech(aiText, speechPath);
      await this._playAudio(speechPath);

      this.sendSocketNotification("PLAYBACK_COMPLETE", {});
    } catch (err) {
      console.error("[MMM-VoiceAI] Pipeline error:", err.message);
      this.sendSocketNotification("ERROR", { message: err.message });
    }

    // Restart wake word listener
    setTimeout(() => {
      this.wakeWordListening = false;
      this._startWakeWordListener();
    }, 500);
  },

  // ─── Audio Recording ───────────────────────────────────────

  _recordAudio(outputPath, durationMs) {
    return new Promise((resolve, reject) => {
      const seconds = Math.ceil(durationMs / 1000);
      const proc = spawn("arecord", [
        "-D", "default",
        "-f", "S16_LE",
        "-r", "16000",
        "-c", "1",
        "-t", "wav",
        "-d", String(seconds),
        outputPath,
      ]);

      proc.on("close", (code) => {
        if (code === 0 || fs.existsSync(outputPath)) {
          resolve(outputPath);
        } else {
          reject(new Error(`arecord exited with code ${code}`));
        }
      });

      proc.on("error", reject);

      // Force kill after duration + buffer
      setTimeout(() => {
        proc.kill("SIGTERM");
      }, durationMs + 500);
    });
  },

  _recordWithSilenceDetection(outputPath) {
    return new Promise((resolve, reject) => {
      const maxSec = Math.ceil(this.config.maxRecordingTime / 1000);
      const silenceSec = (this.config.silenceTimeout / 1000).toFixed(1);

      // Use sox (rec) for silence-based recording stop
      // Falls back to arecord with timeout if sox unavailable
      const proc = spawn("rec", [
        outputPath,
        "rate", "16000",
        "channels", "1",
        "silence",
        "1", "0.1", "3%",  // Start recording after sound detected
        "1", silenceSec, "3%", // Stop after silence
        "trim", "0", String(maxSec),
      ]);

      let fallback = false;

      proc.on("error", () => {
        // sox not available, fall back to arecord with fixed duration
        console.log("[MMM-VoiceAI] sox not found, using arecord fallback");
        fallback = true;
        this._recordAudio(outputPath, this.config.maxRecordingTime)
          .then(resolve)
          .catch(reject);
      });

      proc.on("close", (code) => {
        if (!fallback) {
          if (fs.existsSync(outputPath)) {
            resolve(outputPath);
          } else {
            reject(new Error("Recording produced no file"));
          }
        }
      });

      // Safety timeout
      setTimeout(() => {
        proc.kill("SIGTERM");
      }, this.config.maxRecordingTime + 2000);
    });
  },

  _checkAudioEnergy(filePath) {
    return new Promise((resolve) => {
      try {
        const data = fs.readFileSync(filePath);
        // Skip WAV header (44 bytes), read 16-bit samples
        let energy = 0;
        let samples = 0;
        for (let i = 44; i < data.length - 1; i += 2) {
          const sample = data.readInt16LE(i);
          energy += Math.abs(sample);
          samples++;
        }
        const avgEnergy = samples > 0 ? energy / samples : 0;
        // Threshold: ignore very quiet clips (background noise)
        resolve(avgEnergy > 500);
      } catch {
        resolve(false);
      }
    });
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

      // Build messages with conversation history
      const messages = [
        { role: "system", content: this.config.systemPrompt },
      ];

      // Add recent conversation context
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

            // Update conversation history
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
      // Try mpv first (best compatibility), then ffplay, then aplay
      const players = [
        { cmd: "mpv", args: ["--no-video", "--really-quiet", filePath] },
        { cmd: "ffplay", args: ["-nodisp", "-autoexit", "-loglevel", "quiet", filePath] },
        { cmd: "aplay", args: [filePath] },
      ];

      const tryPlayer = (index) => {
        if (index >= players.length) {
          return reject(new Error("No audio player available"));
        }

        const { cmd, args } = players[index];
        const proc = spawn(cmd, args);

        proc.on("error", () => tryPlayer(index + 1));
        proc.on("close", (code) => resolve());
      };

      tryPlayer(0);
    });
  },

  _playChime(type) {
    return new Promise((resolve) => {
      // Generate a quick chime using sox or just resolve if unavailable
      const chimePath = path.join(this.audioDir, "chime.wav");
      const freq = type === "activate" ? 880 : 440;

      exec(
        `sox -n ${chimePath} synth 0.15 sine ${freq} fade 0 0.15 0.05 vol 0.3 2>/dev/null`,
        (err) => {
          if (err) {
            // sox not available, skip chime
            return resolve();
          }
          this._playAudio(chimePath).then(resolve).catch(resolve);
        }
      );
    });
  },

  stop() {
    this.wakeWordListening = false;
    if (this.wakeWordProcess) this.wakeWordProcess.kill();
    if (this.recordProcess) this.recordProcess.kill();
  },
});
