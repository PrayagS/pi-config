/**
 * Lightweight, zero-dependency JSON Schema argument validator for the MCP
 * boundary. Rejects malformed model tool calls with path-level diagnostics
 * directly over MCP before handing them to Pi.
 * @module pi-agy-acp/schema-validate
 */

/** Validation outcome for one MCP tool call argument payload. */
export type SchemaValidationResult =
  | { valid: true }
  | { valid: false; errors: string[] }

const MAX_ERRORS = 12

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function describeType(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  if (typeof value === 'number')
    return Number.isInteger(value) ? 'integer' : 'number'
  return typeof value
}

function matchesSingleType(value: unknown, expected: string): boolean {
  switch (expected) {
    case 'null':
      return value === null
    case 'boolean':
      return typeof value === 'boolean'
    case 'string':
      return typeof value === 'string'
    case 'number':
      return typeof value === 'number' && Number.isFinite(value)
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value)
    case 'array':
      return Array.isArray(value)
    case 'object':
      return isPlainObject(value)
    default:
      return true
  }
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true
  if (typeof a !== typeof b || a === null || b === null) return false
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length)
      return false
    for (let i = 0; i < a.length; i++) {
      if (!deepEqual(a[i], b[i])) return false
    }
    return true
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const keysA = Object.keys(a)
    const keysB = Object.keys(b)
    if (keysA.length !== keysB.length) return false
    for (const key of keysA) {
      if (!Object.prototype.hasOwnProperty.call(b, key)) return false
      if (!deepEqual(a[key], b[key])) return false
    }
    return true
  }
  return false
}

function resolveRef(
  root: Record<string, unknown>,
  ref: string,
): Record<string, unknown> | undefined {
  if (!ref.startsWith('#/')) return undefined
  const segments = ref
    .slice(2)
    .split('/')
    .map((s) => s.replace(/~1/g, '/').replace(/~0/g, '~'))
  let cursor: unknown = root
  for (const seg of segments) {
    if (!isPlainObject(cursor)) return undefined
    cursor = cursor[seg]
  }
  return isPlainObject(cursor) ? cursor : undefined
}

function formatChildPath(base: string, key: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key)
    ? `${base}.${key}`
    : `${base}[${JSON.stringify(key)}]`
}

function validateNode(
  value: unknown,
  schema: unknown,
  root: Record<string, unknown>,
  path: string,
  errors: string[],
  seenRefs: ReadonlySet<string>,
): void {
  if (errors.length >= MAX_ERRORS) return
  if (typeof schema === 'boolean') {
    if (!schema) errors.push(`${path}: value is disallowed by schema`)
    return
  }
  if (!isPlainObject(schema)) return

  if (typeof schema.$ref === 'string') {
    if (!seenRefs.has(schema.$ref)) {
      const target = resolveRef(root, schema.$ref)
      if (target !== undefined) {
        const nextSeen = new Set(seenRefs)
        nextSeen.add(schema.$ref)
        validateNode(value, target, root, path, errors, nextSeen)
      }
    }
  }

  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type)
      ? schema.type.filter((t): t is string => typeof t === 'string')
      : typeof schema.type === 'string'
        ? [schema.type]
        : []
    if (types.length > 0 && !types.some((t) => matchesSingleType(value, t))) {
      errors.push(
        `${path}: expected ${types.join(' | ')}, got ${describeType(value)}`,
      )
      return
    }
  }

  if (Object.prototype.hasOwnProperty.call(schema, 'const')) {
    if (!deepEqual(value, schema.const)) {
      errors.push(`${path}: must equal ${JSON.stringify(schema.const)}`)
    }
  }

  if (Array.isArray(schema.enum)) {
    if (!schema.enum.some((candidate) => deepEqual(value, candidate))) {
      const preview = schema.enum
        .slice(0, 8)
        .map((v) => JSON.stringify(v))
        .join(', ')
      const more = schema.enum.length > 8 ? ', …' : ''
      errors.push(`${path}: must be one of ${preview}${more}`)
    }
  }

  if (Array.isArray(schema.allOf)) {
    for (const branch of schema.allOf) {
      validateNode(value, branch, root, path, errors, seenRefs)
      if (errors.length >= MAX_ERRORS) return
    }
  }

  if (Array.isArray(schema.anyOf) && schema.anyOf.length > 0) {
    const matched = schema.anyOf.some((branch) => {
      const branchErrors: string[] = []
      validateNode(value, branch, root, path, branchErrors, seenRefs)
      return branchErrors.length === 0
    })
    if (!matched) {
      errors.push(`${path}: value does not match any allowed schema variant`)
    }
  }

  if (Array.isArray(schema.oneOf) && schema.oneOf.length > 0) {
    let matches = 0
    for (const branch of schema.oneOf) {
      const branchErrors: string[] = []
      validateNode(value, branch, root, path, branchErrors, seenRefs)
      if (branchErrors.length === 0) matches++
    }
    if (matches !== 1) {
      errors.push(
        matches === 0
          ? `${path}: value does not match any allowed schema variant`
          : `${path}: value matched multiple exclusive schema variants`,
      )
    }
  }

  if (schema.not !== undefined) {
    const notErrors: string[] = []
    validateNode(value, schema.not, root, path, notErrors, seenRefs)
    if (notErrors.length === 0) {
      errors.push(`${path}: value matches disallowed schema`)
    }
  }

  if (typeof value === 'string') {
    if (
      typeof schema.minLength === 'number' &&
      value.length < schema.minLength
    ) {
      errors.push(
        `${path}: string length ${value.length} is less than minimum ${schema.minLength}`,
      )
    }
    if (
      typeof schema.maxLength === 'number' &&
      value.length > schema.maxLength
    ) {
      errors.push(
        `${path}: string length ${value.length} exceeds maximum ${schema.maxLength}`,
      )
    }
    if (typeof schema.pattern === 'string') {
      try {
        if (!new RegExp(schema.pattern).test(value)) {
          errors.push(`${path}: string does not match pattern ${schema.pattern}`)
        }
      } catch {
        // Ignore invalid regexes supplied by third-party tool schemas.
      }
    }
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    if (typeof schema.minimum === 'number' && value < schema.minimum) {
      errors.push(`${path}: ${value} is less than minimum ${schema.minimum}`)
    }
    if (typeof schema.maximum === 'number' && value > schema.maximum) {
      errors.push(`${path}: ${value} exceeds maximum ${schema.maximum}`)
    }
    if (
      typeof schema.exclusiveMinimum === 'number' &&
      value <= schema.exclusiveMinimum
    ) {
      errors.push(
        `${path}: ${value} must be greater than ${schema.exclusiveMinimum}`,
      )
    }
    if (
      typeof schema.exclusiveMaximum === 'number' &&
      value >= schema.exclusiveMaximum
    ) {
      errors.push(
        `${path}: ${value} must be less than ${schema.exclusiveMaximum}`,
      )
    }
    if (
      typeof schema.multipleOf === 'number' &&
      schema.multipleOf > 0 &&
      Math.abs(value / schema.multipleOf - Math.round(value / schema.multipleOf)) >
        1e-9
    ) {
      errors.push(`${path}: ${value} must be a multiple of ${schema.multipleOf}`)
    }
  }

  if (Array.isArray(value)) {
    if (typeof schema.minItems === 'number' && value.length < schema.minItems) {
      errors.push(
        `${path}: array length ${value.length} is less than minItems ${schema.minItems}`,
      )
    }
    if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) {
      errors.push(
        `${path}: array length ${value.length} exceeds maxItems ${schema.maxItems}`,
      )
    }
    if (schema.items !== undefined) {
      if (Array.isArray(schema.items)) {
        for (let i = 0; i < Math.min(value.length, schema.items.length); i++) {
          validateNode(
            value[i],
            schema.items[i],
            root,
            `${path}[${i}]`,
            errors,
            seenRefs,
          )
          if (errors.length >= MAX_ERRORS) return
        }
      } else {
        for (let i = 0; i < value.length; i++) {
          validateNode(
            value[i],
            schema.items,
            root,
            `${path}[${i}]`,
            errors,
            seenRefs,
          )
          if (errors.length >= MAX_ERRORS) return
        }
      }
    }
  }

  if (isPlainObject(value)) {
    const required = Array.isArray(schema.required)
      ? schema.required.filter((r): r is string => typeof r === 'string')
      : []
    for (const key of required) {
      if (
        !Object.prototype.hasOwnProperty.call(value, key) ||
        value[key] === undefined
      ) {
        errors.push(`${formatChildPath(path, key)}: missing required property`)
        if (errors.length >= MAX_ERRORS) return
      }
    }

    const props = isPlainObject(schema.properties) ? schema.properties : undefined
    const patternProps = isPlainObject(schema.patternProperties)
      ? Object.entries(schema.patternProperties).flatMap(([pat, sub]) => {
          try {
            return [[new RegExp(pat), sub] as const]
          } catch {
            return []
          }
        })
      : []

    for (const [key, propValue] of Object.entries(value)) {
      if (propValue === undefined) continue
      const childPath = formatChildPath(path, key)
      let matchedProp = false
      if (props !== undefined && Object.prototype.hasOwnProperty.call(props, key)) {
        matchedProp = true
        validateNode(propValue, props[key], root, childPath, errors, seenRefs)
        if (errors.length >= MAX_ERRORS) return
      }
      for (const [regex, subSchema] of patternProps) {
        if (regex.test(key)) {
          matchedProp = true
          validateNode(propValue, subSchema, root, childPath, errors, seenRefs)
          if (errors.length >= MAX_ERRORS) return
        }
      }
      if (!matchedProp && schema.additionalProperties !== undefined) {
        if (schema.additionalProperties === false) {
          errors.push(`${childPath}: unexpected additional property`)
          if (errors.length >= MAX_ERRORS) return
        } else if (isPlainObject(schema.additionalProperties)) {
          validateNode(
            propValue,
            schema.additionalProperties,
            root,
            childPath,
            errors,
            seenRefs,
          )
          if (errors.length >= MAX_ERRORS) return
        }
      }
    }
  }
}

/**
 * Validate `args` against a tool's full JSON Schema `inputSchema`.
 * @param inputSchema - full tool parameter schema.
 * @param args - parsed tool arguments object.
 * @returns `{ valid: true }` or `{ valid: false, errors }` with path-level diagnostics.
 */
export function validateToolArguments(
  inputSchema: Record<string, unknown>,
  args: unknown,
): SchemaValidationResult {
  const errors: string[] = []
  validateNode(args, inputSchema, inputSchema, '$', errors, new Set())
  return errors.length === 0 ? { valid: true } : { valid: false, errors }
}

/** Format a concise, model-actionable error string for invalid tool arguments. */
export function formatValidationError(
  toolName: string,
  errors: readonly string[],
): string {
  return `Invalid arguments for tool "${toolName}":\n- ${errors.join('\n- ')}`
}
