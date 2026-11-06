import { DefaultResourceLoader, getAgentDir } from "@earendil-works/pi-coding-agent";
import type { SkillInfo, SkillsResponse } from "@/lib/api-types";
import { annotateSkillsWithInstallInfo } from "@/lib/skill-lock";
import { getProjectTrustStatus, projectTrustReloadOptions } from "@/lib/project-trust";
import { additionalCcHahaSkillPaths } from "@/lib/cc-haha-skills";

export async function loadSkillsWithInstallInfo(cwd: string): Promise<SkillsResponse> {
  const agentDir = getAgentDir();
  // 面板与运行时会话加载同一批技能：额外接上 cc-haha 的用户级技能根（面板从不关技能，
  // 故传 true），否则面板里看得到的技能与普通会话能用的技能会对不上。
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir,
    additionalSkillPaths: additionalCcHahaSkillPaths(true),
  });
  await loader.reload(projectTrustReloadOptions(cwd, agentDir));
  const { skills, diagnostics } = loader.getSkills();
  return {
    skills: annotateSkillsWithInstallInfo(skills as SkillInfo[], { cwd, agentDir }),
    diagnostics,
    projectResourcesLoaded: getProjectTrustStatus(cwd, agentDir).trusted,
  };
}
