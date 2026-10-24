import { useEffect, useState } from 'react';
import { Button, Input, Select } from '@/components/ui';
import { decisionSchemas, object, resolveSchema, validateFormShape, type HumanInterrupt, type Schema } from '@/lib/humanInput';
import { readableError } from '@/lib/utils';
import { PlanChangeReview } from './PlanChangeReview';

const labels: Record<string,string> = { date:'Date',date_str:'Date',description:'Description',notes:'Notes',question:'Question',message:'Ta réponse',session_id:'Séance',revision:'Révision',sport:'Sport',changes:'Modifications',target_duration_min:'Durée (min)',target_distance_km:'Distance (km)',title:'Titre',mission:'Mission',name:'Nom',answer:'Ta réponse',requires_review:'Validation demandée' };
const control = 'min-h-11 w-full rounded-[var(--radius-control)] border border-border bg-void px-3 py-2 text-sm text-text-primary';
function title(key: string, schema: Schema) { return labels[key] ?? (typeof schema.title === 'string' ? schema.title : key.replaceAll('_',' ')); }
function FieldInput({ schema: raw, root, value, onChange, label, required = false }: { schema: Schema; root: Schema; value: unknown; onChange: (v: unknown) => void; label: string; required?: boolean }) {
  const schema = resolveSchema(raw, root);
  if (schema.const !== undefined) return null;
  if (schema.type === 'object' && object(schema.properties)) {
    const values = object(value) ? value : {};
    const requiredKeys = Array.isArray(schema.required) ? schema.required : [];
    return <fieldset className="space-y-3"><legend className="text-sm text-text-secondary">{label}</legend>{Object.entries(schema.properties).filter(([key]) => !['requires_review','revision'].includes(key)).map(([key, child]) => <FieldInput key={key} schema={child as Schema} root={root} value={values[key]} onChange={v => onChange({ ...values, [key]: v })} label={title(key, child as Schema)} required={requiredKeys.includes(key)} />)}</fieldset>;
  }
  if (schema.type === 'array' && object(schema.items)) {
    const item = resolveSchema(schema.items, root);
    const values = Array.isArray(value) ? value : [];
    if (Array.isArray(item.enum)) return <fieldset><legend className="text-sm">{label}</legend>{item.enum.map(option => <label key={String(option)} className="flex min-h-11 items-center gap-2 text-sm"><input type="checkbox" checked={values.includes(option)} onChange={e => onChange(e.target.checked ? [...values, option] : values.filter(v => v !== option))} />{String(option)}</label>)}</fieldset>;
    return <fieldset className="space-y-2"><legend>{label}</legend>{values.map((itemValue,index) => <FieldInput key={index} schema={schema.items as Schema} root={root} value={itemValue} onChange={v => onChange(values.map((old,i) => i === index ? v : old))} label={`${label} ${index+1}`} />)}<Button variant="ghost" size="sm" type="button" disabled={values.length >= Math.min(50,Number(schema.maxItems ?? 50))} onClick={() => onChange([...values, schemaDefault(schema.items as Schema, root)])}>Ajouter</Button>{values.length > Number(schema.minItems ?? 0) && <Button type="button" variant="ghost" size="sm" onClick={() => onChange(values.slice(0,-1))}>Retirer le dernier</Button>}</fieldset>;
  }
  if (Array.isArray(schema.enum)) return <label className="grid gap-1 text-sm">{label}<Select className={control} required={required} value={value == null ? '' : String(value)} onChange={e => onChange(schema.enum instanceof Array ? schema.enum.find(v => String(v) === e.target.value) : e.target.value)}><option value="">Choisir…</option>{schema.enum.map(v => <option key={String(v)} value={String(v)}>{String(v)}</option>)}</Select></label>;
  if (schema.type === 'boolean') return <label className="flex min-h-11 items-center gap-2 text-sm"><input type="checkbox" checked={value === true} onChange={e => onChange(e.target.checked)} />{label}</label>;
  const numeric = schema.type === 'number' || schema.type === 'integer';
  return <label className="grid gap-1 text-sm">{label}<Input className={control} required={required} type={numeric ? 'number' : schema.format === 'date' ? 'date' : 'text'} min={typeof schema.minimum === 'number' ? schema.minimum : undefined} max={typeof schema.maximum === 'number' ? schema.maximum : undefined} step={schema.type === 'integer' ? 1 : 'any'} minLength={typeof schema.minLength === 'number' ? schema.minLength : undefined} maxLength={Math.min(4000,Number(schema.maxLength ?? 4000))} value={value == null ? '' : String(value)} onChange={e => onChange(numeric && e.target.value !== '' ? Number(e.target.value) : e.target.value)} /></label>;
}
function schemaDefault(input: Schema, root: Schema): unknown {
  const schema = resolveSchema(input, root);
  if (schema.const !== undefined) return schema.const;
  if (schema.default !== undefined) return schema.default;
  if (schema.type === 'boolean') return false;
  if (schema.type === 'array') return [];
  if (schema.type === 'object' && object(schema.properties)) return Object.fromEntries(Object.entries(schema.properties).map(([key,value]) => [key,schemaDefault(value as Schema,root)]).filter(([,value]) => value !== undefined));
  return undefined;
}
function reviewSchema(item: HumanInterrupt, editing: boolean) {
  if (item.payload.type === 'question') return item.schema;
  const decisions = decisionSchemas(item.schema);
  const branch = decisions.get(editing ? 'edit' : 'respond');
  if (!branch) return null;
  if (!editing) return { type:'object', properties:{ message:(branch.properties as Schema).message }, required:['message'] };
  const edited = resolveSchema((branch.properties as Schema).edited_action as Schema,item.schema);
  return (edited.properties as Schema).args as Schema;
}
export function HumanInputCard({ item, onDecision, busy = false }: { item: HumanInterrupt; onDecision: (decision: Record<string,unknown>) => Promise<unknown>; busy?: boolean }) {
  const [editing,setEditing] = useState(false);
  const [value,setValue] = useState<unknown>(() => { try { validateFormShape(item.schema,item.schema); return item.payload.type === 'question' ? schemaDefault(item.schema,item.schema) : { message:'' }; } catch { return {}; } });
  const [pending,setPending] = useState(false);
  const [error,setError] = useState('');
  const [expired,setExpired] = useState(() => Date.parse(item.expires_at) <= Date.now());
  const [groupReady,setGroupReady] = useState(false);
  useEffect(() => { const id=window.setTimeout(() => setExpired(true),Math.max(0,Math.min(2_147_483_647,Date.parse(item.expires_at)-Date.now()))); return () => window.clearTimeout(id); },[item.expires_at]);
  const typed = item.payload.type === 'question';
  const question = typed || item.payload.name === 'ask_athlete';
  const grouped = item.payload.name === 'apply_plan_changes';
  let schema: Schema | null = null;
  let schemaError = '';
  let allowed = new Map<string,Schema>();
  try { if (!typed) allowed=decisionSchemas(item.schema); schema=reviewSchema(item,editing); if (schema) validateFormShape(schema,item.schema); }
  catch (err) { schemaError=readableError(err); }
  const submit = async (decision: Record<string,unknown>) => { setPending(true); setError(''); try { await onDecision(decision); } catch (err) { setError(readableError(err)); } finally { setPending(false); } };
  const disabled = busy || pending || expired || !!schemaError;
  if (item.decision) return <p role="status" className="text-sm text-text-secondary">{question ? 'Réponse enregistrée.' : 'Décision enregistrée.'}</p>;
  return <section className="space-y-3 rounded-[var(--radius-panel)] border border-border p-3" aria-label={question ? 'Question du coach' : 'Proposition du coach'}>
    <p className="text-sm">{question ? String(item.payload.args.question) : item.payload.description}</p>
    {grouped && <PlanChangeReview id={String(item.payload.args.preview_id)} readOnly onReady={setGroupReady} />}
    {!question && !grouped && <dl className="space-y-1 text-sm">{Object.entries(object(item.payload.args.changes) ? { ...Object.fromEntries(Object.entries(item.payload.args).filter(([key]) => key !== 'changes')), ...item.payload.args.changes } : item.payload.args).filter(([key]) => !['revision','requires_review'].includes(key)).map(([key,v]) => <div key={key}><dt className="text-text-secondary">{labels[key] ?? key.replaceAll('_',' ')}</dt><dd className="break-words">{item.payload.before?.[key] !== undefined && <span>{String(item.payload.before[key])} → </span>}{typeof v === 'object' ? JSON.stringify(v) : String(v)}</dd></div>)}</dl>}
    {expired ? <p role="status" className="text-sm text-text-muted">Cette demande a expiré.</p> : <form className="space-y-3" onSubmit={e => { e.preventDefault(); if (schemaError) return; void submit(typed ? value as Record<string,unknown> : editing ? { type:'edit',edited_action:{name:item.payload.name,args:value} } : { type:'respond', ...(value as Record<string,unknown>) }); }}>
      {schemaError && <p role="alert" className="text-sm text-danger-red">{schemaError}</p>}
      {schema && !schemaError && <FieldInput schema={schema} root={item.schema} value={value} onChange={setValue} label={editing ? 'Modifier la proposition' : ''} />}
      <div className="flex flex-wrap gap-2">
        {(typed || allowed.has('respond')) && <Button type="submit" size="sm" strong disabled={disabled || !!schemaError}>Envoyer la réponse</Button>}
        {!editing && allowed.has('approve') && <Button type="button" size="sm" strong disabled={disabled || (grouped && !groupReady)} onClick={() => void submit({type:'approve'})}>Approuver</Button>}
        {editing && <Button type="submit" size="sm" strong disabled={disabled || !!schemaError}>Appliquer les modifications</Button>}
        {!grouped && allowed.has('edit') && <Button type="button" size="sm" variant="ghost" disabled={disabled} onClick={() => { setEditing(!editing); setValue(editing ? {message:''} : item.payload.args); }}>{editing ? 'Annuler la modification' : 'Modifier'}</Button>}
        {allowed.has('reject') && <Button type="button" size="sm" variant="ghost" disabled={disabled} onClick={() => void submit({type:'reject',message:'Refusé par l’athlète'})}>Refuser</Button>}
      </div>
    </form>}
    {error && <p role="alert" className="text-sm text-danger-red">{error}</p>}
  </section>;
}
