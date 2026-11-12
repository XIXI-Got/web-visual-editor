import { AboutSection } from './components/AboutSection';
import { DiceIcon } from './components/DiceIcon';
import { Hero } from './components/Hero';
import { Navbar } from './components/Navbar';
import { ScrollVideo } from './components/ScrollVideo';

export default function App() {
  return (
    <>
      <Navbar />
      <DiceIcon />
      <Hero />
      <AboutSection />
      <ScrollVideo />
    </>
  );
}
