import { MarkdownContent } from '@/components/agent/MarkdownContent';
import terms from './conditions.md?raw';
import privacy from './confidentialite.md?raw';
import type { LegalId } from './documents';

const TEXTS: Record<LegalId, string> = { terms, privacy };

/** One published text, rendered. Loaded on demand: the texts stay out of the main bundle. */
export default function LegalDocument({ id }: { id: LegalId }) {
  return <MarkdownContent text={TEXTS[id]} />;
}
