import { projectConfig } from './project.config'

/** 关于本项目（唯一配置入口） */
export interface ProjectProfileConfig {
  name: string
  introBadge: string
  introText: string
  techStack: string[]
  description: string
}

export const profilePageConfig: ProjectProfileConfig = {
  name: projectConfig.name,
  introBadge: projectConfig.name,
  introText: '是一个面向多账号隔离、代理绑定和本地环境管理的桌面浏览器工具。',
  techStack: ['Wails', 'React', 'TypeScript'],
  description:
    '项目聚焦浏览器实例隔离、代理池配置、浏览器内核管理、标签检索和快捷启动等能力，适用于跨境电商、社媒运营、本地测试及需要统一管理浏览器环境的场景。',
}

export default profilePageConfig
