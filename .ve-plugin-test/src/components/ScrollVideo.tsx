import { useEffect, useRef, useState, type ReactNode } from 'react';

const VIDEO_URL =
  'https://d8j0ntlcm91z4.cloudfront.net/user_38xzZboKViGWJOttwIXH07lWA1P/hf_20260703_102446_48ac5215-4f23-49f4-a433-ec9798029150.mp4';

const MAX_FRAMES = 120;
const MAX_WIDTH = 1280;

function clamp(value: number, min = 0, max = 1) {
  return Math.min(max, Math.max(min, value));
}

function sectionOpacity(
  progress: number,
  fadeInStart: number,
  fadeInEnd: number,
  fadeOutStart: number,
  fadeOutEnd: number,
) {
  if (progress < fadeInStart) return 0;
  if (progress < fadeInEnd) {
    return (progress - fadeInStart) / (fadeInEnd - fadeInStart);
  }
  if (progress < fadeOutStart) return 1;
  if (progress < fadeOutEnd) {
    return 1 - (progress - fadeOutStart) / (fadeOutEnd - fadeOutStart);
  }
  return 0;
}

function drawCover(
  ctx: CanvasRenderingContext2D,
  frame: ImageBitmap,
  width: number,
  height: number,
) {
  const scale = Math.max(width / frame.width, height / frame.height);
  const drawWidth = frame.width * scale;
  const drawHeight = frame.height * scale;
  const x = (width - drawWidth) / 2;
  const y = (height - drawHeight) / 2;
  ctx.clearRect(0, 0, width, height);
  ctx.drawImage(frame, x, y, drawWidth, drawHeight);
}

function abortError() {
  return new Error('aborted');
}

function waitForData(video: HTMLVideoElement, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (video.readyState >= 2) {
      resolve();
      return;
    }

    const onOk = () => {
      cleanup();
      resolve();
    };
    const onErr = () => {
      cleanup();
      reject(new Error('Video failed to load'));
    };
    const onAbort = () => {
      cleanup();
      reject(abortError());
    };
    const cleanup = () => {
      video.removeEventListener('loadeddata', onOk);
      video.removeEventListener('error', onErr);
      signal.removeEventListener('abort', onAbort);
    };

    video.addEventListener('loadeddata', onOk, { once: true });
    video.addEventListener('error', onErr, { once: true });
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function seekTo(video: HTMLVideoElement, time: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (Math.abs(video.currentTime - time) < 0.0005 && video.readyState >= 2) {
      resolve();
      return;
    }

    const onOk = () => {
      cleanup();
      resolve();
    };
    const onErr = () => {
      cleanup();
      reject(new Error('Video seek failed'));
    };
    const onAbort = () => {
      cleanup();
      reject(abortError());
    };
    const cleanup = () => {
      video.removeEventListener('seeked', onOk);
      video.removeEventListener('error', onErr);
      signal.removeEventListener('abort', onAbort);
    };

    video.addEventListener('seeked', onOk, { once: true });
    video.addEventListener('error', onErr, { once: true });
    signal.addEventListener('abort', onAbort, { once: true });
    video.currentTime = time;
  });
}

async function extractFrames(
  url: string,
  signal: AbortSignal,
): Promise<ImageBitmap[]> {
  const video = document.createElement('video');
  video.crossOrigin = 'anonymous';
  video.muted = true;
  video.playsInline = true;
  video.preload = 'auto';

  const ready = waitForData(video, signal);
  video.src = url;
  await ready;

  if (!video.videoWidth || !video.duration) {
    throw new Error('Video metadata unavailable');
  }

  const count = Math.min(MAX_FRAMES, Math.max(2, Math.round(video.duration * 24)));
  const width = Math.min(MAX_WIDTH, video.videoWidth);
  const height = Math.round((video.videoHeight / video.videoWidth) * width);
  const frames: ImageBitmap[] = [];

  try {
    for (let i = 0; i < count; i += 1) {
      if (signal.aborted) throw abortError();

      const time = (i / (count - 1)) * Math.max(0, video.duration - 0.04);
      await seekTo(video, time, signal);

      const bitmap = await createImageBitmap(video, {
        resizeWidth: width,
        resizeHeight: height,
      });
      frames.push(bitmap);
    }
  } catch (error) {
    frames.forEach((frame) => frame.close());
    throw error;
  } finally {
    video.removeAttribute('src');
    video.load();
    video.remove();
  }

  return frames;
}

type StatBlockProps = {
  opacity: number;
  heading: string;
  delay?: number;
  children: ReactNode;
};

function StatBlock({ opacity, heading, delay = 0, children }: StatBlockProps) {
  const visible = opacity > 0.05;

  return (
    <div
      className="absolute inset-0 flex flex-col justify-end px-5 pb-16 sm:px-8 sm:pb-20 md:px-12 md:pb-24"
      style={{ opacity }}
    >
      <h2
        className={`text-4xl font-normal tracking-tighter text-[#E2DBC8] transition-all duration-700 ease-out will-change-transform sm:text-5xl md:text-7xl lg:text-8xl ${
          visible ? 'translate-y-0' : 'translate-y-8'
        }`}
      >
        {heading}
      </h2>
      <p
        className={`mt-4 text-sm text-[#E2DBC8]/70 transition-all duration-700 ease-out will-change-transform sm:text-base ${
          visible ? 'translate-y-0' : 'translate-y-8'
        }`}
        style={{ transitionDelay: `${delay}ms` }}
      >
        {children}
      </p>
    </div>
  );
}

export function ScrollVideo() {
  const containerRef = useRef<HTMLElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const fallbackRef = useRef<HTMLVideoElement>(null);
  const framesRef = useRef<ImageBitmap[]>([]);
  const progressRef = useRef(0);
  const smoothedRef = useRef(0);
  const useCanvasRef = useRef(false);

  const [progress, setProgress] = useState(0);
  const [useCanvas, setUseCanvas] = useState(false);

  useEffect(() => {
    const controller = new AbortController();

    extractFrames(VIDEO_URL, controller.signal)
      .then((frames) => {
        if (controller.signal.aborted || frames.length === 0) return;
        framesRef.current = frames;
        useCanvasRef.current = true;
        setUseCanvas(true);
      })
      .catch((error: unknown) => {
        if (error instanceof Error && error.message === 'aborted') return;
        useCanvasRef.current = false;
        setUseCanvas(false);
      });

    return () => {
      controller.abort();
      framesRef.current.forEach((frame) => frame.close());
      framesRef.current = [];
    };
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    const fallback = fallbackRef.current;
    let raf = 0;
    let seeking = false;

    const resize = () => {
      if (!canvas) return;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const width = window.innerWidth;
      const height = window.innerHeight;
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      const ctx = canvas.getContext('2d');
      ctx?.setTransform(dpr, 0, 0, dpr, 0, 0);
    };

    const readProgress = () => {
      const el = containerRef.current;
      if (!el) return 0;
      const scrollable = el.offsetHeight - window.innerHeight;
      if (scrollable <= 0) return 0;
      return clamp(-el.getBoundingClientRect().top / scrollable);
    };

    let lastPosted = -1;

    const tick = () => {
      progressRef.current = readProgress();
      smoothedRef.current += (progressRef.current - smoothedRef.current) * 0.1;
      const smoothed = smoothedRef.current;
      const posted = Math.round(smoothed * 500) / 500;
      if (posted !== lastPosted) {
        lastPosted = posted;
        setProgress(posted);
      }

      if (useCanvasRef.current && canvas) {
        const frames = framesRef.current;
        const ctx = canvas.getContext('2d');
        if (ctx && frames.length) {
          const index = Math.min(
            frames.length - 1,
            Math.floor(smoothed * (frames.length - 1)),
          );
          drawCover(ctx, frames[index], window.innerWidth, window.innerHeight);
        }
      } else if (fallback && fallback.duration && !seeking) {
        const nextTime = smoothed * fallback.duration;
        if (Math.abs(fallback.currentTime - nextTime) > 0.03) {
          seeking = true;
          const onSeeked = () => {
            seeking = false;
            fallback.removeEventListener('seeked', onSeeked);
          };
          fallback.addEventListener('seeked', onSeeked);
          fallback.currentTime = nextTime;
        }
      }

      raf = requestAnimationFrame(tick);
    };

    resize();
    window.addEventListener('resize', resize);
    raf = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', resize);
    };
  }, []);

  const firstOpacity = sectionOpacity(progress, 0, 0.2, 0.45, 0.55);
  const secondOpacity = sectionOpacity(progress, 0.5, 0.6, 0.85, 1);

  return (
    <section ref={containerRef} className="relative z-10 h-[400vh]">
      <div className="sticky top-0 -z-10 h-screen w-full bg-[#0a0a0a]">
        <canvas
          ref={canvasRef}
          className={`absolute inset-0 h-full w-full ${useCanvas ? 'block' : 'hidden'}`}
        />
        <video
          ref={fallbackRef}
          src={VIDEO_URL}
          muted
          playsInline
          preload="auto"
          onPlay={(event) => event.currentTarget.pause()}
          className={`absolute inset-0 h-full w-full object-cover ${useCanvas ? 'hidden' : 'block'}`}
        />
        <div className="absolute inset-0 bg-black/20" />
        <div
          className="absolute inset-x-0 top-0 h-40 sm:h-56 md:h-72"
          style={{
            background: 'linear-gradient(to bottom, #1C261E, transparent)',
          }}
        />
      </div>

      <div className="pointer-events-none absolute inset-0">
        <div className="sticky top-0 z-10 h-screen">
          <StatBlock opacity={firstOpacity} heading="2.01 billion">
            <span className="block max-w-lg leading-relaxed">
              Tons of household and commercial refuse produced every single
              year. Lined up in hauling vehicles, this debris would circle the
              globe{' '}
              <span className="inline-flex items-center rounded bg-[#4caf50] px-2 py-0.5 text-xs font-semibold text-[#E2DBC8] sm:text-sm">
                24 times
              </span>
            </span>
          </StatBlock>

          <StatBlock opacity={secondOpacity} heading="under a fifth" delay={100}>
            Of all refuse is reclaimed each year
          </StatBlock>
        </div>
      </div>
    </section>
  );
}
