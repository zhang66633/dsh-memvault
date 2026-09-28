/**
 * The native Schemastery schema DSH validates the plugin config against and the
 * Plugins page renders its settings from.
 *
 * Why the import is dynamic and optional: `@deepseek-ai/schemastery` comes from
 * the DSH runtime (declared as a peer, so a linked plugin resolves it through the
 * runtime table). The standalone smoke tests run on plain Node with no
 * `node_modules`, and a static import there would make the whole plugin — and
 * therefore every test, including the ones that have nothing to do with config —
 * unloadable. So the import is attempted once, and `Config` is exported only when
 * it succeeds. In DSH it always does; `apply()` warns loudly if it ever does not.
 *
 * `buildConfigSchema` is a pure function of a Schema implementation, so the tests
 * verify it against the real Schemastery when the machine has one.
 */

import { CONFIG_SPEC } from './config.js'

/** Build a native schema from the spec, using whichever `Schema` is provided. */
export function buildConfigSchema(Schema, spec = CONFIG_SPEC) {
  const node = (field) => {
    let schema
    switch (field.kind) {
      case 'object':
        schema = Schema.object(Object.fromEntries(
          Object.entries(field.fields ?? {}).map(([key, child]) => [key, node(child)]),
        ))
        break
      case 'array':
        schema = field.of?.kind === 'object'
          ? Schema.array(node(field.of))
          : Schema.array(field.of ? node(field.of) : Schema.any())
        break
      case 'dict':
        schema = Schema.dict(Schema.string())
        break
      case 'enum':
        schema = Schema.union(field.values.map((value) => Schema.const(value)))
        break
      case 'boolean':
        schema = Schema.boolean()
        break
      case 'number':
        schema = field.integer ? Schema.natural() : Schema.number()
        break
      default:
        schema = Schema.string()
    }

    // Numbers carry their bounds before the default so a bad default fails loudly
    // at build time rather than at first validation.
    if (field.min !== undefined) schema = schema.min(field.min)
    if (field.max !== undefined) schema = schema.max(field.max)
    if (field.step !== undefined) schema = schema.step(field.step)
    // An object fills its own defaults from its fields; a dict does not, so its
    // default has to be attached explicitly.
    if (field.kind !== 'object' && field.default !== undefined) {
      schema = schema.default(field.default)
    }
    if (field.role) schema = schema.role(field.role)
    if (field.description) schema = schema.description(field.description)
    return schema
  }

  return node({ kind: 'object', fields: spec })
}

let Schema = null
let loadError = null
try {
  const mod = await import('@deepseek-ai/schemastery')
  Schema = mod.default ?? mod
} catch (error) {
  loadError = error
}

/**
 * The plugin's Config export.
 *
 * `undefined` outside a DSH runtime (or if the runtime ever stops shipping
 * Schemastery), which DSH treats as "this plugin declares no schema" — the entry
 * still loads, it just gets no config validation and no settings page.
 */
export const Config = Schema ? buildConfigSchema(Schema) : undefined

/** Whether the schema could be built; `apply()` warns when it could not. */
export const schemaAvailable = Schema !== null

/** Why it could not (`null` when it could). */
export const schemaError = loadError
