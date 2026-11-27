import { Ajv, type ErrorObject, type ValidateFunction } from 'ajv'
import type { Static, TSchema } from 'typebox'

const ajv = new Ajv({
  allErrors: true,
  coerceTypes: false,
  removeAdditional: false,
  useDefaults: false,
  strict: false,
})

/** Compile a TypeBox or JSON schema with Outpost's strict validation settings. */
export function compileSchema<S extends TSchema>(schema: S): ValidateFunction<Static<S>> {
  return ajv.compile<Static<S>>(schema)
}

export function compileJsonSchema<T = unknown>(schema: object): ValidateFunction<T> {
  return ajv.compile<T>(schema)
}

export function schemaErrorsText(errors: ErrorObject[] | null | undefined): string {
  return ajv.errorsText(errors)
}
