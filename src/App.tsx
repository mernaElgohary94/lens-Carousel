import { useCallback, useEffect, useRef, useState } from 'react';
import {
  bootstrapCameraKit,
  createMediaStreamSource,
  Transform2D,
  type CameraKit,
  type CameraKitSession,
  type Lens,
} from '@snap/camera-kit';

const API_TOKEN = import.meta.env.VITE_SNAP_CAMERA_KIT_API_TOKEN as string | undefined;
const LENS_GROUP_ID = import.meta.env.VITE_SNAP_LENS_GROUP_ID as string | undefined;

type Capture = { url: string; type: 'photo' | 'video' } | null;

function fileStamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function triggerDownload(url: string, filename: string) {
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
}

export default function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const kitRef = useRef<CameraKit | null>(null);
  const sessionRef = useRef<CameraKitSession | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const startedRef = useRef(false);

  const [lenses, setLenses] = useState<Lens[]>([]);
  const [selectedLens, setSelectedLens] = useState('');
  const [facing, setFacing] = useState<'user' | 'environment'>('user');
  const [status, setStatus] = useState('Preparing Camera Kit…');
  const [error, setError] = useState('');
  const [recording, setRecording] = useState(false);
  const [capture, setCapture] = useState<Capture>(null);

  const setCamera = useCallback(async (nextFacing: 'user' | 'environment') => {
    const session = sessionRef.current;
    if (!session) return;

    setStatus(`Opening ${nextFacing === 'user' ? 'front' : 'back'} camera…`);
    streamRef.current?.getTracks().forEach((track) => track.stop());
    await session.pause();
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: nextFacing }, width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false,
    });
    streamRef.current = stream;
    const source = createMediaStreamSource(stream, {
      cameraType: nextFacing,
    });
    if (nextFacing === 'user') source.setTransform(Transform2D.MirrorX);
    await session.setSource(source);
    await session.play();
    setFacing(nextFacing);
    setStatus('Ready');
  }, []);

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    let disposed = false;

    async function start() {
      if (!API_TOKEN || !LENS_GROUP_ID) {
        setError('Add your Camera Kit API token and Lens Group ID to a .env file, then restart the app.');
        setStatus('Configuration required');
        return;
      }
      if (!canvasRef.current) return;
      try {
        const cameraKit = await bootstrapCameraKit({ apiToken: API_TOKEN });
        if (disposed) return;
        kitRef.current = cameraKit;
        const session = await cameraKit.createSession({ liveRenderTarget: canvasRef.current });
        sessionRef.current = session;
        const result = await cameraKit.lensRepository.loadLensGroups([LENS_GROUP_ID]);
        if (result.errors.length) throw result.errors[0];
        if (!result.lenses.length) throw new Error('No Lenses were found in this Lens Group.');
        if (disposed) return;
        setLenses(result.lenses);
        setSelectedLens(result.lenses[0].id);
        await session.applyLens(result.lenses[0]);
        await setCamera('user');
      } catch (reason) {
        const message = reason instanceof Error ? reason.message : 'Unable to start Camera Kit.';
        setError(message);
        setStatus('Camera unavailable');
      }
    }
    void start();

    return () => {
      disposed = true;
      streamRef.current?.getTracks().forEach((track) => track.stop());
      void sessionRef.current?.destroy();
      void kitRef.current?.destroy();
    };
  }, [setCamera]);

  const applyLens = async (lensId: string) => {
    const lens = lenses.find((item) => item.id === lensId);
    if (!lens || !sessionRef.current) return;
    try {
      setStatus('Applying Lens…');
      await sessionRef.current.applyLens(lens);
      setSelectedLens(lensId);
      setStatus('Ready');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not apply that Lens.');
    }
  };

  const takePhoto = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.toBlob((blob) => {
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      setCapture((previous) => {
        if (previous) URL.revokeObjectURL(previous.url);
        return { url, type: 'photo' };
      });
    }, 'image/jpeg', 0.95);
  };

  const toggleRecording = () => {
    if (recording) {
      recorderRef.current?.stop();
      return;
    }
    const canvas = canvasRef.current;
    if (!canvas || typeof MediaRecorder === 'undefined') {
      setError('Video recording is not supported in this browser.');
      return;
    }
    const mimeType = MediaRecorder.isTypeSupported('video/webm;codecs=vp9')
      ? 'video/webm;codecs=vp9'
      : 'video/webm';
    chunksRef.current = [];
    const recorder = new MediaRecorder(canvas.captureStream(30), { mimeType });
    recorderRef.current = recorder;
    recorder.ondataavailable = (event) => event.data.size && chunksRef.current.push(event.data);
    recorder.onstop = () => {
      const url = URL.createObjectURL(new Blob(chunksRef.current, { type: mimeType }));
      setCapture((previous) => {
        if (previous) URL.revokeObjectURL(previous.url);
        return { url, type: 'video' };
      });
      setRecording(false);
      setStatus('Video ready to save');
    };
    recorder.start(250);
    setRecording(true);
    setStatus('Recording…');
  };

  const downloadCapture = () => {
    if (!capture) return;
    triggerDownload(capture.url, `snap-lens-${fileStamp()}.${capture.type === 'photo' ? 'jpg' : 'webm'}`);
  };

  return (
    <main className="app-shell">
      <section className="camera-card" aria-label="Snap Lens camera">
        <canvas ref={canvasRef} className="camera-preview" />
        <div className="topbar">
          <span className="brand">SNAP <i>LENS</i></span>
          <button className="icon-button" onClick={() => void setCamera(facing === 'user' ? 'environment' : 'user')} disabled={recording || !sessionRef.current} aria-label="Switch camera">↻</button>
        </div>
        <div className="status" role="status">{status}</div>
        {error && <p className="error">{error}</p>}
        <div className="controls">
          <label className="lens-picker">
            <span>Lens</span>
            <select value={selectedLens} onChange={(event) => void applyLens(event.target.value)} disabled={!lenses.length || recording}>
              {lenses.map((lens) => <option key={lens.id} value={lens.id}>{lens.name}</option>)}
            </select>
          </label>
          <div className="shutter-row">
            <button className="mode-button" onClick={toggleRecording} disabled={!sessionRef.current} aria-pressed={recording}>{recording ? 'Stop' : 'Video'}</button>
            <button className={`shutter ${recording ? 'is-recording' : ''}`} onClick={recording ? toggleRecording : takePhoto} disabled={!sessionRef.current} aria-label={recording ? 'Stop recording' : 'Take photo'}><span /></button>
            <button className="mode-button" onClick={downloadCapture} disabled={!capture}>Save</button>
          </div>
        </div>
      </section>

      {capture && <section className="result-card" aria-live="polite">
        {capture.type === 'photo' ? <img src={capture.url} alt="Captured Lens photo" /> : <video src={capture.url} controls playsInline />}
        <div><strong>{capture.type === 'photo' ? 'Photo captured' : 'Video captured'}</strong><button onClick={downloadCapture}>Download to device</button></div>
      </section>}

      <p className="hint">For mobile camera access, use HTTPS (or localhost during development). Downloads are saved by your mobile browser; choose “Save to Photos/Gallery” if it prompts you.</p>
    </main>
  );
}
