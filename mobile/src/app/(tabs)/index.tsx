import { CanvasScreen } from '@/genui/CanvasScreen';

/** Home has no fixed UI: its canvas is the user's layout, or whatever the agent composes for the last request. */
export default function Home() {
  return <CanvasScreen screen="home" />;
}
