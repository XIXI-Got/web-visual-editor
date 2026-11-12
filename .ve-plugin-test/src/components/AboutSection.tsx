import { useRef } from 'react';
import { motion, useScroll, useTransform, type MotionValue } from 'framer-motion';

const COPY =
  "Our planet's ecological balance is shifting at an unprecedented pace. Resource recovery obstacles and contamination crises have surpassed critical limits, and the pursuit of transformative green solutions has never carried more weight.";

type CharProps = {
  char: string;
  index: number;
  total: number;
  scrollYProgress: MotionValue<number>;
};

function AnimatedChar({ char, index, total, scrollYProgress }: CharProps) {
  const start = index / total;
  const end = start + 0.005;
  const opacity = useTransform(scrollYProgress, [start, end], [0.3, 1]);
  const glyph = char === ' ' ? '\u00A0' : char;

  return (
    <span className="relative inline-block">
      <span className="invisible font-normal text-[#E2DBC8]">{glyph}</span>
      <motion.span
        style={{ opacity }}
        className="absolute inset-0 font-normal text-[#E2DBC8]"
      >
        {glyph}
      </motion.span>
    </span>
  );
}

export function AboutSection() {
  const containerRef = useRef<HTMLElement>(null);
  const { scrollYProgress } = useScroll({
    target: containerRef,
    offset: ['start 0.8', 'end 0.2'],
  });

  const words = COPY.split(' ');
  const total = COPY.length;
  let charIndex = 0;

  return (
    <section
      id="about"
      ref={containerRef}
      className="relative z-10 flex min-h-screen items-end bg-[#1C261E] px-5 pb-10 sm:px-8 sm:pb-14 md:px-12 md:pb-16"
    >
      <p className="sr-only">{COPY}</p>
      <p
        aria-hidden="true"
        className="text-2xl font-normal leading-snug tracking-tight sm:text-3xl md:text-5xl lg:text-6xl lg:leading-[1.15]"
      >
        {words.map((word, wordIndex) => {
          const letters = word.split('').map((char) => {
            const index = charIndex;
            charIndex += 1;
            return (
              <AnimatedChar
                key={`${wordIndex}-${index}`}
                char={char}
                index={index}
                total={total}
                scrollYProgress={scrollYProgress}
              />
            );
          });

          const space =
            wordIndex < words.length - 1 ? (
              <AnimatedChar
                key={`${wordIndex}-space`}
                char=" "
                index={charIndex++}
                total={total}
                scrollYProgress={scrollYProgress}
              />
            ) : null;

          return (
            <span key={wordIndex}>
              <span className="inline-block whitespace-nowrap">{letters}</span>
              {space}
            </span>
          );
        })}
      </p>
    </section>
  );
}
