import { useQuery } from '@tanstack/react-query';
import { fetchAPI } from '@/lib/api';

interface Attention {
  enabled: boolean;
  primary_ref: string | null;
  remaining: number;
  items: {
    source_ref: string;
    subject_key: string;
    kind: 'approval' | 'question' | 'recap';
    title: string;
    url: string;
    expires_at: string;
  }[];
}
export const attentionKey = ['coaching-attention'] as const;
export function useCoachingAttention(enabled = true) {
  return useQuery({
    queryKey: attentionKey,
    queryFn: () => fetchAPI<Attention>('/coach/attention'),
    enabled,
    retry: false,
    staleTime: 30_000,
  });
}
