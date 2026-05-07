import profilePageConfig from '../../config/profile.config'
import type { ProfilePageData, ProfileProject } from './types'

export function createDefaultProfilePageData(): ProfilePageData {
  return {
    project: cloneProject(profilePageConfig),
    meta: {
      source: 'default',
    },
  }
}

export async function loadProfilePageData(): Promise<ProfilePageData> {
  return createDefaultProfilePageData()
}

function cloneProject(project: ProfileProject): ProfileProject {
  return {
    ...project,
    techStack: [...project.techStack],
  }
}
