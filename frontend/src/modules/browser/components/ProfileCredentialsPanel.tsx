import { useCallback, useEffect, useState } from 'react'
import { Plus, Trash2 } from 'lucide-react'
import { Button, ConfirmModal, FormItem, Input, toast } from '../../../shared/components'
import type { ProfileCredential, ProfileCredentialInput } from '../types'
import {
  deleteProfileCredential,
  fetchProfileCredentials,
  saveProfileCredential,
} from '../api'

type Props = {
  profileId: string
}

const emptyForm = (): ProfileCredentialInput => ({
  label: '',
  siteHost: '',
  urlPattern: '',
  username: '',
  password: '',
  usernameSelector: '',
  passwordSelector: '',
  autoSubmit: false,
  enabled: true,
})

export function ProfileCredentialsPanel({ profileId }: Props) {
  const [items, setItems] = useState<ProfileCredential[]>([])
  const [loading, setLoading] = useState(true)
  const [editing, setEditing] = useState<ProfileCredentialInput | null>(null)
  const [deleteId, setDeleteId] = useState('')
  const [saving, setSaving] = useState(false)

  const reload = useCallback(async () => {
    setLoading(true)
    try {
      const list = await fetchProfileCredentials(profileId)
      setItems(list)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '加载凭据失败')
    } finally {
      setLoading(false)
    }
  }, [profileId])

  useEffect(() => {
    void reload()
  }, [reload])

  const startAdd = () => {
    setEditing(emptyForm())
  }

  const startEdit = (item: ProfileCredential) => {
    setEditing({
      credentialId: item.credentialId,
      label: item.label,
      siteHost: item.siteHost,
      urlPattern: item.urlPattern,
      username: item.username,
      password: '',
      usernameSelector: item.usernameSelector,
      passwordSelector: item.passwordSelector,
      autoSubmit: item.autoSubmit,
      enabled: item.enabled,
    })
  }

  const handleSave = async () => {
    if (!editing) return
    if (!editing.siteHost.trim() || !editing.username.trim()) {
      toast.error('请填写网站域名和账号')
      return
    }
    if (!editing.credentialId && !editing.password?.trim()) {
      toast.error('请填写密码')
      return
    }
    setSaving(true)
    try {
      await saveProfileCredential(profileId, editing)
      toast.success('已保存')
      setEditing(null)
      await reload()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '保存失败')
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async () => {
    if (!deleteId) return
    try {
      await deleteProfileCredential(profileId, deleteId)
      toast.success('已删除')
      setDeleteId('')
      await reload()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '删除失败')
    }
  }

  return (
    <div className="space-y-4">
      <p className="text-xs text-[var(--color-text-muted)]">
        实例启动后，访问匹配域名的登录页（含密码输入框）时将自动填充。账号含
        <code className="mx-1">@</code> 时填邮箱框，纯数字时填手机号框（含隐藏字段，切换
        Tab 后仍保留）。Tab 切换监听在实例启动约 1 分钟后自动移除。域名填当前登录页的根域，多个用逗号分隔。示例：
        <code className="mx-1">tiktokshopglobalselling.com</code>（匹配 seller.tiktokshopglobalselling.com）或
        <code className="mx-1">tiktok.com, tiktokshopglobalselling.com</code>
      </p>

      {loading ? (
        <p className="text-sm text-[var(--color-text-muted)]">加载中…</p>
      ) : items.length === 0 ? (
        <p className="text-sm text-[var(--color-text-muted)]">尚未配置网站账号</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-[var(--color-text-muted)] border-b border-[var(--color-border)]">
                <th className="py-2 pr-3">备注</th>
                <th className="py-2 pr-3">网站</th>
                <th className="py-2 pr-3">账号</th>
                <th className="py-2 pr-3">状态</th>
                <th className="py-2">操作</th>
              </tr>
            </thead>
            <tbody>
              {items.map(item => (
                <tr key={item.credentialId} className="border-b border-[var(--color-border)]/60">
                  <td className="py-2 pr-3">{item.label || '—'}</td>
                  <td className="py-2 pr-3">
                    <code className="text-xs">{item.siteHost}</code>
                    {item.urlPattern ? (
                      <span className="block text-xs text-[var(--color-text-muted)]">{item.urlPattern}</span>
                    ) : null}
                  </td>
                  <td className="py-2 pr-3">{item.username}</td>
                  <td className="py-2 pr-3">{item.enabled ? '启用' : '禁用'}</td>
                  <td className="py-2 whitespace-nowrap">
                    <Button variant="ghost" size="sm" onClick={() => startEdit(item)}>
                      编辑
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => setDeleteId(item.credentialId)}>
                      <Trash2 className="w-4 h-4 text-red-500" />
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Button variant="secondary" size="sm" onClick={startAdd}>
        <Plus className="w-4 h-4 mr-1" />
        添加网站账号
      </Button>

      {editing ? (
        <div className="rounded-lg border border-[var(--color-border)] p-4 space-y-3 bg-[var(--color-bg-secondary)]">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <FormItem label="备注（可选）">
              <Input
                value={editing.label ?? ''}
                onChange={e => setEditing({ ...editing, label: e.target.value })}
                placeholder="TikTok 卖家中心"
              />
            </FormItem>
            <FormItem label="网站域名 *">
              <Input
                value={editing.siteHost}
                onChange={e => setEditing({ ...editing, siteHost: e.target.value })}
                placeholder="tiktokshopglobalselling.com"
              />
            </FormItem>
            <FormItem label="URL 路径匹配（可选）">
              <Input
                value={editing.urlPattern ?? ''}
                onChange={e => setEditing({ ...editing, urlPattern: e.target.value })}
                placeholder="/login 或 */account/*"
              />
            </FormItem>
            <FormItem label="账号 *">
              <Input
                value={editing.username}
                onChange={e => setEditing({ ...editing, username: e.target.value })}
                placeholder="user@example.com"
              />
            </FormItem>
            <FormItem label={editing.credentialId ? '密码（留空则不修改）' : '密码 *'}>
              <Input
                type="password"
                value={editing.password ?? ''}
                onChange={e => setEditing({ ...editing, password: e.target.value })}
                placeholder="••••••••"
              />
            </FormItem>
            <FormItem label="用户名 CSS 选择器（可选）">
              <Input
                value={editing.usernameSelector ?? ''}
                onChange={e => setEditing({ ...editing, usernameSelector: e.target.value })}
                placeholder="#TikTok_Ads_SSO_Login_Email_Input"
              />
            </FormItem>
            <FormItem label="密码 CSS 选择器（可选）">
              <Input
                value={editing.passwordSelector ?? ''}
                onChange={e => setEditing({ ...editing, passwordSelector: e.target.value })}
                placeholder="#TikTok_Ads_SSO_Login_Pwd_Input"
              />
            </FormItem>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={Boolean(editing.autoSubmit)}
              onChange={e => setEditing({ ...editing, autoSubmit: e.target.checked })}
            />
            填充后自动点击登录（默认关闭，遇验证码时建议关闭）
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={editing.enabled !== false}
              onChange={e => setEditing({ ...editing, enabled: e.target.checked })}
            />
            启用此条凭据
          </label>
          <div className="flex gap-2">
            <Button onClick={() => void handleSave()} disabled={saving}>
              {saving ? '保存中…' : '保存'}
            </Button>
            <Button variant="secondary" onClick={() => setEditing(null)}>
              取消
            </Button>
          </div>
        </div>
      ) : null}

      <ConfirmModal
        open={Boolean(deleteId)}
        title="删除网站账号"
        content="确定删除这条凭据？"
        onConfirm={() => void handleDelete()}
        onClose={() => setDeleteId('')}
      />
    </div>
  )
}
