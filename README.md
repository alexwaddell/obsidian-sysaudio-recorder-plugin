# Audio Recorder

Record system and microphone audio directly in Obsidian with an elegant, always-on-top control window. Perfect for capturing meetings, calls, lectures, and any audio playing on your computer.

# Features
### Audio Capture
- System Audio
- Microphone Audio
- Microphone Selection

### Floating Control Window
- A draggable, always-on-top control panel that stays visible and allows you to manage the recording while you work
- Live waveform visualization provide a representation of real-time audio levels
- One-click mute/unmute button for your microphone
- Automatically matches your Obsidian accent color
 <img width="450" height="250" alt="control_window" src="https://github.com/user-attachments/assets/f130a32a-8766-4258-9159-f9657f91c99b" />



### Global  Hotkey Support
- Set a system-wide hotkey to toggle microphone mute (default: `Ctrl+Shift+M`)
- Works even when Obsidian isn't focused
- Also supports Obsidian's built-in hotkey system

### Seamless Note Integration
- Recordings automatically embed into the note that was active when the recording was started
- Saved as WebM, WAV, or MP4 (M4A/AAC) audio files
- Customizable recordings folder

# How to use
1. Click the microphone icon in the ribbon or use the command palette
2. Grant screen/audio permissions if prompted
3. A floating control window will appear, drag it anywhere on your screen
4. Click the stop button or use the command to end the recording
5. Your recording is automatically saved and linked in your note!

# Settings
| Setting            | Description                                                              |
| ------------------ | ------------------------------------------------------------------------ |
| Recordings Folder  | Where to save your audio files                                           |
| Record Microphone  | Toggle microphone to be completely on/off (on by default)                |
| Microphone Source  | Select which microphone to use (will default to your system default mic) |
| Output Format      | Select the output format (WebM, WAV, or MP4)                             |
| Global Mute Hotkey | System-wide shortcut for muting (e.g., `CommandOrControl+Shift+M`)       |

# Requirements
- Desktop Only
- Obsidian v0.15.0 or higher
- Windows recommended for system audio (macOS may require additional setup / has not been tested)
- MP4 output requires an Electron/Chromium version with native MediaRecorder MP4 support (Chromium 126+, i.e. any current Obsidian release). If unsupported, recordings automatically fall back to WebM.

# Installation
### Manual Installation
1. Download `obsidian-sysaudio-recorder.zip` from the latest release [here](https://github.com/alexwaddell/obsidian-sysaudio-recorder-plugin/releases)
2. Extract the zip file
3. Move the `obsidian-sysaudio-recorder` folder inside the extracted folder to `<your-vault>/.obsidian/plugins/`
4. Restart Obsidian (or reload plugins)
5. Enable "Audio Recorder" in Settings -> Community Plugins
