/**
 * 通过 CDP 在实例浏览器中自动填充已配置的账号密码。
 */
import WebSocket from 'ws'

import { getSqlite } from './database/sqlite-store'
import { matchProfileCredentialForPage, listEnabledCredentialSiteHosts } from './profile-credential-service'

type CdpPending = {
  resolve: (value: unknown) => void
  reject: (err: Error) => void
}

const sessions = new Map<string, AutofillSession>()

/** 实例启动后，页面内 Tab 切换监听器存活时间 */
const AUTOFILL_TAB_HOOK_TTL_MS = 60_000

function buildDisconnectTabHooksExpression(): string {
  return `(() => {
    const cfg = window.__nexAutofill;
    if (!cfg || !cfg.tabHooksInstalled) return { disconnected: false };
    if (cfg.tabClickRoot && cfg.tabClickHandler) {
      cfg.tabClickRoot.removeEventListener('click', cfg.tabClickHandler);
    }
    if (cfg.tabHookPending) {
      clearTimeout(cfg.tabHookPending);
      cfg.tabHookPending = 0;
    }
    if (cfg.observer) {
      try { cfg.observer.disconnect(); } catch {}
      cfg.observer = null;
    }
    cfg.tabHooksInstalled = false;
    cfg.tabClickRoot = null;
    cfg.tabClickHandler = null;
    cfg.expired = true;
    return { disconnected: true };
  })()`
}

function buildMarkAutofillExpiredExpression(): string {
  return `(() => {
    const cfg = window.__nexAutofill || (window.__nexAutofill = {});
    cfg.expired = true;
    return { expired: true };
  })()`
}

function sessionKey(profileId: string, debugPort: number): string {
  return `${profileId.trim()}:${debugPort}`
}

function buildFillExpression(
  username: string,
  password: string,
  usernameSelector: string,
  passwordSelector: string,
  autoSubmit: boolean,
): string {
  const u = JSON.stringify(username)
  const p = JSON.stringify(password)
  const us = JSON.stringify(usernameSelector)
  const ps = JSON.stringify(passwordSelector)
  const submit = autoSubmit ? 'true' : 'false'
  return `(() => {
    const cfg = window.__nexAutofill || (window.__nexAutofill = {});
    cfg.user = ${u};
    cfg.pass = ${p};
    cfg.userSel = ${us};
    cfg.passSel = ${ps};
    cfg.autoSubmit = ${submit};

    function setNativeValue(el, value) {
      if (!el) return false;
      const next = String(value ?? '');
      if (el.value === next) return false;
      const desc = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value');
      if (desc && desc.set) desc.set.call(el, next);
      else el.value = next;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    }
    function isVisible(el) {
      if (!el || el.disabled) return false;
      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden') return false;
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    }
    function isEmailAccount(v) {
      return /.+@.+\\..+/.test(String(v || '').trim());
    }
    function isPhoneAccount(v) {
      const s = String(v || '').trim();
      return /^\\+?\\d[\\d\\s-]{5,}$/.test(s);
    }
    function pickPass() {
      const sel = cfg.passSel;
      if (sel) {
        const el = document.querySelector(sel);
        if (el) return el;
      }
      const queries = [
        'input[type=password]',
        'input[name=password]',
        '#TikTok_Ads_SSO_Login_Pwd_Input',
        '.tiktokads-common-login-form-password',
      ];
      for (const q of queries) {
        for (const el of document.querySelectorAll(q)) {
          if (el && !el.disabled) return el;
        }
      }
      return null;
    }
    function fillUserFields(scope) {
      const username = String(cfg.user || '').trim();
      if (!username) return 0;
      let filled = 0;
      if (cfg.userSel) {
        const el = document.querySelector(cfg.userSel);
        if (el) { setNativeValue(el, username); return 1; }
      }
      const emailEl = document.querySelector(
        '#TikTok_Ads_SSO_Login_Email_Input, input[name=email][type=email]',
      );
      const mobileEl = document.querySelector(
        '#TikTok_Ads_SSO_Login_Mobile_Input, input[name=mobile][type=tel]',
      );
      const emailMode = isEmailAccount(username);
      const phoneMode = isPhoneAccount(username);
      if (emailMode || !phoneMode) {
        if (emailEl) { setNativeValue(emailEl, username); filled++; }
      }
      if (phoneMode || !emailMode) {
        if (mobileEl) { setNativeValue(mobileEl, username); filled++; }
      }
      if (filled > 0) return filled;
      const preferred = [
        'input[type=email]',
        'input[name=email]',
        'input[name=username]',
        'input[name=mobile]',
        'input[type=tel]',
        'input[type=text]',
        'input[autocomplete=username]',
      ];
      for (const q of preferred) {
        for (const el of scope.querySelectorAll(q)) {
          if (isVisible(el)) { setNativeValue(el, username); return 1; }
        }
      }
      for (const q of preferred) {
        for (const el of scope.querySelectorAll(q)) {
          if (!el.disabled && el.type !== 'password') { setNativeValue(el, username); return 1; }
        }
      }
      return 0;
    }
    function runFill() {
      if (cfg.expired) return { ok: false, reason: 'expired' };
      const passEl = pickPass();
      if (!passEl) return { ok: false, reason: 'no-password-field' };
      const scope =
        passEl.closest('[id*=Login_Form], form, [class*=login], [id*=login]') || document;
      const usersFilled = fillUserFields(scope);
      setNativeValue(passEl, cfg.pass);
      if (cfg.autoSubmit && usersFilled > 0) {
        const btn = scope.querySelector(
          '#TikTok_Ads_SSO_Login_Btn, button[name=loginBtn], button[type=submit], input[type=submit]',
        );
        if (btn) { btn.click(); return { ok: true, submitted: true, usersFilled, passFilled: true }; }
        const form = passEl.closest('form');
        if (form) {
          form.requestSubmit?.();
          return { ok: true, submitted: true, usersFilled, passFilled: true };
        }
      }
      return { ok: true, submitted: false, usersFilled, passFilled: true };
    }
    function ensureTabSwitchHooks() {
      if (cfg.tabHooksInstalled) return false;
      const root = document.querySelector(
        '#TikTok_Ads_SSO_Login_Form_Content, #TikTok_Ads_SSO_Login_Form',
      );
      if (!root) return false;
      cfg.tabHooksInstalled = true;
      cfg.runFill = runFill;
      cfg.tabClickRoot = root;
      if (cfg.observer) {
        try { cfg.observer.disconnect(); } catch {}
        cfg.observer = null;
      }
      const onTabClick = (ev) => {
        if (cfg.expired) return;
        const t = ev.target;
        if (!(t instanceof Element)) return;
        if (
          t.closest('#TikTok_Ads_SSO_Login_Email_Panel_Button') ||
          t.closest('#TikTok_Ads_SSO_Login_Mobile_Panel_Button') ||
          t.closest('.panel-item')
        ) {
          if (cfg.tabHookPending) return;
          cfg.tabHookPending = window.setTimeout(() => {
            cfg.tabHookPending = 0;
            try { runFill(); } catch {}
          }, 150);
        }
      };
      cfg.tabClickHandler = onTabClick;
      root.addEventListener('click', onTabClick);
      return true;
    }
    const result = runFill();
    const tabHooksInstalled = ensureTabSwitchHooks();
    return { ...result, tabHooksInstalled };
  })()`
}

class CdpConnection {
  private ws: WebSocket
  private nextId = 1
  private pending = new Map<number, CdpPending>()
  private eventHandlers = new Map<
    string,
    Array<(params: Record<string, unknown>, sessionId?: string) => void>
  >()
  private closed = false

  constructor(wsUrl: string) {
    this.ws = new WebSocket(wsUrl)
    this.ws.on('message', (data) => this.onMessage(String(data)))
    this.ws.on('close', () => {
      this.closed = true
      for (const p of this.pending.values()) {
        p.reject(new Error('CDP 连接已关闭'))
      }
      this.pending.clear()
    })
    this.ws.on('error', () => {
      /* close handler cleans up */
    })
  }

  waitOpen(timeoutMs = 8000): Promise<void> {
    if (this.ws.readyState === WebSocket.OPEN) {
      return Promise.resolve()
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('CDP 连接超时')), timeoutMs)
      this.ws.once('open', () => {
        clearTimeout(timer)
        resolve()
      })
      this.ws.once('error', (e) => {
        clearTimeout(timer)
        reject(e instanceof Error ? e : new Error(String(e)))
      })
    })
  }

  on(event: string, handler: (params: Record<string, unknown>, sessionId?: string) => void): void {
    const list = this.eventHandlers.get(event) ?? []
    list.push(handler)
    this.eventHandlers.set(event, list)
  }

  send(method: string, params?: Record<string, unknown>, sessionId?: string): Promise<unknown> {
    if (this.closed) {
      return Promise.reject(new Error('CDP 已关闭'))
    }
    const id = this.nextId++
    const payload: Record<string, unknown> = { id, method, params: params ?? {} }
    if (sessionId) {
      payload.sessionId = sessionId
    }
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.ws.send(JSON.stringify(payload), (err) => {
        if (err) {
          this.pending.delete(id)
          reject(err)
        }
      })
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id)
          reject(new Error(`CDP 超时: ${method}`))
        }
      }, 20_000)
    })
  }

  close(): void {
    this.closed = true
    try {
      this.ws.close()
    } catch {
      /* ignore */
    }
  }

  private onMessage(raw: string): void {
    let msg: {
      id?: number
      method?: string
      params?: Record<string, unknown>
      result?: unknown
      error?: { message: string }
      sessionId?: string
    }
    try {
      msg = JSON.parse(raw) as typeof msg
    } catch {
      return
    }
    if (msg.method) {
      const handlers = this.eventHandlers.get(msg.method) ?? []
      for (const h of handlers) {
        try {
          h(msg.params ?? {}, msg.sessionId)
        } catch {
          /* ignore */
        }
      }
      return
    }
    if (msg.id == null) {
      return
    }
    const p = this.pending.get(msg.id)
    if (!p) {
      return
    }
    this.pending.delete(msg.id)
    if (msg.error) {
      p.reject(new Error(msg.error.message))
    } else {
      p.resolve(msg.result)
    }
  }
}

class AutofillSession {
  private conn: CdpConnection | null = null
  private readonly attachedSessions = new Set<string>()
  private readonly retryTimers = new Map<string, ReturnType<typeof setTimeout>[]>()
  private disconnectTimer: ReturnType<typeof setTimeout> | null = null
  private autofillExpired = false
  private expiredLogged = false
  private stopped = false

  isActive(): boolean {
    return !this.stopped && !this.autofillExpired && this.conn !== null
  }

  constructor(
    private readonly profileId: string,
    private readonly debugPort: number,
  ) {}

  async start(): Promise<void> {
    if (this.stopped) {
      return
    }
    const wsUrl = await this.resolveBrowserWsUrl()
    this.conn = new CdpConnection(wsUrl)
    await this.conn.waitOpen()
    await this.conn.send('Target.setAutoAttach', {
      autoAttach: true,
      waitForDebuggerOnStart: false,
      flatten: true,
    })
    this.conn.on('Target.attachedToTarget', (params) => {
      void this.onTargetAttached(params)
    })
    await this.attachExistingTargets()
    this.scheduleAutoDisconnectTabHooks()
    console.info(
      '[autofill] 已附着',
      this.profileId,
      'port',
      this.debugPort,
      `Tab监听器${AUTOFILL_TAB_HOOK_TTL_MS / 1000}s后自动移除`,
    )
  }

  private scheduleAutoDisconnectTabHooks(): void {
    if (this.disconnectTimer) {
      clearTimeout(this.disconnectTimer)
    }
    this.disconnectTimer = setTimeout(() => {
      this.disconnectTimer = null
      console.info(
        '[autofill] 填充窗口到期',
        this.profileId,
        '运行',
        AUTOFILL_TAB_HOOK_TTL_MS / 1000,
        '秒，开始清理',
      )
      this.expireAutofillSession('timeout')
    }, AUTOFILL_TAB_HOOK_TTL_MS)
  }

  private expireAutofillSession(reason: string): void {
    if (this.autofillExpired) {
      return
    }
    this.autofillExpired = true
    for (const sessionId of this.retryTimers.keys()) {
      this.clearRetries(sessionId)
    }
    void this.shutdownAutofillCdp(reason)
  }

  private async shutdownAutofillCdp(reason: string): Promise<void> {
    const conn = this.conn
    if (!conn) {
      return
    }
    await this.disconnectTabHooksOnAllPages(reason)
    try {
      await conn.send('Target.setAutoAttach', {
        autoAttach: false,
        waitForDebuggerOnStart: false,
        flatten: true,
      })
    } catch {
      /* CDP target may already be gone. */
    }
    const sessions = Array.from(this.attachedSessions)
    let detached = 0
    for (const sessionId of sessions) {
      try {
        await conn.send('Target.detachFromTarget', { sessionId })
        detached++
      } catch {
        /* Session may already be detached or closed. */
      }
    }
    this.attachedSessions.clear()
    conn.close()
    if (this.conn === conn) {
      this.conn = null
    }
    console.info(
      '[autofill] CDP已断开',
      this.profileId,
      'reason=',
      reason,
      'detached=',
      detached,
    )
  }

  private async disconnectTabHooksOnAllPages(reason: string): Promise<void> {
    const conn = this.conn
    if (!conn) {
      console.info('[autofill] 自动填充窗口已结束', this.profileId, 'reason=', reason, '(CDP已关闭)')
      return
    }
    const markExpr = buildMarkAutofillExpiredExpression()
    const expr = buildDisconnectTabHooksExpression()
    let scanned = 0
    let removed = 0
    for (const sessionId of this.attachedSessions) {
      scanned++
      try {
        await conn.send('Runtime.evaluate', { expression: markExpr, returnByValue: true }, sessionId)
        const result = await conn.send(
          'Runtime.evaluate',
          { expression: expr, returnByValue: true },
          sessionId,
        )
        const disconnected = (result as { result?: { value?: { disconnected?: boolean } } })?.result
          ?.value?.disconnected
        if (disconnected) {
          removed++
        }
      } catch {
        /* 标签可能已关闭 */
      }
    }
    console.info(
      '[autofill] 自动填充窗口已结束',
      this.profileId,
      'reason=',
      reason,
      '扫描标签=',
      scanned,
      '移除Tab监听=',
      removed,
      '后续不再自动填充',
    )
  }

  private async attachExistingTargets(): Promise<void> {
    const conn = this.conn
    if (!conn || this.stopped || this.autofillExpired) {
      return
    }
    try {
      const raw = await conn.send('Target.getTargets')
      const targets = ((raw as { targetInfos?: Array<{ targetId?: string; type?: string }> })
        ?.targetInfos ?? []) as Array<{ targetId?: string; type?: string }>
      for (const target of targets) {
        const type = String(target.type ?? '')
        if (type !== 'page' && type !== 'iframe') {
          continue
        }
        const targetId = String(target.targetId ?? '')
        if (!targetId) {
          continue
        }
        try {
          const attached = (await conn.send('Target.attachToTarget', {
            targetId,
            flatten: true,
          })) as { sessionId?: string }
          const sessionId = String(attached.sessionId ?? '')
          if (sessionId) {
            await this.setupPageSession(sessionId, type)
          }
        } catch {
          /* 可能已被 autoAttach 附着 */
        }
      }
    } catch (e) {
      console.warn('[autofill] 扫描已有标签失败', e instanceof Error ? e.message : e)
    }
  }

  private isAutofillTargetType(type: string): boolean {
    return type === 'page' || type === 'iframe'
  }

  private async setupPageSession(sessionId: string, targetType: string): Promise<void> {
    if (!sessionId || this.attachedSessions.has(sessionId) || this.autofillExpired) {
      return
    }
    this.attachedSessions.add(sessionId)
    const conn = this.conn
    if (!conn || this.stopped || this.autofillExpired) {
      return
    }
    try {
      await conn.send('Page.enable', {}, sessionId)
      conn.on('Page.loadEventFired', (_p, sid) => {
        if (sid === sessionId) {
          void this.tryAutofillPage(sessionId)
        }
      })
      conn.on('Page.frameNavigated', (p, sid) => {
        if (sid !== sessionId) {
          return
        }
        const frame = (p.frame ?? {}) as { parentId?: string }
        if (!frame.parentId || targetType === 'iframe') {
          void this.tryAutofillPage(sessionId)
        }
      })
      void this.scheduleAutofillRetries(sessionId)
    } catch (e) {
      console.warn('[autofill] Page.enable 失败', e instanceof Error ? e.message : e)
    }
  }

  stop(): void {
    this.stopped = true
    this.autofillExpired = true
    if (this.disconnectTimer) {
      clearTimeout(this.disconnectTimer)
      this.disconnectTimer = null
    }
    for (const sessionId of this.retryTimers.keys()) {
      this.clearRetries(sessionId)
    }
    void this.shutdownAutofillCdp('stop')
    this.retryTimers.clear()
  }

  private async resolveBrowserWsUrl(): Promise<string> {
    const r = await fetch(`http://127.0.0.1:${this.debugPort}/json/version`)
    if (!r.ok) {
      throw new Error(`调试端口不可用: ${this.debugPort}`)
    }
    const v = (await r.json()) as { webSocketDebuggerUrl?: string }
    const ws = String(v.webSocketDebuggerUrl ?? '').trim()
    if (!ws) {
      throw new Error('未找到 browser WebSocket')
    }
    return ws
  }

  private async onTargetAttached(params: Record<string, unknown>): Promise<void> {
    if (this.stopped || this.autofillExpired) {
      return
    }
    const sessionId = String(params.sessionId ?? '')
    const targetInfo = (params.targetInfo ?? {}) as { type?: string; url?: string }
    const targetType = String(targetInfo.type ?? '')
    if (!sessionId || !this.isAutofillTargetType(targetType)) {
      return
    }
    await this.setupPageSession(sessionId, targetType)
  }

  private scheduleAutofillRetries(sessionId: string): void {
    if (this.autofillExpired) {
      return
    }
    const delays = [300, 800, 1500, 3000, 5000, 8000, 12000]
    const timers: ReturnType<typeof setTimeout>[] = []
    for (const ms of delays) {
      timers.push(
        setTimeout(() => {
          if (!this.stopped && !this.autofillExpired) {
            void this.tryAutofillPage(sessionId)
          }
        }, ms),
      )
    }
    this.retryTimers.set(sessionId, timers)
  }

  private clearRetries(sessionId: string): void {
    const timers = this.retryTimers.get(sessionId)
    if (!timers) {
      return
    }
    for (const t of timers) {
      clearTimeout(t)
    }
    this.retryTimers.delete(sessionId)
  }

  private async tryAutofillPage(sessionId: string): Promise<void> {
    if (this.autofillExpired) {
      if (!this.expiredLogged) {
        this.expiredLogged = true
        console.info('[autofill] 填充已停止', this.profileId, '(窗口已结束，忽略后续页面事件)')
      }
      return
    }
    const conn = this.conn
    const db = getSqlite()
    if (!conn || !db || this.stopped) {
      return
    }
    let pageInfo: { host?: string; href?: string; hasPassword?: boolean }
    try {
      const raw = await conn.send(
        'Runtime.evaluate',
        {
          expression: `(() => {
            function hasPasswordInput(doc) {
              if (!doc) return false;
              const fields = doc.querySelectorAll(
                'input[type=password], input[name=password], #TikTok_Ads_SSO_Login_Pwd_Input, .tiktokads-common-login-form-password',
              );
              for (const el of fields) {
                if (el.disabled) continue;
                const style = doc.defaultView?.getComputedStyle(el);
                if (!style || style.display === 'none' || style.visibility === 'hidden') continue;
                const rect = el.getBoundingClientRect();
                if (rect.width > 0 && rect.height > 0) return true;
              }
              return fields.length > 0;
            }
            let hasPassword = hasPasswordInput(document);
            if (!hasPassword) {
              for (const iframe of document.querySelectorAll('iframe')) {
                try {
                  if (hasPasswordInput(iframe.contentDocument)) {
                    hasPassword = true;
                    break;
                  }
                } catch {
                  hasPassword = true;
                  break;
                }
              }
            }
            return { host: location.hostname, href: location.href, hasPassword };
          })()`,
          returnByValue: true,
        },
        sessionId,
      )
      pageInfo = ((raw as { result?: { value?: typeof pageInfo } })?.result?.value ??
        {}) as typeof pageInfo
    } catch {
      return
    }
    if (!pageInfo.hasPassword || !pageInfo.host) {
      return
    }
    const match = matchProfileCredentialForPage(
      db,
      this.profileId,
      pageInfo.host,
      String(pageInfo.href ?? ''),
    )
    if (!match) {
      const configured = listEnabledCredentialSiteHosts(db, this.profileId)
      console.info(
        '[autofill] 未匹配凭据',
        this.profileId,
        'pageHost=',
        pageInfo.host,
        'configured=',
        configured.length > 0 ? configured.join(' | ') : '(无)',
        'hint=域名需匹配当前页，如 tiktokshopglobalselling.com',
      )
      return
    }
    const expr = buildFillExpression(
      match.username,
      match.password,
      match.usernameSelector,
      match.passwordSelector,
      match.autoSubmit,
    )
    try {
      const result = await conn.send(
        'Runtime.evaluate',
        { expression: expr, returnByValue: true },
        sessionId,
      )
      const value = (result as {
        result?: {
          value?: { ok?: boolean; reason?: string; tabHooksInstalled?: boolean; usersFilled?: number }
        }
      })?.result?.value
      if (value?.ok) {
        if (value.tabHooksInstalled) {
          this.clearRetries(sessionId)
        }
        console.info(
          '[autofill] 已填充',
          this.profileId,
          pageInfo.host,
          'users=',
          value.usersFilled ?? 0,
          value.tabHooksInstalled ? 'tabHook=已安装' : 'tabHook=未安装',
        )
      } else if (value?.reason) {
        console.info('[autofill] 跳过', this.profileId, pageInfo.host, value.reason)
      }
    } catch (e) {
      console.warn('[autofill] 填充失败', e instanceof Error ? e.message : e)
    }
  }
}

export function startProfileAutofill(profileId: string, debugPort: number): void {
  const key = sessionKey(profileId, debugPort)
  const existing = sessions.get(key)
  if (existing?.isActive()) {
    return
  }
  stopProfileAutofill(profileId, debugPort)
  const session = new AutofillSession(profileId, debugPort)
  sessions.set(key, session)
  void session.start().catch((e) => {
    console.warn('[autofill] 启动失败', profileId, e instanceof Error ? e.message : e)
    sessions.delete(key)
  })
}

export function stopProfileAutofill(profileId: string, debugPort?: number): void {
  if (debugPort != null && debugPort > 0) {
    const key = sessionKey(profileId, debugPort)
    sessions.get(key)?.stop()
    sessions.delete(key)
    return
  }
  const prefix = `${profileId.trim()}:`
  for (const [key, session] of sessions.entries()) {
    if (key.startsWith(prefix)) {
      session.stop()
      sessions.delete(key)
    }
  }
}

export function stopAllAutofillSessions(): void {
  for (const session of sessions.values()) {
    session.stop()
  }
  sessions.clear()
}
