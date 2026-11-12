import { useEffect, useState } from 'react';
import { Linkedin, Mail, Phone } from 'lucide-react';
import { Reveal } from './Reveal';

const HERO_VIDEO =
  'https://d8j0ntlcm91z4.cloudfront.net/user_38xzZboKViGWJOttwIXH07lWA1P/hf_20260703_154802_dcffa901-509b-4aa3-8e34-36bbf6edcfcb.mp4';

const CORNER =
  'radial-gradient(circle at 100% 0%, transparent 20px, #464340 20px)';

export function Hero() {
  const [opacity, setOpacity] = useState(1);

  useEffect(() => {
    const onScroll = () => {
      setOpacity(Math.max(0, 1 - window.scrollY / (window.innerHeight * 0.6)));
    };

    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  return (
    <>
      <section
        id="top"
        className="fixed inset-0 z-0 flex flex-col bg-[#464340] px-3 py-3 sm:px-4 sm:py-4 md:px-5 md:py-5"
        style={{ opacity }}
      >
        <div className="relative flex-1 rounded-2xl">
          <div className="absolute inset-0 overflow-hidden rounded-2xl">
            <video
              src={HERO_VIDEO}
              autoPlay
              muted
              loop
              playsInline
              className="h-full w-full object-cover"
            />
          </div>

          <div className="relative z-10 flex h-full flex-col justify-between p-5 sm:p-8 md:p-10">
            <Reveal delay={200}>
              <h1 className="pr-24 text-[2.5rem] font-normal leading-[1.05] tracking-tighter text-[#E2DBC8]/80 sm:pr-32 sm:text-6xl md:pr-36 md:text-7xl lg:pr-8 lg:text-8xl">
                Circular systems&nbsp;/
                <br />
                for a cleaner&nbsp;/
                <br />
                planet
              </h1>
            </Reveal>

            <div className="flex flex-col items-center pb-8 text-center">
              <Reveal delay={400}>
                <p className="max-w-xs text-sm text-[#E2DBC8]/80 sm:text-base">
                  Next-Generation Portable Waste /
                  <br />
                  Reclamation Technology
                </p>
              </Reveal>
              <Reveal delay={500} className="mt-5">
                <a
                  href="#about"
                  className="text-xs uppercase tracking-[0.2em] text-[#E2DBC8]/50 transition-colors hover:text-[#E2DBC8]"
                >
                  Start Here
                </a>
              </Reveal>
            </div>
          </div>

          <div className="absolute bottom-0 left-0">
            <div
              className="absolute -top-5 left-0 h-5 w-5"
              style={{ background: CORNER }}
            />
            <div
              className="absolute bottom-0 left-full h-5 w-5"
              style={{ background: CORNER }}
            />
            <div className="flex items-center gap-4 rounded-tr-[20px] bg-[#464340] px-5 py-3">
              <a
                href="https://www.linkedin.com"
                target="_blank"
                rel="noreferrer"
                aria-label="LinkedIn"
                className="text-[#E2DBC8]/60 transition-colors hover:text-[#E2DBC8]"
              >
                <Linkedin size={18} />
              </a>
              <a
                href="tel:"
                aria-label="Phone"
                className="text-[#E2DBC8]/60 transition-colors hover:text-[#E2DBC8]"
              >
                <Phone size={18} />
              </a>
              <a
                href="mailto:hello@terova.com"
                aria-label="Email"
                className="text-[#E2DBC8]/60 transition-colors hover:text-[#E2DBC8]"
              >
                <Mail size={18} />
              </a>
            </div>
          </div>
        </div>
      </section>
      <div className="h-[170vh]" aria-hidden="true" />
    </>
  );
}
