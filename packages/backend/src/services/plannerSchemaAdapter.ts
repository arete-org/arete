/**
 * @description: Projects canonical planner contract schema into provider-safe tool parameter schemas.
 * @footnote-scope: utility
 * @footnote-module: PlannerSchemaAdapter
 * @footnote-risk: medium - Incorrect projection can cause provider-side planner call rejection.
 * @footnote-ethics: medium - Schema projection quality affects planner reliability and user trust in responses.
 */

const removeTopLevelCombinators = (
    schema: Record<string, unknown>
): Record<string, unknown> => {
    const projectedSchema = { ...schema };
    delete projectedSchema.allOf;
    delete projectedSchema.anyOf;
    delete projectedSchema.oneOf;
    return projectedSchema;
};

export const projectPlannerSchemaForProvider = (
    canonicalSchema: Record<string, unknown>
): Record<string, unknown> => removeTopLevelCombinators(canonicalSchema);
