import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { strengthApi } from '@/lib/api';
import { qk } from '@/lib/queryKeys';
import type { StrengthDraft } from '@/types';

/** « Ajoute tes charges » on a Garmin strength activity: open its draft, then its screen. */
export function useOpenDraft() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (actualSessionId: number) => strengthApi.openDraft(actualSessionId),
    onSuccess: (draft) => {
      // The Journal finds it at once; its own read confirms it.
      queryClient.setQueryData<StrengthDraft[]>(qk.strengthDrafts, (list) =>
        list?.some((d) => d.id === draft.id) ? list : [draft, ...(list ?? [])]
      );
      navigate(`/log?draft=${draft.id}`);
    },
  });
}
