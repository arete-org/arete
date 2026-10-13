import { useEffect, useState } from 'react';
import { useIsMutating, useMutation, useQueryClient } from '@tanstack/react-query';
import { Button, Input, Modal, ModalHeader, Select } from '@/components/ui';
import { PrescriptionEditor } from '@/components/PrescriptionEditor';
import { garminApi } from '@/lib/api';
import { invalidateAfterSession } from '@/lib/queryKeys';
import { INCOMPLETE_STEPS, prescriptionReady } from '@/lib/workouts';
import type { PlannedSession } from '@/types';
import {
  planningError,
  saveFields,
  sessionDraft,
  SESSION_TYPES,
  SPORTS,
  TEMPLATES,
} from './sessionForm';

export interface EditorState {
  mode: 'create' | 'edit' | 'duplicate';
  date: string;
  session?: PlannedSession;
}

export function SessionEditor({
  editor,
  onClose,
  onSaved,
}: {
  editor: EditorState;
  onClose: () => void;
  onSaved: (session: PlannedSession) => void;
}) {
  const queryClient = useQueryClient();
  const busy = useIsMutating({ mutationKey: ['workout-action'] }) > 0;
  const [initial] = useState(() => sessionDraft(editor.date, editor.session));
  const [draft, setDraft] = useState(initial);
  const [discard, setDiscard] = useState(false);
  const [templates, setTemplates] = useState(false);
  const [localError, setLocalError] = useState('');
  const dirty = JSON.stringify(initial) !== JSON.stringify(draft);
  const editing = editor.mode === 'edit';
  const title = editing
    ? 'Modifier la séance'
    : editor.mode === 'duplicate'
      ? 'Dupliquer la séance'
      : 'Nouvelle séance';
  const close = () => {
    if (!busy) {
      if (dirty) setDiscard(true);
      else onClose();
    }
  };
  useEffect(() => {
    if (!dirty) return;
    const prevent = (e: BeforeUnloadEvent) => {
      e.preventDefault();
    };
    window.addEventListener('beforeunload', prevent);
    return () => window.removeEventListener('beforeunload', prevent);
  }, [dirty]);
  const save = useMutation({
    mutationKey: ['workout-action', 'planning'],
    retry: false,
    mutationFn: () =>
      editing && editor.session
        ? garminApi.updatePlanned(
            editor.session.id,
            editor.session.revision ?? 1,
            saveFields(draft),
          )
        : garminApi.createPlanned({
            ...draft,
            description: draft.description?.trim(),
            ...(draft.prescription
              ? {
                  target_duration_min: undefined,
                  target_distance_km: undefined,
                  target_hr_zone: undefined,
                  target_intensity: undefined,
                }
              : {}),
          }),
    onSuccess: (session) => {
      invalidateAfterSession(queryClient);
      onSaved(session);
    },
    onError: () => invalidateAfterSession(queryClient),
  });
  return (
    <>
      <Modal
        mobileSheet
        open
        onClose={close}
        label={title}
        className="planning-dialog max-w-[600px] max-h-[92dvh] overflow-y-auto"
      >
        <ModalHeader title={title} onClose={close} tone="text-text-primary" />
        <form
          className="space-y-5"
          onSubmit={(e) => {
            e.preventDefault();
            setLocalError('');
            if (queryClient.isMutating({ mutationKey: ['workout-action'] })) return;
            if (!draft.description?.trim()) {
              setLocalError('Donne un titre à cette séance.');
              return;
            }
            if (draft.prescription && !draft.prescription.steps.length) {
              setLocalError('Ajoute au moins une étape.');
              return;
            }
            if (draft.prescription && !prescriptionReady(draft.prescription)) {
              setLocalError(INCOMPLETE_STEPS);
              return;
            }
            save.mutate();
          }}
        >
          <fieldset disabled={busy} className="space-y-5 min-w-0">
            {!editing && (
              <div className="flex flex-wrap gap-2" aria-label="Point de départ">
                <Button
                  variant={!templates ? 'cyan' : 'ghost'}
                  aria-pressed={!templates}
                  onClick={() => setTemplates(false)}
                >
                  Séance libre
                </Button>
                <Button
                  variant={templates ? 'cyan' : 'ghost'}
                  aria-pressed={templates}
                  onClick={() => setTemplates(true)}
                >
                  Depuis un modèle
                </Button>
              </div>
            )}
            {templates && (
              <div className="ui-inset p-3 space-y-2">
                {TEMPLATES.map((template) => (
                  <Button
                    key={template.label}
                    variant="ghost"
                    fullWidth
                    onClick={() => {
                      setDraft((d) => ({
                        ...d,
                        sport: template.sport,
                        session_type: template.type,
                        description: template.label,
                        prescription: structuredClone(template.prescription),
                      }));
                      setTemplates(false);
                    }}
                  >
                    {template.label}
                  </Button>
                ))}
              </div>
            )}
            {dirty && <p className="text-xs text-warning-orange">Modifications non enregistrées</p>}
            <label className="planning-field">
              Titre
              <Input
                required
                maxLength={500}
                value={draft.description ?? ''}
                onChange={(e) => setDraft((d) => ({ ...d, description: e.target.value }))}
              />
            </label>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <label className="planning-field">
                Date
                <Input
                  type="date"
                  required
                  value={draft.date}
                  onChange={(e) => setDraft((d) => ({ ...d, date: e.target.value }))}
                />
              </label>
              <label className="planning-field">
                Sport
                <Select
                  disabled={editing}
                  value={draft.sport}
                  onChange={(e) =>
                    setDraft((d) => ({
                      ...d,
                      sport: e.target.value,
                      session_type: e.target.value === 'strength' ? 'strength' : 'endurance',
                    }))
                  }
                >
                  {Object.entries(SPORTS).map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </Select>
              </label>
            </div>
            <label className="planning-field">
              Type de séance
              <Select
                value={draft.session_type}
                onChange={(e) => setDraft((d) => ({ ...d, session_type: e.target.value }))}
              >
                {Object.entries(SESSION_TYPES).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </Select>
            </label>
            <section className="space-y-3" aria-label="Étapes de la séance">
              <h4 className="font-semibold text-sm">Étapes de la séance</h4>
              {draft.prescription ? (
                <PrescriptionEditor
                  sport={draft.sport ?? 'running'}
                  value={draft.prescription}
                  onChange={(prescription) => setDraft((d) => ({ ...d, prescription }))}
                />
              ) : (
                <>
                  <div className="grid grid-cols-2 gap-3">
                    <label className="planning-field">
                      Durée (min)
                      <Input
                        type="number"
                        min={1}
                        max={1440}
                        value={draft.target_duration_min ?? ''}
                        onChange={(e) =>
                          setDraft((d) => ({
                            ...d,
                            target_duration_min: e.target.value
                              ? Number(e.target.value)
                              : undefined,
                          }))
                        }
                      />
                    </label>
                    <label className="planning-field">
                      Distance (km)
                      <Input
                        type="number"
                        min={0.1}
                        max={1000}
                        step="any"
                        value={draft.target_distance_km ?? ''}
                        onChange={(e) =>
                          setDraft((d) => ({
                            ...d,
                            target_distance_km: e.target.value ? Number(e.target.value) : undefined,
                          }))
                        }
                      />
                    </label>
                    <label className="planning-field">
                      Zone FC
                      <Select
                        value={draft.target_hr_zone ?? ''}
                        onChange={(e) =>
                          setDraft((d) => ({ ...d, target_hr_zone: e.target.value || undefined }))
                        }
                      >
                        <option value="">Sans cible</option>
                        {['Z1', 'Z2', 'Z3', 'Z4', 'Z5'].map((z) => (
                          <option key={z}>{z}</option>
                        ))}
                      </Select>
                    </label>
                    <label className="planning-field">
                      Intensité
                      <Select
                        value={draft.target_intensity ?? ''}
                        onChange={(e) =>
                          setDraft((d) => ({ ...d, target_intensity: e.target.value || undefined }))
                        }
                      >
                        <option value="">Non précisée</option>
                        <option value="easy">Facile</option>
                        <option value="moderate">Modérée</option>
                        <option value="hard">Dure</option>
                      </Select>
                    </label>
                  </div>
                  <Button
                    onClick={() =>
                      setDraft((d) => ({
                        ...d,
                        prescription: {
                          version: 1,
                          steps: [
                            {
                              kind: 'effort',
                              duration_kind: d.target_duration_min ? 'seconds' : 'lap',
                              value: d.target_duration_min ? d.target_duration_min * 60 : null,
                              steps: [],
                            },
                          ],
                        },
                      }))
                    }
                  >
                    Définir les étapes
                  </Button>
                </>
              )}
            </section>
            <p className="ui-inset p-4 text-xs text-text-secondary">
              {editing
                ? 'Les changements seront enregistrés dans Arete. Une nouvelle action sera nécessaire pour mettre Garmin à jour.'
                : 'Enregistrement dans Arete. L’envoi à Garmin est une action séparée.'}
            </p>
            {(localError || save.error) && (
              <p role="alert" className="text-sm text-danger-red">
                {localError || planningError(save.error)}{' '}
                {save.error &&
                  'Ton brouillon est conservé. Vérifie le planning avant de réessayer.'}
              </p>
            )}
            <div className="planning-dialog-footer flex justify-between gap-3">
              <Button variant="ghost" onClick={close}>
                Annuler
              </Button>
              <Button type="submit" strong loading={save.isPending}>
                {editing
                  ? 'Enregistrer'
                  : editor.mode === 'duplicate'
                    ? 'Créer la copie'
                    : 'Créer la séance'}
              </Button>
            </div>
          </fieldset>
        </form>
      </Modal>
      <Modal
        mobileSheet
        open={discard}
        onClose={() => setDiscard(false)}
        label="Abandonner les modifications ?"
        className="planning-dialog max-w-md"
      >
        <ModalHeader title="Abandonner les modifications ?" onClose={() => setDiscard(false)} />
        <p className="text-sm text-text-secondary mb-5">
          Les changements non enregistrés seront perdus.
        </p>
        <div className="flex flex-wrap gap-3">
          <Button onClick={() => setDiscard(false)}>Continuer à modifier</Button>
          <Button variant="danger" onClick={onClose}>
            Abandonner
          </Button>
        </div>
      </Modal>
    </>
  );
}
