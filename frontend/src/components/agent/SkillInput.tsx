import { useEffect, useId, useLayoutEffect, useRef, useState, type RefObject, type TextareaHTMLAttributes } from 'react';
import { useQuery } from '@tanstack/react-query';
import { documentRequest } from '@/lib/documents';
import { cn } from '@/lib/utils';

interface SystemSkill { name: string; description: string; path: string }
const MAX_SYSTEM_SKILLS = 32;
const CATALOG_STALE_MS = 60_000;

async function loadSkills(signal: AbortSignal): Promise<SystemSkill[]> {
  const data = await documentRequest<SystemSkill[]>('/agent/skills', { signal });
  if (!Array.isArray(data) || data.length > MAX_SYSTEM_SKILLS || data.some(skill =>
    !skill || typeof skill.name !== 'string' || !/^[a-z0-9-]+$/.test(skill.name) ||
    typeof skill.description !== 'string' || typeof skill.path !== 'string'
  )) throw new Error('Le catalogue des skills est invalide.');
  return data;
}

function normalize(text: string): string {
  return text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}

// Only leading slash commands activate a skill. URLs and slashes in prose stay text.
function commandAt(value: string, caret: number) {
  const prefix = value.slice(0, caret);
  const match = /^\s*(?:\/[a-z0-9-]+\s+)*\/([a-z0-9-]*)$/i.exec(prefix);
  if (!match) return null;
  const start = prefix.lastIndexOf('/');
  const suffix = /^\S*/.exec(value.slice(caret))?.[0] ?? '';
  return { query: match[1], start, end: caret + suffix.length };
}

type Props = Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'value' | 'onChange'> & {
  value: string;
  onValueChange: (value: string) => void;
  inputRef: RefObject<HTMLTextAreaElement | null>;
};

export function SkillInput({ value, onValueChange, inputRef, onKeyDown, onSelect, ...props }: Props) {
  const listId = useId();
  const [caret, setCaret] = useState(value.length);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [highlight, setHighlight] = useState({ key: '', index: 0 });
  const selection = useRef<{ value: string; caret: number } | null>(null);
  useLayoutEffect(() => {
    const pending = selection.current;
    selection.current = null;
    if (!pending || pending.value !== value) return;
    // Restore before paint, never in a later frame that could move new typing.
    inputRef.current?.focus();
    inputRef.current?.setSelectionRange(pending.caret, pending.caret);
  }, [value, inputRef]);
  const command = commandAt(value, caret);
  const key = `${value}:${caret}`;
  const open = command !== null && dismissed !== key;
  const catalog = useQuery({
    queryKey: ['coach-system-skills'],
    queryFn: ({ signal }) => loadSkills(signal),
    enabled: open,
    retry: false,
    staleTime: CATALOG_STALE_MS,
  });
  const query = normalize(command?.query ?? '');
  const matches = (catalog.data ?? []).filter(skill =>
    normalize(`${skill.name} ${skill.description}`).includes(query)
  );
  const index = highlight.key === key ? Math.min(highlight.index, Math.max(0, matches.length - 1)) : 0;
  useEffect(() => {
    if (open) document.getElementById(`${listId}-${index}`)?.scrollIntoView?.({ block: 'nearest' });
  }, [open, listId, index]);

  const choose = (skill: SystemSkill) => {
    if (!command) return;
    const prefix = `${value.slice(0, command.start)}/${skill.name} `;
    const updated = prefix + value.slice(command.end).trimStart();
    selection.current = { value: updated, caret: prefix.length };
    onValueChange(updated);
    setCaret(prefix.length);
    setDismissed(null);
  };

  return <>
    {open && <div className="absolute bottom-full left-0 right-0 z-20 mb-2 overflow-hidden rounded-xl border border-text-muted/20 bg-abyss shadow-xl">
      <p className="border-b border-text-muted/15 px-3 py-2 text-xs text-text-muted">Skills · Entrée pour sélectionner · Échap pour fermer</p>
      {catalog.isPending ? <p role="status" className="px-3 py-3 text-sm text-text-muted">Chargement des skills…</p>
        : catalog.isError ? <div role="alert" className="px-3 py-3 text-sm">
          <p>{catalog.error.message}</p>
          <button type="button" onClick={() => void catalog.refetch()} className="mt-2 text-neon-cyan">Réessayer</button>
        </div>
          : <ul id={listId} role="listbox" aria-label="Skills disponibles" className="max-h-60 overflow-y-auto p-1">
            {matches.map((skill, i) => <li
              key={skill.name}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={i === index}
              onMouseDown={event => event.preventDefault()}
              onMouseEnter={() => setHighlight({ key, index: i })}
              onClick={() => choose(skill)}
              className={cn('cursor-pointer rounded-lg px-3 py-2', i === index ? 'bg-neon-cyan/10' : 'hover:bg-text-muted/10')}
            >
              <p className="text-sm font-medium text-neon-cyan">/{skill.name}</p>
              <p className="mt-0.5 text-xs leading-relaxed text-text-muted">{skill.description}</p>
            </li>)}
            {!matches.length && <li role="presentation" className="px-3 py-3 text-sm text-text-muted">Aucun skill correspondant.</li>}
          </ul>}
    </div>}
    <textarea
      {...props}
      ref={inputRef}
      value={value}
      aria-autocomplete="list"
      aria-haspopup="listbox"
      aria-controls={open && catalog.isSuccess ? listId : undefined}
      aria-activedescendant={open && catalog.isSuccess && matches.length ? `${listId}-${index}` : undefined}
      onChange={event => {
        selection.current = null;
        setCaret(event.target.selectionStart);
        setDismissed(null);
        onValueChange(event.target.value);
      }}
      onSelect={event => { setCaret(event.currentTarget.selectionStart); onSelect?.(event); }}
      onKeyDown={event => {
        if (event.nativeEvent.isComposing) return;
        if (open) {
          if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            setDismissed(key);
            return;
          }
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            if (matches.length) setHighlight({ key, index: (index + (event.key === 'ArrowDown' ? 1 : -1) + matches.length) % matches.length });
            return;
          }
          if ((event.key === 'Enter' && !event.shiftKey) || (event.key === 'Tab' && catalog.isSuccess && matches[index])) {
            // Never send a partially selected command, even while its catalog loads.
            event.preventDefault();
            if (catalog.isSuccess && matches[index]) choose(matches[index]);
            return;
          }
        }
        onKeyDown?.(event);
      }}
    />
  </>;
}
