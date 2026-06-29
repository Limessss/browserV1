/**
 * 脚本启动时在浏览器新开 Tab：表单化查看/编辑默认参数 + 本轮参数摘要。
 */

import { hasKeepOpenFlag } from './page_runtime_ui.mjs'
import {
  defaultFormValues,
  formatArgvHumanSummary,
  formValuesToArgv,
  normalizeArgForm,
} from './script_args_form.mjs'
import {
  formatArgsLines,
  getCurrentRunArgs,
  loadUserDefaultsFile,
  parseArgsLines,
  readScriptManifest,
  resolvePlaywrightScriptsRoot,
  resolveStorageKey,
  saveUserDefaultArgs,
} from './script_args_store.mjs'

/** 面板内 fetch 保存端点；由 Playwright page.route 拦截（CDP 附着下 exposeFunction 不可用）。 */
const PANEL_SAVE_URL = 'https://ant-script-args.local/save'

function panelSaveClientJs() {
  const url = JSON.stringify(PANEL_SAVE_URL)
  return `
async function antSaveUserDefaultArgs(payload) {
  const res = await fetch(${url}, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ payload }),
  });
  if (!res.ok) {
    let detail = res.statusText || ('HTTP ' + res.status);
    try {
      const j = await res.json();
      if (j && j.error) detail = j.error;
    } catch (_) { /* ignore */ }
    throw new Error(detail);
  }
  return res.json();
}
`
}

/**
 * @param {import('playwright').Page} page
 * @param {string} scriptsRoot
 * @param {string} storageKey
 */
async function attachPanelSaveRoute(page, scriptsRoot, storageKey) {
  await page.route('**/ant-script-args.local/**', async (route) => {
    const req = route.request()
    if (req.method() !== 'POST' || !req.url().includes('/save')) {
      await route.abort()
      return
    }
    try {
      const body = req.postDataJSON()
      const payload =
        body && typeof body === 'object' && body !== null && 'payload' in body
          ? body.payload
          : body
      let args
      if (Array.isArray(payload)) {
        args = payload.filter((a) => typeof a === 'string')
      } else {
        args = parseArgsLines(String(payload ?? ''))
      }
      const saved = await saveUserDefaultArgs(scriptsRoot, storageKey, args)
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ok: true,
          savedAt: saved.updatedAt,
          count: saved.defaultArgs.length,
        }),
      })
    } catch (e) {
      await route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({
          ok: false,
          error: e instanceof Error ? e.message : String(e),
        }),
      })
    }
  })
}

function shouldSkipArgsPanel() {
  return (
    process.argv.includes('--skip-args-panel') ||
    process.env.SKIP_SCRIPT_ARGS_PANEL === '1' ||
    process.env.SKIP_SCRIPT_ARGS_PANEL === 'true'
  )
}

function resolveBrowser(browserOrPage) {
  if (!browserOrPage) return null
  if (typeof browserOrPage.context === 'function') {
    return browserOrPage.context().browser() ?? null
  }
  if (typeof browserOrPage.contexts === 'function') {
    return browserOrPage
  }
  return null
}

function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

const SHARED_STYLES = `
:root {
  --bg: #0f0f14;
  --border: rgba(255,255,255,.08);
  --text: #ececf2;
  --muted: #9b9bab;
  --accent: #6366f1;
  --accent2: #2dd4bf;
  --danger: #f87171;
  --ok: #34d399;
}
* { box-sizing: border-box; }
body {
  margin: 0;
  min-height: 100vh;
  font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  background: radial-gradient(1200px 600px at 10% -10%, rgba(99,102,241,.18), transparent),
    radial-gradient(900px 500px at 90% 0%, rgba(45,212,191,.12), transparent), var(--bg);
  color: var(--text);
  padding: 28px 20px 48px;
}
.wrap { max-width: 720px; margin: 0 auto; }
header { margin-bottom: 24px; padding-bottom: 18px; border-bottom: 1px solid var(--border); }
h1 { margin: 0 0 8px; font-size: 1.45rem; font-weight: 700; }
.sub { color: var(--muted); font-size: .9rem; line-height: 1.55; }
.pill {
  display: inline-block; margin-left: 8px; padding: 2px 10px; border-radius: 999px;
  font-size: .75rem; font-weight: 600; background: rgba(99,102,241,.2); color: #c7d2fe;
}
.card {
  background: linear-gradient(180deg, rgba(26,26,34,.98), rgba(20,20,26,.99));
  border: 1px solid var(--border); border-radius: 16px; overflow: hidden;
  box-shadow: 0 16px 48px rgba(0,0,0,.35); margin-bottom: 18px;
}
.card-head {
  padding: 13px 18px; font-size: .8rem; font-weight: 700; letter-spacing: .05em;
  color: #b8b8c8; border-bottom: 1px solid var(--border); background: rgba(255,255,255,.02);
}
.card-head.run { color: var(--accent2); }
.card-head.edit { color: #fbbf24; }
.card-body { padding: 18px 20px 20px; }
.run-summary {
  margin: 0; padding: 14px 16px; border-radius: 12px; background: rgba(0,0,0,.32);
  border: 1px solid var(--border); font-size: .92rem; line-height: 1.75; white-space: pre-wrap;
}
.field { margin-bottom: 20px; }
.field:last-child { margin-bottom: 0; }
.field-label { font-size: .95rem; font-weight: 600; margin-bottom: 4px; display: block; }
.field-desc { font-size: .82rem; color: var(--muted); line-height: 1.55; margin: 0 0 8px; }
.field input[type=text], .field input[type=number], .field select {
  width: 100%; padding: 10px 12px; border-radius: 10px;
  border: 1px solid rgba(99,102,241,.35); background: rgba(0,0,0,.35); color: var(--text);
  font-size: .92rem; outline: none;
}
.field input:focus, .field select:focus {
  border-color: var(--accent); box-shadow: 0 0 0 3px rgba(99,102,241,.2);
}
.check-row { display: flex; align-items: flex-start; gap: 10px; }
.check-row input { margin-top: 3px; accent-color: var(--accent); width: 18px; height: 18px; }
.multi-grid { display: flex; flex-wrap: wrap; gap: 8px 14px; }
.multi-grid label {
  display: inline-flex; align-items: center; gap: 6px; font-size: .88rem;
  padding: 6px 10px; border-radius: 8px; border: 1px solid var(--border);
  background: rgba(0,0,0,.2); cursor: pointer;
}
.multi-grid input { accent-color: var(--accent); }
.info-box {
  padding: 12px 14px; border-radius: 10px; background: rgba(45,212,191,.08);
  border: 1px solid rgba(45,212,191,.25); font-size: .86rem; line-height: 1.6; color: #b8e8df;
  margin-bottom: 18px;
}
.actions { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; margin-top: 18px; }
button {
  cursor: pointer; border: none; border-radius: 12px; padding: 11px 20px;
  font-size: .94rem; font-weight: 600; color: #fff;
  background: linear-gradient(135deg, #6366f1, #7c3aed);
  box-shadow: 0 8px 24px rgba(99,102,241,.35);
}
button.secondary {
  background: rgba(255,255,255,.08); box-shadow: none; color: #e4e4ef; border: 1px solid var(--border);
}
button:disabled { opacity: .55; cursor: not-allowed; }
.status { font-size: .86rem; color: var(--muted); }
.status.ok { color: var(--ok); }
.status.err { color: var(--danger); }
.note {
  margin-top: 8px; padding: 12px 14px; border-radius: 10px;
  background: rgba(99,102,241,.08); border: 1px solid rgba(99,102,241,.2);
  font-size: .82rem; color: #c4c4d4; line-height: 1.6;
}
textarea.legacy {
  width: 100%; min-height: 200px; padding: 12px; border-radius: 10px;
  border: 1px solid var(--border); background: rgba(0,0,0,.35); color: var(--text);
  font-family: ui-monospace, Menlo, monospace; font-size: 12px;
}
.hidden { display: none !important; }
`

function buildFormPanelHtml(data) {
  const {
    scriptName,
    version,
    argForm,
    formValues,
    factoryValues,
    currentRunSummary,
    savedAt,
  } = data
  const ver = version ? `<span class="pill">v${escapeHtml(version)}</span>` : ''
  const schemaJson = JSON.stringify(argForm).replace(/</g, '\\u003c')
  const valuesJson = JSON.stringify(formValues).replace(/</g, '\\u003c')
  const factoryJson = JSON.stringify(factoryValues).replace(/</g, '\\u003c')

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(scriptName)} · 脚本参数</title>
<style>${SHARED_STYLES}</style>
</head>
<body>
<div class="wrap">
  <header>
    <h1>${escapeHtml(scriptName)}${ver}</h1>
    <p class="sub">填写下方选项后点「保存为我的默认」，下次从「自动化脚本」启动时将使用这些设置。</p>
  </header>
  <section class="card">
    <div class="card-head run">本轮正在使用的参数</div>
    <div class="card-body">
      <p class="field-desc" style="margin-top:0">本次启动已生效，仅展示不可改。</p>
      <pre class="run-summary">${escapeHtml(currentRunSummary)}</pre>
    </div>
  </section>
  <section class="card">
    <div class="card-head edit">我的默认启动设置</div>
    <div class="card-body">
      <form id="arg-form" novalidate></form>
      <div class="actions">
        <button type="button" id="btn-save">保存为我的默认</button>
        <button type="button" class="secondary" id="btn-reset">恢复出厂默认</button>
        <span class="status" id="status">${savedAt ? `上次保存：${escapeHtml(savedAt)}` : ''}</span>
      </div>
    </div>
  </section>
  <p class="note">保存后仅影响<strong>下次</strong>启动；本轮任务已在其它标签页继续执行。调试可加 <code>--skip-args-panel</code> 跳过本页。</p>
</div>
<script id="arg-schema" type="application/json">${schemaJson}</script>
<script id="arg-values" type="application/json">${valuesJson}</script>
<script id="arg-factory" type="application/json">${factoryJson}</script>
<script>${panelSaveClientJs()}</script>
<script>
(function () {
  const schema = JSON.parse(document.getElementById('arg-schema').textContent || '[]');
  const savedValues = JSON.parse(document.getElementById('arg-values').textContent || '{}');
  const factoryValues = JSON.parse(document.getElementById('arg-factory').textContent || '{}');
  let values = JSON.parse(JSON.stringify(savedValues));
  const formEl = document.getElementById('arg-form');
  const status = document.getElementById('status');
  const btnSave = document.getElementById('btn-save');
  const btnReset = document.getElementById('btn-reset');

  function setStatus(msg, kind) {
    status.textContent = msg || '';
    status.className = 'status' + (kind ? ' ' + kind : '');
  }

  function fieldId(f) { return f.id || f.flag || ''; }

  function shouldShow(f) {
    const sw = f.showWhen;
    if (!sw || typeof sw !== 'object') return true;
    for (const k of Object.keys(sw)) {
      const expect = sw[k];
      const actual = values[k];
      if (Array.isArray(expect)) {
        if (!expect.map(String).includes(String(actual))) return false;
      } else if (expect === true) {
        if (!actual) return false;
      } else if (String(actual) !== String(expect)) return false;
    }
    return true;
  }

  function render() {
    formEl.innerHTML = '';
    for (const f of schema) {
      if (f.type === 'info') {
        const box = document.createElement('div');
        box.className = 'info-box';
        box.textContent = f.text || f.label || '';
        formEl.appendChild(box);
        continue;
      }
      const id = fieldId(f);
      if (!id) continue;
      const wrap = document.createElement('div');
      wrap.className = 'field';
      wrap.dataset.fieldId = id;
      if (!shouldShow(f)) wrap.classList.add('hidden');

      if (f.type === 'boolean') {
        wrap.innerHTML =
          '<div class="check-row">' +
          '<input type="checkbox" id="f-' + id + '" />' +
          '<div><label class="field-label" for="f-' + id + '">' + (f.label || id) + '</label>' +
          (f.description ? '<p class="field-desc">' + f.description + '</p>' : '') +
          '</div></div>';
        formEl.appendChild(wrap);
        const cb = wrap.querySelector('input');
        cb.checked = Boolean(values[id]);
        cb.onchange = () => { values[id] = cb.checked; render(); };
        continue;
      }

      let control = '';
      if (f.type === 'select') {
        const opts = (f.options || []).map(function (o) {
          const sel = String(values[id]) === String(o.value) ? ' selected' : '';
          return '<option value="' + String(o.value).replace(/"/g, '&quot;') + '"' + sel + '>' +
            (o.label || o.value) + '</option>';
        }).join('');
        control = '<select id="f-' + id + '">' + opts + '</select>';
      } else if (f.type === 'multiselect') {
        const selected = Array.isArray(values[id]) ? values[id].map(String) : [];
        const boxes = (f.options || []).map(function (o) {
          const checked = selected.includes(String(o.value)) ? ' checked' : '';
          return '<label><input type="checkbox" data-multi="' + id + '" value="' +
            String(o.value).replace(/"/g, '&quot;') + '"' + checked + ' />' +
            (o.label || o.value) + '</label>';
        }).join('');
        control = '<div class="multi-grid">' + boxes + '</div>';
      } else if (f.type === 'number') {
        const min = f.min !== undefined ? ' min="' + f.min + '"' : '';
        const max = f.max !== undefined ? ' max="' + f.max + '"' : '';
        control = '<input type="number" id="f-' + id + '" value="' +
          (values[id] !== undefined && values[id] !== '' ? values[id] : '') + '"' + min + max + ' />';
      } else {
        const ph = f.placeholder ? ' placeholder="' + String(f.placeholder).replace(/"/g, '&quot;') + '"' : '';
        control = '<input type="text" id="f-' + id + '" value="' +
          String(values[id] ?? '').replace(/"/g, '&quot;') + '"' + ph + ' />';
      }

      wrap.innerHTML =
        '<label class="field-label" for="f-' + id + '">' + (f.label || id) +
        (f.required ? ' <span style="color:#f87171">*</span>' : '') + '</label>' +
        (f.description ? '<p class="field-desc">' + f.description + '</p>' : '') +
        control;
      formEl.appendChild(wrap);

      if (f.type === 'multiselect') {
        wrap.querySelectorAll('input[data-multi]').forEach(function (inp) {
          inp.onchange = function () {
            const arr = [];
            wrap.querySelectorAll('input[data-multi]:checked').forEach(function (c) { arr.push(c.value); });
            values[id] = arr;
          };
        });
      } else if (f.type === 'select' || f.type === 'number' || f.type === 'text') {
        const el = wrap.querySelector('#f-' + id);
        el.oninput = el.onchange = function () {
          values[id] = f.type === 'number' ? (el.value === '' ? '' : Number(el.value)) : el.value;
          if (f.type === 'select') render();
        };
      }
    }
  }

  function collectArgv() {
    const args = [];
    for (const f of schema) {
      if (f.type === 'info') continue;
      const id = fieldId(f);
      const flag = f.flag || '';
      const v = values[id];
      if (f.type === 'boolean') {
        if (f.asFlag && flag && v) args.push(flag);
        continue;
      }
      if (!flag || !shouldShow(f)) continue;
      if (f.type === 'multiselect') {
        const arr = Array.isArray(v) ? v.filter(Boolean) : [];
        if (arr.length) args.push(flag, JSON.stringify(arr));
        continue;
      }
      if (f.type === 'number') {
        if (v !== '' && v !== undefined && Number.isFinite(Number(v))) args.push(flag, String(v));
        continue;
      }
      const s = v === undefined || v === null ? '' : String(v).trim();
      if (s) args.push(flag, s);
    }
    return args;
  }

  btnReset.onclick = function () {
    values = JSON.parse(JSON.stringify(factoryValues));
    render();
    setStatus('已恢复为 script.json 出厂默认，点击「保存为我的默认」后写入磁盘', '');
  };

  btnSave.onclick = async function () {
    btnSave.disabled = true;
    setStatus('保存中…', '');
    try {
      const argv = collectArgv();
      const res = await antSaveUserDefaultArgs(argv);
      if (res && res.ok) setStatus('已保存 · ' + (res.savedAt || ''), 'ok');
      else setStatus('保存失败', 'err');
    } catch (e) {
      setStatus((e && e.message) ? e.message : String(e), 'err');
    } finally {
      btnSave.disabled = false;
    }
  };

  render();
})();
</script>
</body>
</html>`
}

function buildLegacyPanelHtml(data) {
  const {
    scriptName,
    scriptId,
    version,
    userDefaults,
    currentRunSummary,
    savedAt,
  } = data
  const ver = version ? `<span class="pill">v${escapeHtml(version)}</span>` : ''
  const userText = formatArgsLines(userDefaults)

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<title>${escapeHtml(scriptName)} · 脚本参数</title>
<style>${SHARED_STYLES}</style>
</head>
<body>
<div class="wrap">
  <header>
    <h1>${escapeHtml(scriptName)}${ver}</h1>
    <p class="sub">脚本 ID：${escapeHtml(scriptId)} · 未配置表单（argForm），使用高级文本模式</p>
  </header>
  <section class="card">
    <div class="card-head run">本轮运行参数</div>
    <div class="card-body"><pre class="run-summary">${escapeHtml(currentRunSummary)}</pre></div>
  </section>
  <section class="card">
    <div class="card-head edit">我的默认参数（每行一个）</div>
    <div class="card-body">
      <textarea class="legacy" id="user-args">${escapeHtml(userText)}</textarea>
      <div class="actions">
        <button type="button" id="btn-save">保存</button>
        <span class="status" id="status">${savedAt ? `上次保存：${escapeHtml(savedAt)}` : ''}</span>
      </div>
    </div>
  </section>
</div>
<script>${panelSaveClientJs()}</script>
<script>
(function(){
  const btn = document.getElementById('btn-save');
  const ta = document.getElementById('user-args');
  const status = document.getElementById('status');
  btn.onclick = async function() {
    btn.disabled = true;
    try {
      const res = await antSaveUserDefaultArgs(ta.value);
      status.textContent = res && res.ok ? '已保存 · ' + (res.savedAt || '') : '保存失败';
      status.className = 'status ' + (res && res.ok ? 'ok' : 'err');
    } catch (e) {
      status.textContent = (e && e.message) ? e.message : String(e);
      status.className = 'status err';
    } finally { btn.disabled = false; }
  };
})();
</script>
</body>
</html>`
}

/**
 * @param {import('playwright').Browser | import('playwright').Page | null | undefined} browserOrPage
 * @param {{ scriptDir: string }} opts
 */
export async function openScriptArgsPanel(browserOrPage, opts) {
  if (shouldSkipArgsPanel()) return null
  const scriptDir = String(opts?.scriptDir || '').trim()
  if (!scriptDir) return null

  const browser = resolveBrowser(browserOrPage)
  if (!browser) return null

  let manifest
  try {
    manifest = await readScriptManifest(scriptDir)
  } catch (err) {
    console.warn(
      `[脚本参数面板] 读取 script.json 失败，已跳过：${err instanceof Error ? err.message : String(err)}`,
    )
    return null
  }

  const scriptsRoot = resolvePlaywrightScriptsRoot(scriptDir)
  const storageKey = resolveStorageKey(scriptDir, manifest)
  const manifestDefaults = Array.isArray(manifest.defaultArgs)
    ? manifest.defaultArgs.filter((a) => typeof a === 'string')
    : []
  const savedFile = await loadUserDefaultsFile(scriptsRoot, storageKey)
  const userDefaults = savedFile?.defaultArgs ?? [...manifestDefaults]
  const savedAt = savedFile?.updatedAt ?? ''
  const currentRunArgs = getCurrentRunArgs()

  const argForm = normalizeArgForm(manifest.argForm)
  const useForm = argForm.length > 0
  const currentRunSummary = useForm
    ? formatArgvHumanSummary(currentRunArgs, argForm)
    : formatArgsLines(currentRunArgs) || '（无）'

  const formValues = useForm ? defaultFormValues(argForm, userDefaults) : {}
  const factoryFormValues = useForm ? defaultFormValues(argForm, manifestDefaults) : {}

  const context = browser.contexts()[0] || (await browser.newContext())
  const page = await context.newPage()
  await attachPanelSaveRoute(page, scriptsRoot, storageKey)

  const html = useForm
    ? buildFormPanelHtml({
        scriptName: manifest.name || storageKey,
        version: manifest.version || '',
        argForm,
        formValues,
        factoryValues: factoryFormValues,
        currentRunSummary,
        savedAt,
      })
    : buildLegacyPanelHtml({
        scriptName: manifest.name || storageKey,
        scriptId: storageKey,
        version: manifest.version || '',
        userDefaults,
        currentRunSummary,
        savedAt,
      })

  try {
    await page.setContent(html, { waitUntil: 'commit', timeout: 15_000 })
  } catch {
    const dataUrl = `data:text/html;charset=utf-8,${encodeURIComponent(html)}`
    await page.goto(dataUrl, { waitUntil: 'commit', timeout: 15_000 })
  }

  try {
    await page.bringToFront()
  } catch {
    /* ignore */
  }

  console.log(
    `[脚本参数面板] 已新开 Tab：${manifest.name || storageKey}（${useForm ? '表单模式' : '文本模式'}）`,
  )
  void hasKeepOpenFlag()
  return page
}
