// Windows WASAPI process-loopback audio capture helper for screen sharing.
// Zero new npm dependencies: follows the win-helper.mjs pattern (one powershell.exe process compiling a small C#
// helper via Add-Type). Uses ActivateAudioInterfaceAsync with VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK (Windows 10 build
// 20348+ / Windows 11):
//   - mode 'include': captures only the selected window's process tree (no voice echo, no unrelated apps).
//   - mode 'exclude': captures system audio excluding ASSCRACK's own process tree (no voice/music echo).
// Outputs a binary stream on stdout: 4-byte "RDY0" once active, then "PCM0" + uint32LE(7680) + 960 interleaved stereo
// float32 samples (20 ms at 48 kHz). Exits automatically when the parent process ends.
import { powershellPath } from './win-helper.mjs';

export const AUDIO_SAMPLE_RATE = 48000;
export const AUDIO_CHANNELS = 2;
export const AUDIO_BLOCK_FRAMES = 960; // 20 ms at 48 kHz
export const AUDIO_BLOCK_BYTES = AUDIO_BLOCK_FRAMES * AUDIO_CHANNELS * 4; // 7680 bytes
export const READY_MAGIC = Buffer.from('RDY0', 'ascii');
export const PCM_MAGIC = Buffer.from('PCM0', 'ascii');

export function processLoopbackSupported(platform = process.platform, release = '') {
    if (platform !== 'win32') return false;
    const build = Number(String(release ?? '').split('.')[2]);
    return Number.isInteger(build) && build >= 20348;
}

const LOOPBACK_CS = `
using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;

public static class AsscrackAudioLoopback {
  const string VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK = "VAD\\\\Process_Loopback";
  static readonly Guid IID_IAudioClient = new Guid("1CB9AD4C-DBFA-4c32-B178-C2F568A703B2");
  static readonly Guid IID_IAudioCaptureClient = new Guid("C8ADBD64-E71E-48a0-A4DE-185C395CD317");

  [StructLayout(LayoutKind.Sequential)]
  struct WAVEFORMATEX {
    public ushort wFormatTag, nChannels;
    public uint nSamplesPerSec, nAvgBytesPerSec;
    public ushort nBlockAlign, wBitsPerSample, cbSize;
  }

  [StructLayout(LayoutKind.Sequential)]
  struct AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS {
    public uint TargetProcessId;
    public uint ProcessLoopbackMode;
  }

  [StructLayout(LayoutKind.Sequential)]
  struct AUDIOCLIENT_ACTIVATION_PARAMS {
    public uint ActivationType;
    public AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS ProcessLoopbackParams;
  }

  [StructLayout(LayoutKind.Sequential)]
  struct BLOB {
    public uint cbSize;
    public IntPtr pBlobData;
  }

  [StructLayout(LayoutKind.Explicit)]
  struct PROPVARIANT {
    [FieldOffset(0)] public ushort vt;
    [FieldOffset(8)] public BLOB blob;
  }

  [ComImport, Guid("72A22D78-CDE4-431D-B8CC-843A71199B6D"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IActivateAudioInterfaceAsyncOperation {
    int GetActivateResult(out int activateResult, [MarshalAs(UnmanagedType.IUnknown)] out object activatedInterface);
  }

  [ComImport, Guid("41D949AB-9862-444A-80F6-C261334DA5EB"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IActivateAudioInterfaceCompletionHandler {
    int ActivateCompleted(IActivateAudioInterfaceAsyncOperation operation);
  }

  [ComImport, Guid("1CB9AD4C-DBFA-4c32-B178-C2F568A703B2"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IAudioClient {
    int Initialize(int shareMode, uint streamFlags, long bufferDuration, long periodicity, IntPtr format, IntPtr sessionGuid);
    int GetBufferSize(out uint numBufferFrames);
    int GetStreamLatency(out long latency);
    int GetCurrentPadding(out uint numPaddingFrames);
    int IsFormatSupported(int shareMode, IntPtr format, out IntPtr closestMatch);
    int GetMixFormat(out IntPtr deviceFormat);
    int GetDevicePeriod(out long defaultPeriod, out long minimumPeriod);
    int Start();
    int Stop();
    int Reset();
    int SetEventHandle(IntPtr eventHandle);
    int GetService([MarshalAs(UnmanagedType.LPStruct)] Guid riid, [MarshalAs(UnmanagedType.IUnknown)] out object ppv);
  }

  [ComImport, Guid("C8ADBD64-E71E-48a0-A4DE-185C395CD317"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IAudioCaptureClient {
    int GetBuffer(out IntPtr data, out uint numFramesToRead, out uint flags, out ulong devicePosition, out ulong qpcPosition);
    int ReleaseBuffer(uint numFramesRead);
    int GetNextPacketSize(out uint numFramesInNextPacket);
  }

  [DllImport("mmdevapi.dll", CharSet = CharSet.Unicode)]
  static extern int ActivateAudioInterfaceAsync(string deviceInterfacePath, [MarshalAs(UnmanagedType.LPStruct)] Guid riid,
    ref PROPVARIANT activationParams, IActivateAudioInterfaceCompletionHandler completionHandler, out IActivateAudioInterfaceAsyncOperation operation);

  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
  [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
  [DllImport("kernel32.dll")] static extern IntPtr CreateEvent(IntPtr attr, bool manualReset, bool initialState, string name);
  [DllImport("kernel32.dll")] static extern uint WaitForMultipleObjects(uint count, IntPtr[] handles, bool waitAll, uint ms);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);

  class Handler : IActivateAudioInterfaceCompletionHandler {
    public readonly ManualResetEventSlim Done = new ManualResetEventSlim(false);
    public int Result = -1;
    public object Interface = null;
    public int ActivateCompleted(IActivateAudioInterfaceAsyncOperation op) {
      op.GetActivateResult(out Result, out Interface);
      Done.Set();
      return 0;
    }
  }

  public static int Run(uint targetPid, long hwnd, uint mode, uint parentPid) {
    if (hwnd > 0) {
      uint wpid = 0;
      GetWindowThreadProcessId(new IntPtr(hwnd), out wpid);
      if (wpid == 0) return 2;
      targetPid = wpid;
    }
    if (targetPid == 0) return 3;
    IntPtr parent = OpenProcess(0x00100000, false, parentPid);
    if (parent == IntPtr.Zero) return 4;
    IntPtr audioEv = CreateEvent(IntPtr.Zero, false, false, null);
    if (audioEv == IntPtr.Zero) { CloseHandle(parent); return 5; }

    var act = new AUDIOCLIENT_ACTIVATION_PARAMS();
    act.ActivationType = 1; // AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK
    act.ProcessLoopbackParams.TargetProcessId = targetPid;
    act.ProcessLoopbackParams.ProcessLoopbackMode = mode; // 0 = INCLUDE, 1 = EXCLUDE

    IntPtr actPtr = Marshal.AllocHGlobal(Marshal.SizeOf(act));
    Marshal.StructureToPtr(act, actPtr, false);
    var pv = new PROPVARIANT();
    pv.vt = 65; // VT_BLOB
    pv.blob.cbSize = (uint)Marshal.SizeOf(act);
    pv.blob.pBlobData = actPtr;

    var handler = new Handler();
    IActivateAudioInterfaceAsyncOperation op;
    int hr = ActivateAudioInterfaceAsync(VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK, IID_IAudioClient, ref pv, handler, out op);
    Marshal.FreeHGlobal(actPtr);
    if (hr < 0 || !handler.Done.Wait(3000) || handler.Result < 0 || handler.Interface == null) {
      CloseHandle(audioEv); CloseHandle(parent); return 6;
    }

    var client = (IAudioClient)handler.Interface;
    var fmt = new WAVEFORMATEX {
      wFormatTag = 3, // WAVE_FORMAT_IEEE_FLOAT
      nChannels = 2,
      nSamplesPerSec = 48000,
      wBitsPerSample = 32,
      nBlockAlign = 8,
      nAvgBytesPerSec = 48000 * 8,
      cbSize = 0
    };
    IntPtr fmtPtr = Marshal.AllocHGlobal(Marshal.SizeOf(fmt));
    Marshal.StructureToPtr(fmt, fmtPtr, false);
    // AUDCLNT_STREAMFLAGS_LOOPBACK (0x00020000) | EVENTCALLBACK (0x00040000) | AUTOCONVERTPCM (0x80000000) | SRC_DEFAULT_QUALITY (0x08000000)
    uint flags = 0x00020000u | 0x00040000u | 0x80000000u | 0x08000000u;
    hr = client.Initialize(0, flags, 200000, 0, fmtPtr, IntPtr.Zero);
    Marshal.FreeHGlobal(fmtPtr);
    if (hr < 0) { CloseHandle(audioEv); CloseHandle(parent); return 7; }

    hr = client.SetEventHandle(audioEv);
    if (hr < 0) { CloseHandle(audioEv); CloseHandle(parent); return 8; }

    object capObj;
    hr = client.GetService(IID_IAudioCaptureClient, out capObj);
    if (hr < 0 || capObj == null) { CloseHandle(audioEv); CloseHandle(parent); return 9; }
    var capture = (IAudioCaptureClient)capObj;

    hr = client.Start();
    if (hr < 0) { CloseHandle(audioEv); CloseHandle(parent); return 10; }

    Stream stdout = Console.OpenStandardOutput();
    byte[] ready = new byte[] { (byte)'R', (byte)'D', (byte)'Y', (byte)'0' };
    stdout.Write(ready, 0, 4);
    stdout.Flush();

    const int BLOCK_BYTES = 960 * 2 * 4;
    byte[] header = new byte[] { (byte)'P', (byte)'C', (byte)'M', (byte)'0', 0x00, 0x1E, 0x00, 0x00 }; // 7680 LE
    byte[] accum = new byte[BLOCK_BYTES];
    int fill = 0;
    IntPtr[] handles = new IntPtr[] { parent, audioEv };

    try {
      while (true) {
        uint wait = WaitForMultipleObjects(2, handles, false, 50);
        if (wait == 0) break; // parent exited
        uint packetFrames = 0;
        while (capture.GetNextPacketSize(out packetFrames) >= 0 && packetFrames > 0) {
          IntPtr dataPtr; uint frames; uint bufFlags; ulong devPos; ulong qpcPos;
          if (capture.GetBuffer(out dataPtr, out frames, out bufFlags, out devPos, out qpcPos) < 0) break;
          int byteCount = (int)frames * 8;
          byte[] tmp = new byte[byteCount];
          if ((bufFlags & 2u) == 0 && dataPtr != IntPtr.Zero) {
            Marshal.Copy(dataPtr, tmp, 0, byteCount);
          }
          capture.ReleaseBuffer(frames);
          int offset = 0;
          while (offset < byteCount) {
            int take = Math.Min(byteCount - offset, BLOCK_BYTES - fill);
            Buffer.BlockCopy(tmp, offset, accum, fill, take);
            fill += take;
            offset += take;
            if (fill == BLOCK_BYTES) {
              stdout.Write(header, 0, 8);
              stdout.Write(accum, 0, BLOCK_BYTES);
              stdout.Flush();
              fill = 0;
            }
          }
        }
      }
    } catch { } finally {
      try { client.Stop(); } catch { }
      CloseHandle(audioEv);
      CloseHandle(parent);
    }
    return 0;
  }
}
`;

export function loopbackScript({ mode, hwnd = 0, targetPid = 0, parentPid = process.pid }) {
    const m = mode === 'include' ? 0 : 1;
    const h = Number.isSafeInteger(hwnd) && hwnd > 0 ? hwnd : 0;
    const tp = Number.isSafeInteger(targetPid) && targetPid > 0 ? targetPid : 0;
    const pp = Number.isSafeInteger(parentPid) && parentPid > 0 ? parentPid : process.pid;
    return `Add-Type -Language CSharp -TypeDefinition @'\n${LOOPBACK_CS}\n'@\n[Environment]::Exit([AsscrackAudioLoopback]::Run(${tp}u, ${h}L, ${m}u, ${pp}u))`;
}

const encodeCommand = script => Buffer.from(script, 'utf16le').toString('base64');

export function deinterleaveStereoFloat32(buf) {
    const left = new Float32Array(AUDIO_BLOCK_FRAMES);
    const right = new Float32Array(AUDIO_BLOCK_FRAMES);
    const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    for (let i = 0; i < AUDIO_BLOCK_FRAMES; i++) {
        left[i] = view.getFloat32(i * 8, true);
        right[i] = view.getFloat32(i * 8 + 4, true);
    }
    return { left, right };
}

export function createScreenAudioCapture({ spawn, platform = process.platform, release = '', ownPid = process.pid,
    log = () => {}, startupTimeoutMs = 4000, env = process.env }) {
    let current = null;
    let paused = false;

    function stop() {
        const cur = current;
        current = null;
        paused = false;
        if (!cur) return;
        cur.ended = true;
        clearTimeout(cur.timer);
        try { cur.child?.kill?.(); } catch { /* ended */ }
    }

    function start({ mode, hwnd = null, onBlock = () => {}, onEnd = () => {} } = {}) {
        stop();
        if (!processLoopbackSupported(platform, release)) {
            return Promise.resolve({ ok: false, reason: 'unsupported' });
        }
        if (mode !== 'include' && mode !== 'exclude') {
            return Promise.resolve({ ok: false, reason: 'invalid-mode' });
        }
        const script = loopbackScript({
            mode,
            hwnd: mode === 'include' ? (hwnd ?? 0) : 0,
            targetPid: mode === 'exclude' ? ownPid : 0,
            parentPid: ownPid
        });
        return new Promise(resolve => {
            let child;
            try {
                child = spawn(powershellPath(env), ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
                    '-EncodedCommand', encodeCommand(script)], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
            } catch (err) {
                log('WARN', `screen audio loopback spawn failed: ${err?.code ?? err?.message ?? 'spawn'}`);
                resolve({ ok: false, reason: 'spawn' });
                return;
            }
            const state = { child, ready: false, ended: false, buf: Buffer.alloc(0), timer: null };
            current = state;
            const settleStart = result => {
                clearTimeout(state.timer);
                state.timer = null;
                if (!result.ok) {
                    if (current === state) current = null;
                    state.ended = true;
                    try { child.kill(); } catch { /* ended */ }
                }
                resolve(result);
            };
            state.timer = setTimeout(() => {
                if (!state.ready && !state.ended) {
                    log('WARN', 'screen audio loopback startup timed out');
                    settleStart({ ok: false, reason: 'timeout' });
                }
            }, startupTimeoutMs);

            child.stdout?.on('data', chunk => {
                if (state.ended) return;
                const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
                state.buf = state.buf.length ? Buffer.concat([state.buf, data]) : data;
                if (!state.ready) {
                    if (state.buf.length < 4) return;
                    if (!state.buf.subarray(0, 4).equals(READY_MAGIC)) {
                        log('WARN', 'screen audio loopback invalid ready header');
                        settleStart({ ok: false, reason: 'protocol' });
                        return;
                    }
                    state.buf = state.buf.subarray(4);
                    state.ready = true;
                    settleStart({ ok: true });
                }
                while (state.buf.length >= 8) {
                    if (!state.buf.subarray(0, 4).equals(PCM_MAGIC)) {
                        const idx = state.buf.indexOf(PCM_MAGIC, 1);
                        if (idx === -1) { state.buf = state.buf.subarray(-3); return; }
                        state.buf = state.buf.subarray(idx);
                        if (state.buf.length < 8) return;
                    }
                    const len = state.buf.readUInt32LE(4);
                    if (len !== AUDIO_BLOCK_BYTES) {
                        state.buf = state.buf.subarray(4);
                        continue;
                    }
                    if (state.buf.length < 8 + len) return;
                    const blockBuf = state.buf.subarray(8, 8 + len);
                    state.buf = state.buf.subarray(8 + len);
                    if (!paused) {
                        try { onBlock(deinterleaveStereoFloat32(blockBuf)); } catch { /* ignore */ }
                    }
                }
            });

            const finish = reason => {
                if (state.ended) return;
                const wasReady = state.ready;
                state.ended = true;
                clearTimeout(state.timer);
                if (current === state) current = null;
                if (!wasReady) settleStart({ ok: false, reason });
                else onEnd(reason);
            };
            child.on('error', err => finish(err?.code ?? 'error'));
            child.on('exit', code => finish(code === 0 ? 'stopped' : `exit-${code}`));
        });
    }

    return {
        supported: () => processLoopbackSupported(platform, release),
        start,
        stop,
        setPaused(value) { paused = value === true; },
        active: () => current !== null && current.ready && !current.ended
    };
}
