import { Link } from 'react-router-dom';

/** A strength activity whose day already has an unlinked Muscu log: link it rather than log twice. */
export function SameDayLogWarning({ logId }: { logId: number }) {
  return (
    <p role="note" className="text-xs font-sans text-warning-orange">
      Tu as déjà saisi une séance de muscu ce jour-là : lie-la plutôt.{' '}
      <Link to={`/log?session=${logId}`} className="underline min-h-11 inline-flex items-center">
        Ouvrir la séance saisie
      </Link>
    </p>
  );
}
