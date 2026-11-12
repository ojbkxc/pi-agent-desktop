import { DefaultResourceLoader, getAgentDir } from "@earendil-works/pi-coding-agent";
import type { SkillInfo, SkillsResponse } from "@/lib/api-types";
import { annotateSkillsWithInstallInfo } from "@/lib/skill-lock";
import { getProjectTrustStatus, projectTrustReloadOptions } from "@/lib/project-trust";
import { additionalForkSkillPaths } from "@/lib/fork-skill-paths";
import { isBuiltinSkillPath } from "@/lib/builtin-skills";

export async function loadSkillsWithInstallInfo(cwd: string): Promise<SkillsResponse> {
  const agentDir = getAgentDir();
  // 面板与运行时会话加载同一批技能：额外接上 cc-haha 的用户级技能根与随应用打包的内置技能根
  // （面板从不关技能，故传 true），否则面板里看得到的技能与普通会话能用的技能会对不上。
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir,
    additionalSkillPaths: additionalForkSkillPaths(true),
  });
  await loader.reload(projectTrustReloadOptions(cwd, agentDir));
  const { skills, diagnostics } = loader.getSkills();
  return {
    // 内置技能来自应用资源目录（只读、升级会重建）：标成 builtin，面板据此显示「内置」标签并
    // 置灰 disable-model-invocation 开关（放行写入只会得到 403 或一个升级后失效的开关）。
    skills: annotateSkillsWithInstallInfo(
      (skills as SkillInfo[]).map((skill) =>
        isBuiltinSkillPath(skill.filePath)
          ? { ...skill, builtin: true, sourceInfo: { source: "builtin", scope: "builtin" } }
          : skill,
      ),
      { cwd, agentDir },
    ),
    diagnostics,
    projectResourcesLoaded: getProjectTrustStatus(cwd, agentDir).trusted,
  };
}
