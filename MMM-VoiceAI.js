/* MMM-VoiceAI
 * MagicMirror² module for voice-activated OpenAI interaction.
 * Wake word: "Hey Jarvis" via openWakeWord (local, free)
 * Flow: Wake word → Record prompt → Whisper STT → GPT Chat → TTS → Playback + Transcript
 */

Module.register("MMM-VoiceAI", {
  defaults: {
    // ── openWakeWord (local, zero cost) ──
    wakeWordModel: "hey_jarvis",      // hey_jarvis, alexa, hey_mycroft, hey_rhasspy, or path to .tflite/.onnx
    wakeWordThreshold: 0.5,           // 0.0–1.0, higher = less sensitive
    wakeWordCooldown: 3.0,            // seconds between detections
    wakeWordDebug: false,             // log scores to console
    alsaCaptureDevice: null,          // e.g. "plughw:3,0" — null uses ALSA default

    // ── OpenAI ──
    openaiModel: "gpt-4o-mini",
    ttsModel: "tts-1",
    ttsVoice: "nova",                 // alloy, echo, fable, onyx, nova, shimmer
    whisperModel: "whisper-1",
    systemPrompt:
      "You are a helpful smart mirror assistant. Keep responses concise and conversational — ideally under 3 sentences unless the user asks for detail.",
    maxTokens: 300,

    // ── Recording ──
    silenceTimeout: 2000,             // ms of silence before auto-stop
    maxRecordingTime: 30000,          // hard limit on recording (ms)

    // ── UI ──
    conversationHistory: 5,
    idleTimeout: 30000,
    showTranscription: true,
    animateWaveform: true,
  },

  getStyles() {
    return ["MMM-VoiceAI.css"];
  },

  start() {
    Log.info(`Starting module: ${this.name}`);
    this.state = "IDLE"; // IDLE | LISTENING_WAKE | RECORDING | PROCESSING | SPEAKING
    this.transcript = { user: "", assistant: "" };
    this.conversationLog = [];
    this.idleTimer = null;
  },

  getDom() {
    const wrapper = document.createElement("div");
    wrapper.id = "VOICE_AI_WRAPPER";
    wrapper.className = `state-${this.state.toLowerCase()}`;

    // Status orb
    const orb = document.createElement("div");
    orb.className = "vai-orb";
    orb.innerHTML = `
      <div class="vai-orb-ring vai-ring-outer"></div>
      <div class="vai-orb-ring vai-ring-inner"></div>
      <div class="vai-orb-core"></div>
      <svg class="vai-waveform" viewBox="0 0 200 60" preserveAspectRatio="none">
        <path class="vai-wave vai-wave-1" d="M0,30 Q50,10 100,30 T200,30" />
        <path class="vai-wave vai-wave-2" d="M0,30 Q50,50 100,30 T200,30" />
        <path class="vai-wave vai-wave-3" d="M0,30 Q50,5 100,30 T200,30" />
      </svg>
    `;
    wrapper.appendChild(orb);

    // Status label
    const status = document.createElement("div");
    status.className = "vai-status";
    status.textContent = this._getStatusText();
    wrapper.appendChild(status);

    // Transcript area
    if (this.config.showTranscription) {
      const transcriptArea = document.createElement("div");
      transcriptArea.className = "vai-transcript";

      if (this.transcript.user) {
        const userLine = document.createElement("div");
        userLine.className = "vai-transcript-user";
        userLine.innerHTML = `<span class="vai-label">You:</span> ${this.transcript.user}`;
        transcriptArea.appendChild(userLine);
      }

      if (this.transcript.assistant) {
        const aiLine = document.createElement("div");
        aiLine.className = "vai-transcript-ai";
        aiLine.innerHTML = `<span class="vai-label">Mirror:</span> ${this.transcript.assistant}`;
        transcriptArea.appendChild(aiLine);
      }

      wrapper.appendChild(transcriptArea);
    }

    return wrapper;
  },

  notificationReceived(notification, payload) {
    if (notification === "DOM_OBJECTS_CREATED") {
      this.sendSocketNotification("INIT", this.config);
    }
    if (notification === "MMM_VOICEAI_ACTIVATE") {
      this.sendSocketNotification("FORCE_ACTIVATE", {});
    }
  },

  socketNotificationReceived(notification, payload) {
    switch (notification) {
      case "STATE_CHANGE":
        this.state = payload.state;
        this.updateDom(300);
        break;

      case "WAKE_WORD_DETECTED":
        this.state = "RECORDING";
        this.transcript = { user: "", assistant: "" };
        this.updateDom(300);
        break;

      case "USER_TRANSCRIPT":
        this.transcript.user = payload.text;
        this.state = "PROCESSING";
        this.updateDom(300);
        break;

      case "AI_RESPONSE":
        this.transcript.assistant = payload.text;
        this.state = "SPEAKING";
        this.conversationLog.push({
          user: this.transcript.user,
          assistant: payload.text,
          timestamp: Date.now(),
        });
        if (this.conversationLog.length > this.config.conversationHistory) {
          this.conversationLog.shift();
        }
        this.updateDom(300);
        break;

      case "PLAYBACK_COMPLETE":
        this._startIdleTimer();
        this.state = "LISTENING_WAKE";
        this.updateDom(300);
        break;

      case "ERROR":
        Log.error(`MMM-VoiceAI Error: ${payload.message}`);
        this.transcript.assistant = `Error: ${payload.message}`;
        this.state = "LISTENING_WAKE";
        this.updateDom(300);
        break;

      case "READY":
        this.state = "LISTENING_WAKE";
        this.updateDom(300);
        break;
    }
  },

  _getStatusText() {
    let wakePhrase = (this.config.wakeWordModel || "hey_jarvis")
      .replace(/\.(tflite|onnx)$/i, "")  // strip file extension
      .replace(/[-_]/g, " ")              // replace separators with spaces
      .replace(/_?v\d+(\.\d+)?$/, "")     // strip version numbers like _v0.1
      .replace(/\b\w/g, c => c.toUpperCase()); // title case
    const labels = {
      IDLE: "Initializing…",
      LISTENING_WAKE: `Say "${wakePhrase}" to start`,
      RECORDING: "Listening… speak now",
      PROCESSING: "Thinking…",
      SPEAKING: "Responding…",
    };
    return labels[this.state] || "";
  },

  _startIdleTimer() {
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      this.transcript = { user: "", assistant: "" };
      this.updateDom(300);
    }, this.config.idleTimeout);
  },
});
