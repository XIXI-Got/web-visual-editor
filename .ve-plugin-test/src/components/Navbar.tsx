import { Reveal } from './Reveal';

export function Navbar() {
  return (
    <div className="fixed right-4 top-4 z-50 sm:right-8 sm:top-7 md:right-12">
      <Reveal>
        <a
          href="#top"
          className="flex items-center gap-2 text-[#E2DBC8] transition-opacity hover:opacity-80"
        >
          <svg
            width="24"
            height="24"
            viewBox="0 0 256 256"
            fill="#E2DBC8"
            aria-hidden="true"
          >
            <path d="M 156 0 C 211.228 0 256 44.772 256 100 L 256 256 L 100 256 C 44.772 256 0 211.228 0 156 L 0 0 Z M 80 80 C 80 133.019 122.981 176 176 176 C 176 122.981 133.019 80 80 80 Z" />
          </svg>
          <span className="text-lg font-semibold tracking-tight">terova</span>
        </a>
      </Reveal>
    </div>
  );
}
