import type { BrowserProfile, BrowserProfileInput, ProfileCredential, ProfileCredentialInput } from '../types'

/** CSV 列定义：中文表头为主，兼容英文 key */
export const INSTANCE_CSV_COLUMNS = [
  { key: 'profileId', labels: ['实例ID', 'profileId'] },
  { key: 'profileName', labels: ['实例名称', 'profileName', '名称', 'name', '实例名'] },
  { key: 'launchCode', labels: ['快捷码', 'launchCode'] },
  { key: 'coreId', labels: ['内核ID', 'coreId'] },
  { key: 'proxyId', labels: ['代理ID', 'proxyId'] },
  { key: 'proxyConfig', labels: ['代理配置', 'proxyConfig'] },
  { key: 'groupId', labels: ['分组ID', 'groupId'] },
  { key: 'groupName', labels: ['分组名称', 'groupName'] },
  { key: 'tags', labels: ['标签', 'tags'] },
  { key: 'keywords', labels: ['关键字', 'keywords'] },
  { key: 'fingerprintArgs', labels: ['指纹参数', 'fingerprintArgs'] },
  { key: 'launchArgs', labels: ['启动参数', 'launchArgs'] },
  { key: 'defaultStartUrls', labels: ['默认启动网址', 'defaultStartUrls'] },
  { key: 'userDataDir', labels: ['用户数据目录', 'userDataDir'] },
  { key: 'credentialId', labels: ['账号ID', 'credentialId'] },
  { key: 'credentialLabel', labels: ['账号标签', 'credentialLabel', 'label'] },
  { key: 'siteHost', labels: ['站点域名', 'siteHost'] },
  { key: 'urlPattern', labels: ['URL匹配', 'urlPattern'] },
  { key: 'username', labels: ['用户名', 'username'] },
  { key: 'password', labels: ['密码', 'password'] },
  { key: 'usernameSelector', labels: ['用户名选择器', 'usernameSelector'] },
  { key: 'passwordSelector', labels: ['密码选择器', 'passwordSelector'] },
  { key: 'autoSubmit', labels: ['自动提交', 'autoSubmit'] },
  { key: 'credentialEnabled', labels: ['账号启用', 'credentialEnabled', 'enabled'] },
  { key: 'sortOrder', labels: ['账号排序', 'sortOrder'] },
] as const

export type InstanceCsvRow = {
  profileId: string
  profileName: string
  launchCode: string
  coreId: string
  proxyId: string
  proxyConfig: string
  groupId: string
  groupName: string
  tags: string[]
  keywords: string[]
  fingerprintArgs: string[]
  launchArgs: string[]
  defaultStartUrls: string[]
  userDataDir: string
  credentialId: string
  credentialLabel: string
  siteHost: string
  urlPattern: string
  username: string
  password: string
  usernameSelector: string
  passwordSelector: string
  autoSubmit: boolean | null
  credentialEnabled: boolean | null
  sortOrder: number | null
  /** 解析行号（从 1 起，含表头则为数据行序号） */
  lineNo: number
}

const ARRAY_SEP = '|'

function escapeCsvCell(value: string): string {
  if (/[",\n\r]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`
  }
  return value
}

function joinArray(values: string[] | undefined): string {
  return (values || []).filter(Boolean).join(ARRAY_SEP)
}

function splitArray(value: string): string[] {
  if (!value.trim()) return []
  return value.split(ARRAY_SEP).map(s => s.trim()).filter(Boolean)
}

function parseOptionalBool(value: string): boolean | null {
  const v = value.trim().toLowerCase()
  if (!v) return null
  if (v === '1' || v === 'true' || v === 'yes' || v === '是') return true
  if (v === '0' || v === 'false' || v === 'no' || v === '否') return false
  return null
}

function formatBool(value: boolean): string {
  return value ? 'true' : 'false'
}

export function rowHasCredential(row: InstanceCsvRow): boolean {
  return Boolean(row.credentialId || row.siteHost || row.username)
}

export function instanceRowKey(row: Pick<InstanceCsvRow, 'profileId' | 'profileName'>): string {
  return row.profileId || row.profileName
}

function normalizeHeaderCell(value: string): string {
  return value
    .replace(/^\uFEFF/, '')
    .trim()
    .replace(/\u00A0/g, ' ')
    .replace(/\s+/g, '')
    .toLowerCase()
}

function getFirstLine(text: string): string {
  const input = text.replace(/^\uFEFF/, '')
  const match = input.match(/^[^\r\n]*/)
  return match?.[0] ?? input
}

/** 根据首行引号外分隔符数量推断分隔符（兼容 Excel 中文版分号 CSV） */
export function detectCsvDelimiter(firstLine: string): string {
  let commas = 0
  let semicolons = 0
  let tabs = 0
  let inQuotes = false
  for (const ch of firstLine) {
    if (ch === '"') {
      inQuotes = !inQuotes
      continue
    }
    if (inQuotes) continue
    if (ch === ',') commas++
    else if (ch === ';') semicolons++
    else if (ch === '\t') tabs++
  }
  if (semicolons > commas && semicolons > 0) return ';'
  if (tabs > commas && tabs > 0) return '\t'
  return ','
}

/** 解析 CSV 文本为二维数组 */
export function parseCsvRows(text: string, delimiter = ','): string[][] {
  const input = text.replace(/^\uFEFF/, '')
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let inQuotes = false

  for (let i = 0; i < input.length; i++) {
    const ch = input[i]
    const next = input[i + 1]

    if (inQuotes) {
      if (ch === '"' && next === '"') {
        cell += '"'
        i++
      } else if (ch === '"') {
        inQuotes = false
      } else {
        cell += ch
      }
      continue
    }

    if (ch === '"') {
      inQuotes = true
    } else if (ch === delimiter) {
      row.push(cell)
      cell = ''
    } else if (ch === '\n' || (ch === '\r' && next === '\n')) {
      row.push(cell)
      cell = ''
      if (row.some(c => c.trim())) {
        rows.push(row)
      }
      row = []
      if (ch === '\r') i++
    } else if (ch !== '\r') {
      cell += ch
    }
  }

  row.push(cell)
  if (row.some(c => c.trim())) {
    rows.push(row)
  }

  return rows
}

function resolveHeaderIndex(headers: string[]): Record<string, number> {
  const normalized = headers.map(normalizeHeaderCell)
  const index: Record<string, number> = {}
  for (const col of INSTANCE_CSV_COLUMNS) {
    for (const label of col.labels) {
      const key = normalizeHeaderCell(label)
      const idx = normalized.indexOf(key)
      if (idx !== -1) {
        index[col.key] = idx
        break
      }
    }
  }
  return index
}

function getCell(cells: string[], index: Record<string, number>, key: string): string {
  const idx = index[key]
  if (idx === undefined) return ''
  return (cells[idx] ?? '').trim()
}

function profileToCells(
  p: BrowserProfile,
  groupNameById: Map<string, string>,
  cred?: ProfileCredential,
): string[] {
  return [
    p.profileId,
    p.profileName,
    p.launchCode || '',
    p.coreId || '',
    p.proxyId || '',
    p.proxyConfig || '',
    p.groupId || '',
    p.groupId ? (groupNameById.get(p.groupId) || '') : '',
    joinArray(p.tags),
    joinArray(p.keywords),
    joinArray(p.fingerprintArgs),
    joinArray(p.launchArgs),
    joinArray(p.defaultStartUrls),
    p.userDataDir || '',
    cred?.credentialId || '',
    cred?.label || '',
    cred?.siteHost || '',
    cred?.urlPattern || '',
    cred?.username || '',
    cred?.password || '',
    cred?.usernameSelector || '',
    cred?.passwordSelector || '',
    cred ? formatBool(cred.autoSubmit) : '',
    cred ? formatBool(cred.enabled) : '',
    cred != null ? String(cred.sortOrder) : '',
  ]
}

const CSV_DECODE_ENCODINGS = ['utf-8', 'gb18030', 'gbk'] as const

function csvHeaderLooksValid(text: string): boolean {
  const delimiter = detectCsvDelimiter(getFirstLine(text))
  const rawRows = parseCsvRows(text, delimiter)
  if (rawRows.length === 0) return false
  return resolveHeaderIndex(rawRows[0]).profileName !== undefined
}

/** 自动识别 UTF-8 / GBK（Excel 中文版「CSV」默认编码） */
export function decodeCsvBytes(buffer: ArrayBuffer): string {
  const candidates: string[] = []
  for (const encoding of CSV_DECODE_ENCODINGS) {
    try {
      const text = new TextDecoder(encoding, { fatal: false }).decode(buffer).replace(/^\uFEFF/, '')
      candidates.push(text)
      if (csvHeaderLooksValid(text)) {
        return text
      }
    } catch {
      // 当前环境不支持该编码标签时跳过
    }
  }
  return candidates[0] ?? ''
}

export function profilesToCsv(
  profiles: BrowserProfile[],
  groups?: { groupId: string; groupName: string }[],
  credentialsByProfileId?: Map<string, ProfileCredential[]>,
): string {
  const groupNameById = new Map((groups || []).map(g => [g.groupId, g.groupName]))
  const headers = INSTANCE_CSV_COLUMNS.map(c => c.labels[0])
  const lines = [headers.map(escapeCsvCell).join(',')]

  for (const p of profiles) {
    const creds = credentialsByProfileId?.get(p.profileId) || []
    if (creds.length === 0) {
      lines.push(profileToCells(p, groupNameById).map(escapeCsvCell).join(','))
    } else {
      for (const cred of creds) {
        lines.push(profileToCells(p, groupNameById, cred).map(escapeCsvCell).join(','))
      }
    }
  }

  return `\uFEFF${lines.join('\r\n')}`
}

export function parseInstanceCsv(text: string): { rows: InstanceCsvRow[]; errors: string[] } {
  const errors: string[] = []
  const delimiter = detectCsvDelimiter(getFirstLine(text))
  const rawRows = parseCsvRows(text, delimiter)
  if (rawRows.length === 0) {
    return { rows: [], errors: ['CSV 文件为空'] }
  }

  const headerIndex = resolveHeaderIndex(rawRows[0])
  if (headerIndex.profileName === undefined) {
    const headerPreview = rawRows[0].map(h => h.trim()).filter(Boolean).slice(0, 8).join(' | ')
    const colHint = rawRows[0].length <= 1
      ? `（仅识别到 ${rawRows[0].length} 列，可能是分隔符不匹配，已尝试：${delimiter === ';' ? '分号' : delimiter === '\t' ? '制表符' : '逗号'}）`
      : ''
    const encodingHint = /[\u0080-\u00ff]{2,}/.test(headerPreview) && !/[\u4e00-\u9fff]/.test(headerPreview)
      ? '。表头疑似乱码，请用 Excel「另存为 → CSV UTF-8」后重试'
      : ''
    return {
      rows: [],
      errors: [`缺少必填列「实例名称」${colHint}${encodingHint}。当前表头：${headerPreview || '（空）'}`],
    }
  }

  const rows: InstanceCsvRow[] = []
  for (let i = 1; i < rawRows.length; i++) {
    const cells = rawRows[i]
    const lineNo = i + 1
    const profileName = getCell(cells, headerIndex, 'profileName')
    if (!profileName) {
      errors.push(`第 ${lineNo} 行：实例名称不能为空，已跳过`)
      continue
    }

    const sortOrderRaw = getCell(cells, headerIndex, 'sortOrder')
    rows.push({
      profileId: getCell(cells, headerIndex, 'profileId'),
      profileName,
      launchCode: getCell(cells, headerIndex, 'launchCode'),
      coreId: getCell(cells, headerIndex, 'coreId'),
      proxyId: getCell(cells, headerIndex, 'proxyId'),
      proxyConfig: getCell(cells, headerIndex, 'proxyConfig'),
      groupId: getCell(cells, headerIndex, 'groupId'),
      groupName: getCell(cells, headerIndex, 'groupName'),
      tags: splitArray(getCell(cells, headerIndex, 'tags')),
      keywords: splitArray(getCell(cells, headerIndex, 'keywords')),
      fingerprintArgs: splitArray(getCell(cells, headerIndex, 'fingerprintArgs')),
      launchArgs: splitArray(getCell(cells, headerIndex, 'launchArgs')),
      defaultStartUrls: splitArray(getCell(cells, headerIndex, 'defaultStartUrls')),
      userDataDir: getCell(cells, headerIndex, 'userDataDir'),
      credentialId: getCell(cells, headerIndex, 'credentialId'),
      credentialLabel: getCell(cells, headerIndex, 'credentialLabel'),
      siteHost: getCell(cells, headerIndex, 'siteHost'),
      urlPattern: getCell(cells, headerIndex, 'urlPattern'),
      username: getCell(cells, headerIndex, 'username'),
      password: getCell(cells, headerIndex, 'password'),
      usernameSelector: getCell(cells, headerIndex, 'usernameSelector'),
      passwordSelector: getCell(cells, headerIndex, 'passwordSelector'),
      autoSubmit: parseOptionalBool(getCell(cells, headerIndex, 'autoSubmit')),
      credentialEnabled: parseOptionalBool(getCell(cells, headerIndex, 'credentialEnabled')),
      sortOrder: sortOrderRaw ? Number(sortOrderRaw) : null,
      lineNo,
    })
  }

  return { rows, errors }
}

export function instanceCsvRowToCredentialInput(row: InstanceCsvRow): ProfileCredentialInput | null {
  if (!rowHasCredential(row)) return null
  if (!row.siteHost) return null

  return {
    credentialId: row.credentialId || undefined,
    label: row.credentialLabel || undefined,
    siteHost: row.siteHost,
    urlPattern: row.urlPattern || undefined,
    username: row.username,
    password: row.password || undefined,
    usernameSelector: row.usernameSelector || undefined,
    passwordSelector: row.passwordSelector || undefined,
    autoSubmit: row.autoSubmit ?? undefined,
    enabled: row.credentialEnabled ?? undefined,
    sortOrder: row.sortOrder ?? undefined,
  }
}

export function instanceCsvRowToInput(
  row: InstanceCsvRow,
  groups: { groupId: string; groupName: string }[],
): BrowserProfileInput {
  let groupId = row.groupId
  if (!groupId && row.groupName) {
    const matched = groups.find(g => g.groupName === row.groupName)
    if (matched) groupId = matched.groupId
  }

  return {
    profileName: row.profileName,
    userDataDir: row.userDataDir,
    coreId: row.coreId,
    fingerprintArgs: row.fingerprintArgs,
    proxyId: row.proxyId,
    proxyConfig: row.proxyConfig,
    launchArgs: row.launchArgs,
    tags: row.tags,
    keywords: row.keywords,
    groupId,
    defaultStartUrls: row.defaultStartUrls,
  }
}

export function downloadCsv(content: string, filename: string) {
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}
