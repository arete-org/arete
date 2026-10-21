import { Link } from 'react-router-dom';
import type { Records } from '@/types';

const day = (iso: string) =>
  new Date(`${iso}T00:00:00`).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', year: '2-digit' });

/** What the records were read from: the recent runs and sessions only, as many as were scanned. */
function scope(records: Records): string {
  const read = (n: number, limit: number, one: string, many: string) =>
    n >= limit ? `tes ${limit} dernières ${many} seulement` : n === 1 ? `ta seule ${one}` : `tes ${n} ${many}`;
  const parts = [
    records.runs_scanned > 0 &&
      `chronos mesurés par la montre sur ${read(records.runs_scanned, records.runs_limit, 'course', 'courses')}`,
    records.sessions_scanned > 0 &&
      `charges sur ${read(records.sessions_scanned, records.sessions_limit, 'séance de force', 'séances de force')} (séries d’échauffement exclues)`,
  ].filter(Boolean);
  const cut = records.runs_scanned >= records.runs_limit || records.sessions_scanned >= records.sessions_limit;
  return [
    `Records récents${parts.length ? ` : ${parts.join(', ')}` : ''}.`,
    cut ? 'Une performance plus ancienne n’y figure pas.' : '',
  ].join(' ').trim();
}

/** Fastest runs and heaviest lifts, from the watch streams and the strength log. */
export function RecordsCard({ records, loading, error }: { records?: Records; loading?: boolean; error?: boolean }) {
  return (
    <section className="analysis-card">
      <header>
        <h3 className="text-[15px] font-medium text-text-primary">Records</h3>
      </header>
      <p className="text-xs text-text-muted">Tes meilleurs chronos et tes charges les plus lourdes, sur tes séances récentes.</p>

      {loading ? (
        <p className="text-sm text-text-muted animate-pulse py-6 text-center">Chargement…</p>
      ) : error || !records ? (
        <p className="text-sm text-danger-red py-6 text-center">Données indisponibles</p>
      ) : (
        <>
          <div className="analysis-records">
            <h4 className="analysis-records-title">Course</h4>
            {records.runs.length === 0 ? (
              <p className="text-sm text-text-muted">
                Aucun chrono : il faut une course d’au moins 1 km enregistrée avec la montre.
              </p>
            ) : (
              <table className="analysis-records-table">
                <thead>
                  <tr>
                    <th scope="col">Distance</th>
                    <th scope="col">Temps</th>
                    <th scope="col">Allure</th>
                    <th scope="col">Date</th>
                  </tr>
                </thead>
                <tbody>
                  {records.runs.map((r) => (
                    <tr key={r.name}>
                      <th scope="row">{r.name}</th>
                      <td>
                        <Link
                          to={`/log/sessions/${r.session_id}`}
                          className="analysis-records-link"
                          aria-label={`${r.name} en ${r.time_display}, voir la séance${r.session_name ? ` « ${r.session_name} »` : ''}`}
                        >
                          {r.time_display}
                        </Link>
                      </td>
                      <td>{r.pace_display}</td>
                      <td>{day(r.date)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          <div className="analysis-records">
            <h4 className="analysis-records-title">Force</h4>
            {records.lifts.length === 0 ? (
              <p className="text-sm text-text-muted">Aucune charge : enregistre une séance de force avec ses séries.</p>
            ) : (
              <table className="analysis-records-table">
                <thead>
                  <tr>
                    <th scope="col">Exercice</th>
                    <th scope="col">1RM estimé</th>
                    <th scope="col">Série</th>
                    <th scope="col">Date</th>
                  </tr>
                </thead>
                <tbody>
                  {records.lifts.map((l) => (
                    <tr key={l.exercise}>
                      <th scope="row">{l.exercise}</th>
                      <td>{l.e1rm_kg.toLocaleString('fr-FR')} kg</td>
                      <td>{l.reps} × {l.weight_kg.toLocaleString('fr-FR')} kg</td>
                      <td>{day(l.date)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          <p className="text-xs text-text-muted">{scope(records)}</p>
        </>
      )}
    </section>
  );
}
