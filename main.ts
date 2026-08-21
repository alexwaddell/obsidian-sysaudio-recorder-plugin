import {
  App,
  Editor,
  MarkdownView,
  Modal,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  TFile,
} from "obsidian";
import * as path from "path";
// @ts-ignore
import fixWebmDuration from "fix-webm-duration";

interface AudioRecorderSettings {
  recordingsFolder: string;
  recordMicrophone: boolean;
  selectedMicrophoneId: string;
  muteHotkey: string; // Global hotkey for mute toggle
  outputFormat: "webm" | "wav" | "mp4";
}

// Candidate MediaRecorder mimeTypes for each output format, in preference
// order. The first one MediaRecorder.isTypeSupported() accepts is used.
const MIME_TYPE_CANDIDATES: Record<"webm" | "mp4", string[]> = {
  webm: ["audio/webm;codecs=opus", "audio/webm"],
  // MP4 audio recording via MediaRecorder requires Chromium 126+
  // (Electron versions shipped with recent Obsidian all qualify).
  mp4: ["audio/mp4;codecs=mp4a.40.2", "audio/mp4"],
};

const DEFAULT_SETTINGS: AudioRecorderSettings = {
  recordingsFolder: "Recordings",
  recordMicrophone: true,
  selectedMicrophoneId: "default",
  muteHotkey: "CommandOrControl+Shift+M", // Default global hotkey
  outputFormat: "webm",
};

export default class AudioRecorderPlugin extends Plugin {
  settings: AudioRecorderSettings;
  recorder: MediaRecorder | null = null;
  chunks: Blob[] = [];
  recordingStream: MediaStream | null = null;
  micStream: MediaStream | null = null;
  audioContext: AudioContext | null = null;
  micGainNode: GainNode | null = null;
  isMicMuted: boolean = false;
  analyserNode: AnalyserNode | null = null;
  statusBarItem: HTMLElement | null = null;
  activeFileAtStart: TFile | null = null;
  controlWindow: any = null; // BrowserWindow
  visualizationIntervalId: number | null = null;
  electron: any = null; // Electron reference
  startTime: number = 0;
  // The mimeType/extension actually used for the current recording. May
  // differ from settings.outputFormat if the preferred format wasn't
  // supported by MediaRecorder and we fell back to WebM.
  activeRecordingMimeType: string = "audio/webm";
  activeOutputExtension: "webm" | "wav" | "mp4" = "webm";

  // Audio properties
  sampleRate: number = 44100;
  numChannels: number = 2;

  async onload() {
    await this.loadSettings();

    // Ribbon Icon
    const ribbonIconEl = this.addRibbonIcon(
      "microphone",
      "Start/Stop Recording",
      (evt: MouseEvent) => {
        this.toggleRecording();
      },
    );
    ribbonIconEl.addClass("audio-recorder-ribbon-class");

    // Status Bar
    this.statusBarItem = this.addStatusBarItem();
    this.statusBarItem.setText("");

    // Command
    this.addCommand({
      id: "start-stop-recording",
      name: "Start/Stop Recording",
      callback: () => {
        this.toggleRecording();
      },
    });

    // Mute Toggle Command with Hotkey
    this.addCommand({
      id: "toggle-mic-mute",
      name: "Toggle Microphone Mute",
      callback: () => {
        this.toggleMute();
      },
    });

    // Settings
    this.addSettingTab(new AudioRecorderSettingTab(this.app, this));
  }

  onunload() {
    this.stopRecording();
    this.stopRecordingStreams();
    this.closeControlWindow();
    this.unregisterGlobalHotkey();
  }

  async toggleRecording() {
    if (this.recorder && this.recorder.state === "recording") {
      this.stopRecording();
    } else {
      this.startRecording();
    }
  }

  toggleMute() {
    // Only allow muting during active recording
    const isRecording = this.recorder && this.recorder.state === "recording";

    if (!isRecording) {
      new Notice("No active recording to mute/unmute microphone.");
      return;
    }

    if (!this.micGainNode) {
      new Notice("Microphone is not being recorded.");
      return;
    }

    this.isMicMuted = !this.isMicMuted;
    this.micGainNode.gain.value = this.isMicMuted ? 0 : 1;

    // Update the control window if it exists
    if (this.controlWindow && !this.controlWindow.isDestroyed()) {
      this.controlWindow.webContents.send("toggle-mute-state", this.isMicMuted);
    }

    new Notice(this.isMicMuted ? "Microphone muted" : "Microphone unmuted");
  }


  async startRecording() {
    let hotkeyRegistered = false;
    try {
      this.activeFileAtStart = this.app.workspace.getActiveFile();

      // Use Electron's desktopCapturer to get sources
      // @ts-ignore
      const electron = require("electron");
      this.electron = electron; // Store for later use
      let desktopCapturer = electron.desktopCapturer;
      let remote = electron.remote;

      // Fallback for some Electron versions/configs
      if (!desktopCapturer && remote) {
        desktopCapturer = remote.desktopCapturer;
      }

      if (!desktopCapturer) {
        new Notice("Error: desktopCapturer API is not available.");
        return;
      }

      // Auto-select the first screen (Primary Display)
      const sources = await desktopCapturer.getSources({ types: ["screen"] });
      if (sources.length === 0) {
        new Notice("No screen sources found.");
        return;
      }
      const source = sources[0]; // Primary screen

      // 1. Get System Audio Stream
      const systemStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          mandatory: {
            chromeMediaSource: "desktop",
            chromeMediaSourceId: source.id,
          },
        },
        video: {
          mandatory: {
            chromeMediaSource: "desktop",
            chromeMediaSourceId: source.id,
          },
        },
      } as any);

      // Check system audio tracks
      const systemAudioTracks = systemStream.getAudioTracks();
      if (systemAudioTracks.length === 0) {
        new Notice(
          "No system audio track captured. Ensure you are on Windows or have system audio setup.",
        );
      }

      this.recordingStream = systemStream;

      // 2. Get Microphone Stream (if enabled)
      if (this.settings.recordMicrophone) {
        try {
          const constraints: any = { audio: true };
          if (
            this.settings.selectedMicrophoneId &&
            this.settings.selectedMicrophoneId !== "default"
          ) {
            constraints.audio = {
              deviceId: { exact: this.settings.selectedMicrophoneId },
            };
          }

          this.micStream =
            await navigator.mediaDevices.getUserMedia(constraints);
        } catch (micErr) {
          console.error("Error capturing microphone:", micErr);
          new Notice(
            "Failed to capture microphone. Recording system audio only.",
          );
        }
      }

      // 3. Mix Streams & Setup Audio Context
      let finalStream: MediaStream;
      this.audioContext = new AudioContext();
      this.sampleRate = this.audioContext.sampleRate; // Capture actual sample rate
      const destination = this.audioContext.createMediaStreamDestination();

      // Create a Master Gain Node to mix everything before sending to destination/analyser
      const masterGain = this.audioContext.createGain();
      masterGain.connect(destination);

      // Setup Analyser
      this.analyserNode = this.audioContext.createAnalyser();
      this.analyserNode.fftSize = 128;
      this.analyserNode.smoothingTimeConstant = 0.5;
      masterGain.connect(this.analyserNode);

      // System Audio Node
      if (systemAudioTracks.length > 0) {
        const systemSource =
          this.audioContext.createMediaStreamSource(systemStream);
        systemSource.connect(masterGain);
      }

      // Mic Audio Node
      if (this.micStream) {
        const micSource = this.audioContext.createMediaStreamSource(
          this.micStream,
        );
        this.micGainNode = this.audioContext.createGain();
        this.micGainNode.gain.value = 1.0;
        micSource.connect(this.micGainNode);
        this.micGainNode.connect(masterGain);
      }

      finalStream = destination.stream;

      if (finalStream.getAudioTracks().length === 0) {
        new Notice("No audio tracks available to record.");
        this.stopRecordingStreams();
        return;
      }

      // WAV is produced by decoding a WebM recording afterward. MP4 and
      // WebM are both recorded natively by MediaRecorder - pick whichever
      // mimeType is actually supported, falling back to WebM if the
      // requested format isn't available (e.g. MP4 on an older Electron).
      const nativeFormat = this.settings.outputFormat === "wav" ? "webm" : this.settings.outputFormat;
      const mimeType = this.pickSupportedMimeType(nativeFormat);
      if (nativeFormat === "mp4" && !mimeType.startsWith("audio/mp4")) {
        new Notice("MP4 recording isn't supported on this system. Falling back to WebM.");
      }
      this.activeRecordingMimeType = mimeType;
      this.activeOutputExtension = this.settings.outputFormat === "wav"
        ? "wav"
        : (mimeType.startsWith("audio/mp4") ? "mp4" : "webm");

      this.recorder = new MediaRecorder(finalStream, { mimeType });
      this.chunks = [];

      this.recorder.ondataavailable = (e) => {
        if (e.data.size > 0) {
          this.chunks.push(e.data);
        }
      };

      this.recorder.onstop = async () => {
        const recordedBlob = new Blob(this.chunks, { type: this.activeRecordingMimeType });

        let finalBlob: Blob;
        if (this.settings.outputFormat === "wav") {
          // Convert WebM to WAV
          new Notice("Converting to WAV...");
          finalBlob = await this.convertWebMToWAV(recordedBlob);
        } else {
          // Keep as recorded (WebM or MP4)
          finalBlob = recordedBlob;
        }

        await this.saveRecording(finalBlob);
        this.stopRecordingStreams();
        this.statusBarItem?.setText("");
        new Notice("Recording saved.");
        this.closeControlWindow();
      };

      this.recorder.start();

      // Register the global mute hotkey only once we actually have an
      // active recording, so a failed/aborted start doesn't leave a
      // system-wide shortcut registered with nothing to unregister it.
      this.registerGlobalHotkey();
      hotkeyRegistered = true;

      this.startTime = Date.now();
      this.statusBarItem?.setText("Recording...");
      new Notice("Recording started.");

      // Open Control Window
      this.openControlWindow(electron);
      this.startAudioVisualization();
    } catch (err) {
      console.error("Error starting recording:", err);
      new Notice("Failed to start recording. See console for details.");
      if (hotkeyRegistered) {
        this.unregisterGlobalHotkey();
      }
      this.stopRecordingStreams();
    }
  }

  openControlWindow(electron: any) {
    const remote = electron.remote || electron;
    const BrowserWindow = remote.BrowserWindow;
    const ipcMain = remote.ipcMain;

    // Calculate position (bottom center)
    const { width, height } = remote.screen.getPrimaryDisplay().workAreaSize;

    this.controlWindow = new BrowserWindow({
      width: 320,
      height: 110,
      frame: false,
      transparent: true,
      backgroundColor: "#00000000", // Force transparency
      hasShadow: false, // Disable native shadow to prevent black corners
      alwaysOnTop: true,
      resizable: false,
      webPreferences: {
        nodeIntegration: true,
        contextIsolation: false,
        backgroundThrottling: false, // Prevent throttling when in background
      },
      x: Math.floor(width / 2 - 160),
      y: height - 110,
    });

    // Load HTML
    // @ts-ignore
    const pluginDir = this.app.vault.adapter.basePath + "/" + this.manifest.dir;
    const htmlPath = path.join(pluginDir, "control-window.html");
    this.controlWindow.loadFile(htmlPath);

    this.controlWindow.webContents.on("did-finish-load", () => {
      // Get Obsidian's accent color from CSS variables
      const accentColor =
        getComputedStyle(document.body).getPropertyValue(
          "--interactive-accent",
        ) || "#7c3aed"; // Fallback to purple
      this.controlWindow.webContents.send("set-accent-color", accentColor);
    });

    // IPC Handlers
    const onMuteMic = () => {
      if (this.micGainNode) {
        this.micGainNode.gain.value = 0;
        this.isMicMuted = true;
      }
    };
    const onUnmuteMic = () => {
      if (this.micGainNode) {
        this.micGainNode.gain.value = 1;
        this.isMicMuted = false;
      }
    };
    const onStopRecording = () => {
      this.stopRecording();
    };

    ipcMain.on("mute-mic", onMuteMic);
    ipcMain.on("unmute-mic", onUnmuteMic);
    ipcMain.on("stop-recording", onStopRecording);

    // Cleanup on window close
    this.controlWindow.on("closed", () => {
      ipcMain.removeListener("mute-mic", onMuteMic);
      ipcMain.removeListener("unmute-mic", onUnmuteMic);
      ipcMain.removeListener("stop-recording", onStopRecording);
      this.controlWindow = null;
    });
  }

  closeControlWindow() {
    if (this.controlWindow) {
      this.controlWindow.close();
      this.controlWindow = null;
    }

    this.stopAudioVisualization();
  }

  startAudioVisualization() {
    if (!this.analyserNode || !this.controlWindow) return;

    // AnalyserNode.getByteFrequencyData() works as long as its input is
    // connected, even with nothing connected to its output. Polling it on
    // an interval avoids running an extra ScriptProcessorNode (deprecated,
    // runs on the main thread) and an unnecessary connection back into
    // audioContext.destination just to read levels.
    const analyser = this.analyserNode;
    const dataArray = new Uint8Array(analyser.frequencyBinCount);

    this.visualizationIntervalId = window.setInterval(() => {
      if (!this.controlWindow || this.controlWindow.isDestroyed()) {
        this.stopAudioVisualization();
        return;
      }

      analyser.getByteFrequencyData(dataArray);

      let sum = 0;
      for (let i = 0; i < dataArray.length; i++) {
        sum += dataArray[i];
      }
      const average = sum / dataArray.length / 255;

      try {
        this.controlWindow.webContents.send("audio-level", average);
      } catch (err) {
        // Window might be closed
      }
    }, 50);
  }

  stopAudioVisualization() {
    if (this.visualizationIntervalId !== null) {
      window.clearInterval(this.visualizationIntervalId);
      this.visualizationIntervalId = null;
    }
  }

  async stopRecording() {
    if (this.recorder && this.recorder.state === "recording") {
      this.recorder.stop();
    }
    this.unregisterGlobalHotkey();
  }

  async convertWebMToWAV(webmBlob: Blob): Promise<Blob> {
    // Decode WebM to raw audio data
    const arrayBuffer = await webmBlob.arrayBuffer();
    const audioBuffer = await this.audioContext!.decodeAudioData(arrayBuffer);

    // Update sample rate from decoded audio
    this.sampleRate = audioBuffer.sampleRate;
    this.numChannels = audioBuffer.numberOfChannels;

    // Extract channel data
    const channels: Float32Array[] = [];
    for (let i = 0; i < this.numChannels; i++) {
      channels.push(audioBuffer.getChannelData(i));
    }

    // Mono gets duplicated to stereo; more than 2 channels get mixed down
    // to stereo (left = channel 0, right = last available channel).
    let left: Float32Array;
    let right: Float32Array;
    if (this.numChannels === 1) {
      left = channels[0];
      right = channels[0];
      this.numChannels = 2;
    } else {
      left = channels[0];
      right = channels[Math.min(1, channels.length - 1)];
      this.numChannels = 2;
    }

    // Create WAV file. Writes directly from the per-channel arrays instead
    // of first allocating a full interleaved Float32Array copy, which for
    // long recordings avoids doubling peak memory usage.
    const wavData = this.writeWavFile(left, right);
    return new Blob([wavData], { type: "audio/wav" });
  }

  stopRecordingStreams() {
    if (this.recordingStream) {
      this.recordingStream.getTracks().forEach((track) => track.stop());
      this.recordingStream = null;
    }
    if (this.micStream) {
      this.micStream.getTracks().forEach((track) => track.stop());
      this.micStream = null;
    }

    this.stopAudioVisualization();
    this.analyserNode = null;
    this.micGainNode = null;

    if (this.audioContext) {
      this.audioContext.close();
      this.audioContext = null;
    }
    this.recorder = null;
  }

  registerGlobalHotkey() {
    if (!this.electron || !this.settings.muteHotkey) return;

    try {
      const remote = this.electron.remote || this.electron;
      const { globalShortcut } = remote;

      this.unregisterGlobalHotkey();

      const registered = globalShortcut.register(
        this.settings.muteHotkey,
        () => {
          this.toggleMute();
        }
      );

      if (!registered) {
        console.warn(
          `Failed to register global hotkey: ${this.settings.muteHotkey}`
        );
      }
    } catch (err) {
      console.error("Error registering global hotkey:", err);
    }
  }

  unregisterGlobalHotkey() {
    if (!this.electron || !this.settings.muteHotkey) return;

    try {
      const remote = this.electron.remote || this.electron;
      const { globalShortcut } = remote;

      if (globalShortcut.isRegistered(this.settings.muteHotkey)) {
        globalShortcut.unregister(this.settings.muteHotkey);
      }
    } catch (err) {
      console.error("Error unregistering global hotkey:", err);
    }
  }

  async saveRecording(blob: Blob) {
    let buffer: Uint8Array;

    // Chromium's WebM muxer doesn't write a duration into the container,
    // so fix-webm-duration patches it in afterward. MP4 recordings don't
    // have this issue and WAV has an explicit header written by us.
    if (this.activeOutputExtension === "webm") {
      const duration = Date.now() - this.startTime;
      const fixedBlob = await new Promise<Blob>((resolve) => {
        fixWebmDuration(blob, duration, (fixed: Blob) => {
          resolve(fixed);
        });
      });
      const arrayBuffer = await fixedBlob.arrayBuffer();
      buffer = new Uint8Array(arrayBuffer);
    } else {
      const arrayBuffer = await blob.arrayBuffer();
      buffer = new Uint8Array(arrayBuffer);
    }

    const folderPath = this.settings.recordingsFolder;
    if (!(await this.app.vault.adapter.exists(folderPath))) {
      await this.app.vault.createFolder(folderPath);
    }

    const now = new Date();
    const timestamp = `${now.getFullYear()}-${(now.getMonth() + 1).toString().padStart(2, "0")}-${now.getDate().toString().padStart(2, "0")} ${now.getHours().toString().padStart(2, "0")}.${now.getMinutes().toString().padStart(2, "0")}.${now.getSeconds().toString().padStart(2, "0")}`;
    const extension = this.activeOutputExtension;
    const filename = `${folderPath}/Recording ${timestamp}.${extension}`;

    // @ts-ignore
    const file = await this.app.vault.createBinary(filename, buffer.buffer);

    if (this.activeFileAtStart) {
      const linkText = `\n![[${file.path}]]\n`;
      await this.app.vault.append(this.activeFileAtStart, linkText);
    }
  }

  // Returns the first MediaRecorder-supported mimeType for the requested
  // format, falling back to WebM if none of the format's candidates (or
  // the format itself) are supported.
  pickSupportedMimeType(format: "webm" | "mp4"): string {
    const candidates = MIME_TYPE_CANDIDATES[format];
    const supported = candidates.find((type) => MediaRecorder.isTypeSupported(type));
    if (supported) return supported;

    if (format !== "webm") {
      const webmFallback = MIME_TYPE_CANDIDATES.webm.find((type) =>
        MediaRecorder.isTypeSupported(type),
      );
      if (webmFallback) return webmFallback;
    }

    // Last resort: let the browser pick its own default.
    return "audio/webm";
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  writeWavFile(left: Float32Array, right: Float32Array) {
    const frameCount = left.length;
    const buffer = new ArrayBuffer(44 + frameCount * 4);
    const view = new DataView(buffer);

    this.writeString(view, 0, "RIFF");
    view.setUint32(4, 36 + frameCount * 4, true);
    this.writeString(view, 8, "WAVE");
    this.writeString(view, 12, "fmt ");
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, this.numChannels, true);
    view.setUint32(24, this.sampleRate, true);
    view.setUint32(28, this.sampleRate * 4, true);
    view.setUint16(32, this.numChannels * 2, true);
    view.setUint16(34, 16, true);
    this.writeString(view, 36, "data");
    view.setUint32(40, frameCount * 4, true);

    let offset = 44;
    for (let i = 0; i < frameCount; i++) {
      const l = Math.max(-1, Math.min(1, left[i]));
      view.setInt16(offset, l < 0 ? l * 0x8000 : l * 0x7fff, true);
      offset += 2;

      const r = Math.max(-1, Math.min(1, right[i]));
      view.setInt16(offset, r < 0 ? r * 0x8000 : r * 0x7fff, true);
      offset += 2;
    }

    return view;
  }

  writeString(view: DataView, offset: number, string: string) {
    for (let i = 0; i < string.length; i++) {
      view.setUint8(offset + i, string.charCodeAt(i));
    }
  }
}

class AudioRecorderSettingTab extends PluginSettingTab {
  plugin: AudioRecorderPlugin;

  constructor(app: App, plugin: AudioRecorderPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;

    containerEl.empty();

    containerEl.createEl("h2", { text: "Settings for Audio Recorder" });

    new Setting(containerEl)
      .setName("Recordings Folder")
      .setDesc("Folder to save audio recordings in")
      .addText((text) =>
        text
          .setPlaceholder("Recordings")
          .setValue(this.plugin.settings.recordingsFolder)
          .onChange(async (value) => {
            this.plugin.settings.recordingsFolder = value;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Record Microphone")
      .setDesc("Record microphone audio along with system audio.")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.recordMicrophone)
          .onChange(async (value) => {
            this.plugin.settings.recordMicrophone = value;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Microphone Source")
      .setDesc("Select the microphone to record.")
      .addDropdown(async (dropdown) => {
        const devices = await navigator.mediaDevices.enumerateDevices();
        const audioInputs = devices.filter((d) => d.kind === "audioinput");

        audioInputs.forEach((device) => {
          dropdown.addOption(
            device.deviceId,
            device.label || `Microphone ${device.deviceId}`,
          );
        });

        dropdown.setValue(this.plugin.settings.selectedMicrophoneId);
        dropdown.onChange(async (value) => {
          this.plugin.settings.selectedMicrophoneId = value;
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName("Output Format")
      .setDesc("Select the audio output format.")
      .addDropdown((dropdown) => {
        dropdown
          .addOption("webm", "WebM")
          .addOption("wav", "WAV")
          .addOption("mp4", "MP4 (M4A)")
          .setValue(this.plugin.settings.outputFormat)
          .onChange(async (value: "webm" | "wav" | "mp4") => {
            this.plugin.settings.outputFormat = value;
            await this.plugin.saveSettings();
          });
      });

    // Hotkeys Section
    containerEl.createEl("h3", { text: "Hotkeys" });

    new Setting(containerEl)
      .setName("Global Mute Hotkey")
      .setDesc(
        "Set a system-wide hotkey to toggle microphone muting (works even when Obsidian isn't focused). " +
        "Uses Electron's accelerator format. Examples: 'CommandOrControl+Shift+M', 'Alt+M', 'Ctrl+Shift+Space'. " +
        "Changes take effect when starting a new recording."
      )
      .addText((text) =>
        text
          .setPlaceholder("CommandOrControl+Shift+M")
          .setValue(this.plugin.settings.muteHotkey)
          .onChange(async (value) => {
            this.plugin.settings.muteHotkey = value;
            await this.plugin.saveSettings();
          })
      );

    const hotkeyDesc = containerEl.createDiv();
    hotkeyDesc.addClass("setting-item-description");
    hotkeyDesc.setText(
      "You can also use Obsidian's built-in hotkeys (Settings → Hotkeys → 'Toggle Microphone Mute'), " +
      "but those only work when Obsidian is focused."
    );
    hotkeyDesc.style.marginBottom = "1em";
  }
}
