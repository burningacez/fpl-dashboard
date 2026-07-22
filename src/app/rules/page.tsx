import type { Metadata } from 'next';
import { RulesContent } from './RulesContent';

export const metadata: Metadata = { title: 'Rules & Info' };

// Thin server shell; the content is a client component so it can render the
// *selected* season's rules from season-config.ts.
export default function RulesPage() {
  return <RulesContent />;
}
