import { ConfidenceSection } from './components/ConfidenceSection';
import { DecisionLab } from './components/DecisionLab';
import { DeveloperQuickstart } from './components/DeveloperQuickstart';
import { EvidenceMatrix } from './components/EvidenceMatrix';
import { FinalCTA } from './components/FinalCTA';
import { Footer } from './components/Footer';
import { Hero } from './components/Hero';
import { HowItWorks } from './components/HowItWorks';
import { IntelligenceBudget } from './components/IntelligenceBudget';
import { MCPSection } from './components/MCPSection';
import { Nav } from './components/Nav';
import { TelegraphDiagram } from './components/TelegraphDiagram';
import { DecisionRunProvider } from './lib/DecisionRunContext';

export default function App() {
  return (
    <div id="product" className="min-h-screen bg-paper">
      <Nav />
      <DecisionRunProvider>
        <main>
          <Hero />
          <DeveloperQuickstart />
          <DecisionLab />
          <ConfidenceSection />
          <IntelligenceBudget />
          <EvidenceMatrix />
          <HowItWorks />
          <TelegraphDiagram />
          <MCPSection />
          <FinalCTA />
        </main>
      </DecisionRunProvider>
      <Footer />
    </div>
  );
}
