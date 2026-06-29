/**
 * script.json 的 argForm 与 CLI defaultArgs 互转、人类可读摘要。
 */

/** @typedef {'info'|'boolean'|'text'|'number'|'select'|'multiselect'} ArgFieldType */

/**
 * @param {string[]} argv
 * @returns {Record<string, string | boolean>}
 */
export function argvToFlagMap(argv) {
  /** @type {Record<string, string | boolean>} */
  const map = {}
  const list = Array.isArray(argv) ? argv : []
  for (let i = 0; i < list.length; i += 1) {
    const a = String(list[i] || '')
    if (!a.startsWith('--')) continue
    const next = list[i + 1]
    if (next !== undefined && !String(next).startsWith('--')) {
      map[a] = String(next)
      i += 1
    } else {
      map[a] = true
    }
  }
  return map
}

/**
 * @param {unknown} raw
 * @returns {object[]}
 */
export function normalizeArgForm(raw) {
  if (!raw || typeof raw !== 'object') return []
  if (Array.isArray(raw)) return raw.filter((f) => f && typeof f === 'object')
  if (Array.isArray(raw.fields)) return raw.fields.filter((f) => f && typeof f === 'object')
  return []
}

/**
 * @param {object[]} form
 * @param {Record<string, string | boolean>} flagMap
 * @returns {Record<string, unknown>}
 */
export function flagMapToFormValues(form, flagMap) {
  /** @type {Record<string, unknown>} */
  const values = {}
  for (const field of form) {
    const id = String(field.id || field.flag || '')
    if (!id || field.type === 'info') continue

    if (field.type === 'boolean') {
      const flag = String(field.flag || '')
      if (field.asFlag && flag) {
        values[id] = flagMap[flag] === true || flagMap[flag] === 'true'
      } else {
        values[id] = Boolean(field.default)
      }
      continue
    }

    const flag = String(field.flag || '')
    if (!flag) continue
    const raw = flagMap[flag]

    if (field.type === 'multiselect') {
      if (raw === undefined || raw === '') {
        values[id] = Array.isArray(field.default) ? [...field.default] : []
      } else {
        try {
          const parsed = JSON.parse(String(raw))
          values[id] = Array.isArray(parsed) ? parsed.map(String) : [String(parsed)]
        } catch {
          values[id] = String(raw)
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean)
        }
      }
      continue
    }

    if (raw === undefined || raw === '') {
      values[id] =
        field.default !== undefined && field.default !== null ? field.default : field.type === 'number' ? '' : ''
    } else if (field.type === 'number') {
      values[id] = Number(raw)
    } else {
      values[id] = String(raw)
    }
  }
  return values
}

/**
 * @param {object[]} form
 * @param {Record<string, unknown>} values
 * @returns {string[]}
 */
export function formValuesToArgv(form, values) {
  /** @type {string[]} */
  const args = []
  for (const field of form) {
    if (field.type === 'info') continue
    const id = String(field.id || field.flag || '')
    const flag = String(field.flag || '')
    const v = values[id]

    if (field.type === 'boolean') {
      if (field.asFlag && flag && v) args.push(flag)
      continue
    }

    if (!flag) continue

    if (field.type === 'multiselect') {
      const arr = Array.isArray(v) ? v.map(String).filter(Boolean) : []
      if (arr.length) args.push(flag, JSON.stringify(arr))
      continue
    }

    if (field.type === 'number') {
      const n = Number(v)
      if (Number.isFinite(n)) args.push(flag, String(n))
      continue
    }

    const s = v === undefined || v === null ? '' : String(v).trim()
    if (s) args.push(flag, s)
  }
  return args
}

/**
 * @param {string[]} argv
 * @param {object[]} form
 * @returns {string}
 */
export function formatArgvHumanSummary(argv, form) {
  if (!form.length) {
    return argv.join(' ') || '（无）'
  }
  const map = argvToFlagMap(argv)
  const values = flagMapToFormValues(form, map)
  const lines = []
  for (const field of form) {
    if (field.type === 'info') continue
    const id = String(field.id || field.flag || '')
    const label = String(field.label || id)
    const v = values[id]
    if (field.type === 'boolean') {
      if (field.asFlag) lines.push(`${label}：${v ? '是' : '否'}`)
      continue
    }
    if (field.type === 'multiselect') {
      const arr = Array.isArray(v) ? v : []
      const opts = Array.isArray(field.options) ? field.options : []
      const labels = arr.map((code) => {
        const hit = opts.find((o) => String(o.value) === String(code))
        return hit ? `${hit.label || code} (${code})` : code
      })
      lines.push(`${label}：${labels.length ? labels.join('、') : '（未选）'}`)
      continue
    }
    if (v === '' || v === undefined || v === null) continue
    if (field.type === 'select') {
      const opts = Array.isArray(field.options) ? field.options : []
      const hit = opts.find((o) => String(o.value) === String(v))
      lines.push(`${label}：${hit ? hit.label || v : v}`)
      continue
    }
    lines.push(`${label}：${v}`)
  }
  return lines.length ? lines.join('\n') : '（无）'
}

/**
 * @param {object[]} form
 * @param {string[]} argv
 * @returns {Record<string, unknown>}
 */
export function defaultFormValues(form, argv) {
  const fromArgv = flagMapToFormValues(form, argvToFlagMap(argv))
  /** @type {Record<string, unknown>} */
  const values = {}
  for (const field of form) {
    if (field.type === 'info') continue
    const id = String(field.id || field.flag || '')
    if (fromArgv[id] !== undefined && fromArgv[id] !== '' && !(Array.isArray(fromArgv[id]) && !fromArgv[id].length)) {
      values[id] = fromArgv[id]
    } else if (field.type === 'boolean') {
      values[id] = field.default !== undefined ? Boolean(field.default) : false
    } else if (field.type === 'multiselect') {
      values[id] = Array.isArray(field.default) ? [...field.default] : []
    } else if (field.type === 'number') {
      values[id] = field.default !== undefined ? field.default : ''
    } else {
      values[id] = field.default !== undefined ? field.default : ''
    }
  }
  return values
}
