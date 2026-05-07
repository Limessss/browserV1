import { Coffee } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Badge, Card } from '../../shared/components'
import { createDefaultProfilePageData, loadProfilePageData } from './api'
import type { ProfilePageData } from './types'

export function ProfilePage() {
  const navigate = useNavigate()
  const [clickCount, setClickCount] = useState(0)
  const [pageData, setPageData] = useState<ProfilePageData>(() => createDefaultProfilePageData())

  useEffect(() => {
    let active = true

    const syncProfile = async () => {
      const data = await loadProfilePageData()
      if (!active) return
      setPageData(data)
    }

    void syncProfile()

    return () => {
      active = false
    }
  }, [])

  const handleProjectTitleClick = () => {
    const newCount = clickCount + 1
    setClickCount(newCount)
    if (newCount >= 5) {
      navigate('/admin/keygen')
      setClickCount(0)
    }
  }

  const projectInfo = pageData.project

  return (
    <div className="mx-auto max-w-5xl space-y-6 animate-fade-in">
      <Card padding="lg" className="rounded-[26px]">
        <div className="flex flex-col gap-6">
          <div className="space-y-1">
            <h1
              className="cursor-pointer select-none text-[34px] font-bold leading-none tracking-tight text-[var(--color-text-primary)] sm:text-[38px]"
              onClick={handleProjectTitleClick}
              title={clickCount > 0 ? `再点 ${5 - clickCount} 次进入开发者模式` : ''}
            >
              {projectInfo.name}
            </h1>
            <p className="text-base text-[var(--color-text-muted)]">关于本项目</p>
          </div>

          <div className="space-y-4 text-[15px] leading-8 text-[var(--color-text-secondary)]">
            <p>
              <Badge className="mr-1 rounded-xl px-3 py-1">{projectInfo.introBadge}</Badge>
              {projectInfo.introText}
            </p>
          </div>
        </div>
      </Card>

      <Card
        title="说明"
        actions={<Coffee className="h-4 w-4 text-[var(--color-text-muted)]" />}
        className="rounded-[24px]"
        padding="lg"
      >
        <div className="space-y-4 text-[15px] leading-8 text-[var(--color-text-secondary)]">
          <div className="flex flex-wrap gap-2">
            {projectInfo.techStack.map((item) => (
              <Badge key={item} className="rounded-xl px-3 py-1">
                {item}
              </Badge>
            ))}
          </div>
          <p>{projectInfo.description}</p>
        </div>
      </Card>
    </div>
  )
}
