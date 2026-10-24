export type Schema = Record<string, unknown>;
export interface HumanInterrupt {
  id: string; revision: number;
  payload: { type?: string; name: string; args: Record<string, unknown>; description: string; before?: Record<string, unknown> | null };
  schema: Schema; decision: Record<string, unknown> | null; expires_at: string;
}
export function object(value: unknown): value is Schema { return value !== null && typeof value === 'object' && !Array.isArray(value); }
export function isInterrupt(value: unknown): value is HumanInterrupt {
  return object(value) && typeof value.id === 'string' && value.id.length > 0 && Number.isSafeInteger(value.revision)
    && object(value.payload) && typeof value.payload.name === 'string' && object(value.payload.args)
    && object(value.schema) && (value.decision === null || object(value.decision)) && typeof value.expires_at === 'string' && Number.isFinite(Date.parse(value.expires_at));
}
export function resolveSchema(schema: Schema, root: Schema, depth = 0): Schema {
  if (depth > 12) throw new Error('Schéma trop complexe pour ce formulaire.');
  if (typeof schema.$ref === 'string') {
    if (!schema.$ref.startsWith('#/')) throw new Error('Référence de formulaire non prise en charge.');
    let node: unknown = root;
    for (const key of schema.$ref.slice(2).split('/')) node = object(node) ? node[key.replaceAll('~1', '/').replaceAll('~0', '~')] : undefined;
    if (!object(node)) throw new Error('Référence de formulaire invalide.');
    return resolveSchema(node, root, depth + 1);
  }
  if (Array.isArray(schema.anyOf)) {
    const branches = schema.anyOf.filter((b): b is Schema => object(b) && b.type !== 'null');
    if (branches.length !== 1) throw new Error('Ce choix de structure nécessite un formulaire spécialisé.');
    return resolveSchema(branches[0], root, depth + 1);
  }
  return schema;
}
export function decisionSchemas(root: Schema): Map<string, Schema> {
  const branches = Array.isArray(root.oneOf) ? root.oneOf : Array.isArray(root.anyOf) ? root.anyOf : [root];
  const result = new Map<string, Schema>();
  if (branches.length > 4) throw new Error('Trop de types de décision.');
  for (const branch of branches) {
    if (!object(branch)) throw new Error('Décision invalide.');
    const schema = resolveSchema(branch, root);
    const properties = schema.properties;
    if (!object(properties) || !object(properties.type)) throw new Error('Type de décision absent.');
    const type = resolveSchema(properties.type, root).const;
    if (typeof type !== 'string' || !['approve','edit','reject','respond'].includes(type)) throw new Error('Décision non prise en charge.');
    result.set(type, schema);
  }
  return result;
}
export function validateFormShape(input: Schema, root: Schema, depth = 0, budget = { fields: 0 }): void {
  if (depth > 6 || ++budget.fields > 128) throw new Error('Formulaire trop complexe.');
  const schema = resolveSchema(input, root);
  if (schema.const !== undefined) return;
  if (Array.isArray(schema.enum)) { if (schema.enum.length > 100) throw new Error('Trop de choix.'); return; }
  if (schema.type === 'object' && object(schema.properties)) {
    for (const child of Object.values(schema.properties)) {
      if (!object(child)) throw new Error('Champ invalide.');
      validateFormShape(child, root, depth + 1, budget);
    }
    return;
  }
  if (schema.type === 'array' && object(schema.items)) { validateFormShape(schema.items, root, depth + 1, budget); return; }
  if (['string','number','integer','boolean'].includes(String(schema.type)) && !schema.oneOf) return;
  throw new Error('Ce champ n’est pas pris en charge. La proposition reste consultable.');
}
