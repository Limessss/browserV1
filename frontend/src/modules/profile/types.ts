import type { ProjectProfileConfig } from '../../config/profile.config'

export type ProfileProject = ProjectProfileConfig

export interface ProfileLoadMeta {
  source: 'default'
  message?: string
}

export interface ProfilePageData {
  project: ProfileProject
  meta: ProfileLoadMeta
}
