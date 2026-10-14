import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { MessageSquare } from "lucide-react";
import { slackApi } from "@/lib/slack";

/**
 * Arete in Slack: the athlete is recognised by their Slack profile address,
 * so there is nothing to connect, only whether channel answers may be public.
 */
export function SlackConnection() {
  const cache = useQueryClient();
  const { data } = useQuery({
    queryKey: ["slackPreferences"],
    queryFn: slackApi.preferences,
  });
  const update = useMutation({
    mutationFn: slackApi.setPublicReplies,
    onSuccess: (result) => cache.setQueryData(["slackPreferences"], result),
  });
  if (!data?.available) return null;
  return (
    <div className="flex items-start gap-4 p-4 rounded bg-abyss/50 border border-text-muted/20">
      <MessageSquare className="w-6 h-6 text-text-muted" />
      <div className="flex-1 space-y-2">
        <div className="font-sans text-sm text-text-primary">Slack</div>
        <p className="text-xs text-text-muted">
          Écris à Arete en message privé sur Slack. Il te reconnaît à l’adresse
          e-mail de ton profil Slack, qui doit être celle de ton compte Arete.
        </p>
        <label className="flex items-start gap-3 cursor-pointer">
          <input
            type="checkbox"
            className="accent-neon-cyan mt-0.5"
            checked={data.public_replies}
            disabled={update.isPending}
            onChange={(e) => update.mutate(e.target.checked)}
          />
          <span className="text-sm text-text-secondary">
            Autoriser Arete à me répondre en public dans les canaux Slack
            <br />
            <span className="text-xs text-text-muted">
              Dans chaque canal où Arete est invité, tous les membres liront
              ses réponses, avec tes données d’entraînement et de récupération.
              Désactivé : quand tu le mentionnes dans un canal, il te répond en
              message privé.
            </span>
          </span>
        </label>
        {update.isError && (
          <p className="text-xs text-danger-red" role="alert">
            Réglage Slack non enregistré. Réessaie.
          </p>
        )}
      </div>
    </div>
  );
}
